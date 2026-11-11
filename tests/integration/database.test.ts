import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";
import type { Request, Response } from "express";

// Explicit opt-in only; NEVER fall back to the app's DATABASE_URL. Each run
// owns a random schema and applies the real migrations there. Nothing in the
// application's public schema is written, truncated, seeded or dropped.
const connectionString = process.env.ENJOYER_TEST_DATABASE_URL;
test(
  "PostgreSQL integration in an isolated schema",
  { skip: !connectionString, timeout: 120_000 },
  async (t) => {
    assert.ok(
      !new URL(connectionString!).hostname.includes("-pooler."),
      "Use a direct PostgreSQL connection for ENJOYER_TEST_DATABASE_URL; session search_path must stay isolated",
    );
    const schemaName = `enjoyer_test_${randomBytes(12).toString("hex")}`;
    assert.match(schemaName, /^enjoyer_test_[a-f0-9]{24}$/);
    const admin = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    const pool = new Pool({
      connectionString,
      max: 6,
      connectionTimeoutMillis: 5000,
      options: `-c search_path=${schemaName} -c statement_timeout=15000`,
    });
    let created = false;
    t.after(async () => {
      await pool.end();
      try {
        // Only the schema created successfully by this run can be removed.
        if (created) await admin.query(`drop schema "${schemaName}" cascade`);
      } finally {
        await admin.end();
      }
    });
    await admin.query(`create schema "${schemaName}"`);
    created = true;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const journal = JSON.parse(
        await readFile(
          new URL("../../drizzle/meta/_journal.json", import.meta.url),
          "utf8",
        ),
      ) as { entries: { tag: string }[] };
      for (const entry of journal.entries) {
        assert.match(entry.tag, /^\d{4}_[a-z0-9_]+$/);
        const migration = await readFile(
          new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url),
          "utf8",
        );
        // Generated migrations explicitly qualify enum/FK references as public.
        // Point those references into the isolated schema as well.
        await client.query(
          migration.replaceAll('"public".', `"${schemaName}".`),
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    const db = drizzle(pool);
    mock.module("../../src/db/index.ts", { namedExports: { db, pool } });
    mock.module("../../src/configs/env.ts", {
      namedExports: {
        env: {
          NODE_ENV: "test",
          ACCESS_TOKEN_SECRET: "isolated-test-secret-never-for-real-tokens",
          COOKIE_SAMESITE: "lax",
          CLIENT_URL: "https://order.example.test",
        },
      },
    });
    mock.module("../../src/lib/logger.ts", {
      namedExports: {
        securityLog() {},
        logger: { error() {} },
        serializeError: () => ({}),
      },
    });
    mock.module("../../src/lib/pwned.ts", {
      namedExports: {
        isPwnedPassword: async () => false,
        pwnedPasswordResponse: () => ({}),
      },
    });
    mock.module("../../src/services/email.ts", {
      namedExports: {
        queueEmail() {},
        sendPasswordChangedEmail: async () => {},
        sendPasswordResetEmail: async () => {},
        sendInviteEmail: async () => {},
      },
    });
    const {
      users,
      sessions,
      categories,
      menuItems,
      menuOptionGroups,
      menuItemOptionGroups,
      shopTables,
    } = await import("../../src/db/schema.ts");
    const { createSession, rotateSession, revokeSessionFamily } =
      await import("../../src/lib/sessions.ts");
    const { newToken, sha256 } = await import("../../src/lib/tokens.ts");
    const { handleDeactivateAccount } =
      await import("../../src/controllers/accounts/deactivateAccount.ts");
    const { resetPassword } =
      await import("../../src/controllers/auth/password.ts");
    const { assignOptionGroups } =
      await import("../../src/controllers/menuItems/options.ts");
    const { createTable, updateTable } =
      await import("../../src/controllers/tables/admin.ts");
    const { resolveTable } =
      await import("../../src/controllers/tables/public.ts");
    const passwordHash = await bcrypt.hash("Integration test password 123!", 4);
    let identity = 0;
    async function user(role: "owner" | "staff" = "staff") {
      const [row] = await db
        .insert(users)
        .values({
          name: "Integration test",
          email: `test-${++identity}@example.test`,
          role,
          password: passwordHash,
        })
        .returning();
      return row;
    }
    function response() {
      const result = { status: 200, body: undefined as any };
      const res = {
        status(code: number) {
          result.status = code;
          return this;
        },
        json(body: unknown) {
          result.body = body;
          return this;
        },
        clearCookie() {
          return this;
        },
      } as unknown as Response;
      return { result, res };
    }
    const fingerprint = { ip: "192.0.2.1", userAgent: "IntegrationBrowser" };

    await t.test(
      "simultaneous refreshes after a network change keep both successors usable",
      async () => {
        const account = await user();
        const start = await createSession(
          account.id,
          passwordHash,
          fingerprint,
        );
        assert.ok(start);
        const moved = { ...fingerprint, ip: "192.0.2.2" };
        const results = await Promise.all([
          rotateSession(start.token, moved),
          rotateSession(start.token, moved),
        ]);
        assert.ok(results.every((r) => r.ok));
        const rows = await db
          .select()
          .from(sessions)
          .where(eq(sessions.userId, account.id));
        assert.equal(rows.length, 3);
        assert.ok(rows.every((row) => row.revokedAt === null));
        const consumed = rows.find(
          (row) => row.tokenHash === sha256(start.token),
        )!;
        assert.equal(consumed.ip, moved.ip);
        assert.ok(consumed.usedAt);
        const replay = await rotateSession(start.token, fingerprint);
        assert.ok(
          !replay.ok && replay.reason === "reuse" && replay.cause === "grace",
        );
        assert.ok(
          (
            await db
              .select()
              .from(sessions)
              .where(eq(sessions.userId, account.id))
          ).every((row) => row.revokedAt),
        );
      },
    );

    await t.test(
      "simultaneous Owners cannot deactivate each other and leave no Owner",
      async () => {
        const first = await user("owner"),
          second = await user("owner");
        const a = response(),
          b = response();
        await Promise.all([
          handleDeactivateAccount(
            {
              params: { id: String(second.id) },
              user: { id: first.id, role: "owner" },
            } as unknown as Request,
            a.res,
          ),
          handleDeactivateAccount(
            {
              params: { id: String(first.id) },
              user: { id: second.id, role: "owner" },
            } as unknown as Request,
            b.res,
          ),
        ]);
        assert.deepEqual([a.result.status, b.result.status].sort(), [200, 403]);
        const owners = await db
          .select()
          .from(users)
          .where(eq(users.role, "owner"));
        assert.equal(owners.filter((row) => row.active).length, 1);
      },
    );

    await t.test(
      "a reset token is consumed only once under simultaneous submissions",
      async () => {
        const account = await user();
        const token = newToken();
        await db
          .update(users)
          .set({
            resetPasswordTokenHash: sha256(token),
            resetPasswordExpiresAt: new Date(Date.now() + 60_000),
          })
          .where(eq(users.id, account.id));
        await createSession(account.id, passwordHash, fingerprint);
        const a = response(),
          b = response();
        const req = {
          body: { token, newPwd: "Changed integration password 456!" },
        } as Request;
        await Promise.all([
          resetPassword(req, a.res),
          resetPassword(req, b.res),
        ]);
        assert.deepEqual([a.result.status, b.result.status].sort(), [200, 400]);
        const [changed] = await db
          .select()
          .from(users)
          .where(eq(users.id, account.id));
        assert.equal(changed.resetPasswordTokenHash, null);
        assert.ok(await bcrypt.compare(req.body.newPwd, changed.password!));
        assert.ok(
          (
            await db
              .select()
              .from(sessions)
              .where(eq(sessions.userId, account.id))
          ).every((row) => row.revokedAt),
        );
      },
    );

    await t.test(
      "refresh racing logout cannot leave a valid successor",
      async () => {
        const account = await user();
        const start = await createSession(
          account.id,
          passwordHash,
          fingerprint,
        );
        assert.ok(start);
        await Promise.all([
          rotateSession(start.token, fingerprint),
          revokeSessionFamily(start.token),
        ]);
        const rows = await db
          .select()
          .from(sessions)
          .where(eq(sessions.userId, account.id));
        assert.ok(rows.length > 0 && rows.every((row) => row.revokedAt));
      },
    );

    await t.test(
      "concurrent option replacements produce one complete assignment",
      async () => {
        const [category] = await db
          .insert(categories)
          .values({ name: "Test category" })
          .returning();
        const [item] = await db
          .insert(menuItems)
          .values({ categoryId: category.id, name: "Test item", price: "1.00" })
          .returning();
        const groups = await db
          .insert(menuOptionGroups)
          .values([{ name: "A" }, { name: "B" }, { name: "C" }])
          .returning();
        const choices = [[groups[0].id, groups[1].id], [groups[2].id]];
        const a = response(),
          b = response();
        await Promise.all(
          choices.map((groupIds, i) =>
            assignOptionGroups(
              {
                params: { id: String(item.id) },
                body: { groupIds },
              } as unknown as Request,
              [a.res, b.res][i],
            ),
          ),
        );
        assert.deepEqual([a.result.status, b.result.status], [200, 200]);
        const links = await db
          .select()
          .from(menuItemOptionGroups)
          .where(eq(menuItemOptionGroups.menuItemId, item.id));
        const actual = links
          .map((link) => link.optionGroupId)
          .sort((a, b) => a - b);
        assert.ok(
          choices.some((ids) => JSON.stringify(ids) === JSON.stringify(actual)),
        );
        const invalid = response();
        await assignOptionGroups(
          {
            params: { id: String(item.id) },
            body: { groupIds: [2147483647] },
          } as unknown as Request,
          invalid.res,
        );
        assert.equal(invalid.result.status, 400);
        assert.deepEqual(
          (
            await db
              .select()
              .from(menuItemOptionGroups)
              .where(eq(menuItemOptionGroups.menuItemId, item.id))
          )
            .map((row) => row.optionGroupId)
            .sort((a, b) => a - b),
          actual,
        );
      },
    );

    await t.test(
      "table creation, rename, deactivation and reactivation retain the QR identity",
      async () => {
        const createdTable = response();
        await createTable(
          {
            body: { name: "Test table", orderLimit: 5, active: true },
          } as Request,
          createdTable.res,
        );
        assert.equal(createdTable.result.status, 201);
        const { id, qrToken } = createdTable.result.body.data;
        assert.match(qrToken, /^[A-Za-z0-9_-]{43}$/);
        const [stored] = await db
          .select()
          .from(shopTables)
          .where(eq(shopTables.id, id));
        assert.equal(stored.orderLimit, 5);
        for (const active of [true, false, true]) {
          const edit = response();
          await updateTable(
            {
              params: { id: String(id) },
              body: { name: "Renamed", orderLimit: 7, active },
            } as unknown as Request,
            edit.res,
          );
          assert.equal(edit.result.body.data.qrToken, qrToken);
          const scan = response();
          await resolveTable({ body: { token: qrToken } } as Request, scan.res);
          assert.equal(scan.result.status, active ? 200 : 404);
          if (active)
            assert.deepEqual(scan.result.body.data, {
              id,
              name: "Renamed",
              orderLimit: 7,
            });
        }
        // Test a real DB constraint, not just the HTTP validator.
        await assert.rejects(async () => {
          await db
            .insert(shopTables)
            .values({
              name: "Invalid limit",
              qrToken: newToken(),
              orderLimit: 0,
            });
        });
      },
    );
  },
);
