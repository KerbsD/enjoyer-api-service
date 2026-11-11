import { test, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Request, Response } from "express";

// Real handlers, validators, permission checks and helpers; mocked external boundaries.
type Row = Record<string, unknown>;
let reads: Row[][] = [];
let writes: { table: unknown; values: Row }[] = [];
let locks = 0;
let returned: Row = {};
let logs: string[] = [];
const chain = (rows: Row[]) => ({
  from() {
    return this;
  },
  where() {
    return this;
  },
  for() {
    return this;
  },
  limit() {
    return this;
  },
  then(resolve: (rows: Row[]) => unknown) {
    return Promise.resolve(rows).then(resolve);
  },
});
const tx = {
  execute: async () => {
    locks++;
  },
  select: () => {
    assert.ok(reads.length, "Unexpected database read");
    return chain(reads.shift()!);
  },
  update: (table: unknown) => ({
    set: (values: Row) => {
      writes.push({ table, values });
      return {
        where: () => ({
          returning: async () => [{ ...returned, ...values }],
          then: (resolve: (value: unknown[]) => unknown) =>
            Promise.resolve([]).then(resolve),
        }),
      };
    },
  }),
};
mock.module("../src/db/index.ts", {
  namedExports: {
    db: {
      ...tx,
      transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
    },
  },
});
mock.module("../src/services/email.ts", {
  namedExports: { sendInviteEmail: async () => {} },
});
mock.module("../src/lib/logger.ts", {
  namedExports: {
    securityLog(event: string) {
      logs.push(event);
    },
    logger: { error() {} },
    serializeError: () => ({}),
  },
});
mock.module("../src/lib/tokens.ts", {
  namedExports: {
    verifyAccessToken: () => ({ id: 1, role: "owner" }),
    newToken: () => "test-token",
    sha256: () => "test-hash",
    INVITE_TTL_MS: 1000,
    EMAIL_COOLDOWN_MS: 1000,
  },
});
const { handleUpdateAccount: update } =
  await import("../src/controllers/accounts/updateAccount.ts");
const { handleDeactivateAccount: deactivate } =
  await import("../src/controllers/accounts/deactivateAccount.ts");
const { handleReactivateAccount: reactivate } =
  await import("../src/controllers/accounts/reactivateAccount.ts");
const { updateAccountSchema } = await import("../src/validators/accounts.ts");
const { verifyJwt } = await import("../src/middlewares/verifyJwt.ts");
const { requireFreshPermission } =
  await import("../src/middlewares/requireFreshPermission.ts");
const { default: adminRouter } =
  await import("../src/routes/accounts/admin.ts");
const { sessions } = await import("../src/db/schema.ts");

function response() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    set() {
      return this;
    },
    sendStatus(code: number) {
      this.statusCode = code;
      return this;
    },
  };
}
const owner = { id: 1, name: "Owner", role: "owner", active: true };
const staff = {
  id: 2,
  name: "Ana",
  role: "staff",
  active: true,
  invitePending: false,
};
function reset(rows: Row[][], target: Row = staff) {
  reads = rows;
  writes = [];
  locks = 0;
  logs = [];
  returned = target;
}
async function invoke(
  handler: (req: Request, res: Response) => unknown,
  body: unknown,
  rows: Row[][],
  target: Row = staff,
  id = String(target.id),
) {
  reset(rows, target);
  const res = response();
  await handler(
    {
      params: { id },
      body,
      user: { id: 1, role: "owner" },
    } as unknown as Request,
    res as unknown as Response,
  );
  assert.equal(reads.length, 0);
  return res;
}

test("editing accepts trimmed names and roles, rejects empty bodies and unrelated fields", () => {
  for (const body of [
    {},
    { name: " " },
    { name: "a".repeat(101) },
    { active: false },
    { email: "a@b.com" },
    { role: "admin" },
  ])
    assert.equal(updateAccountSchema.safeParse(body).success, false);
  assert.deepEqual(
    updateAccountSchema.parse({ name: " Ana ", role: "manager" }),
    { name: "Ana", role: "manager" },
  );
});
test("Owners cannot deactivate themselves or change their own role", async () => {
  for (const [handler, body] of [
    [update, { role: "staff" }],
    [deactivate, {}],
  ] as const) {
    assert.equal(
      (await invoke(handler, body, [[owner], [owner]], owner)).statusCode,
      409,
    );
    assert.equal(writes.length, 0);
    assert.equal(locks, 1);
  }
});
test("Owners may rename themselves without losing sessions", async () => {
  assert.equal(
    (await invoke(update, { name: "New name" }, [[owner], [owner]], owner))
      .statusCode,
    200,
  );
  assert.deepEqual(
    writes.map((w) => w.values),
    [{ name: "New name" }],
  );
});
test("another Owner can be demoted and role changes revoke sessions", async () => {
  const target = { ...owner, id: 2 };
  assert.equal(
    (await invoke(update, { role: "staff" }, [[owner], [target]], target))
      .statusCode,
    200,
  );
  assert.equal(writes[1].table, sessions);
  assert.ok(writes[1].values.revokedAt instanceof Date);
  assert.deepEqual(logs, ["account_role_changed"]);
});
test("deactivation clears reset links, cooldown and sessions", async () => {
  assert.equal(
    (await invoke(deactivate, {}, [[owner], [staff]])).statusCode,
    200,
  );
  assert.deepEqual(writes[0].values, {
    active: false,
    resetPasswordTokenHash: null,
    resetPasswordExpiresAt: null,
    resetPasswordSentAt: null,
  });
  assert.equal(writes[1].table, sessions);
  assert.deepEqual(logs, ["account_deactivated"]);
});
test("reactivation rechecks the Owner and prompts for a new pending invite", async () => {
  const target = { ...staff, active: false, invitePending: true };
  const res = await invoke(reactivate, {}, [[owner], [target]], target);
  assert.equal(res.statusCode, 200);
  assert.equal(locks, 1);
  assert.deepEqual(writes[0].values, { active: true });
  assert.equal(writes[1].table, sessions);
  assert.match((res.body as { message: string }).message, /send a new invite/);
});
test("repeated requests do not write or emit change events", async () => {
  for (const [handler, body, target] of [
    [update, { name: staff.name, role: staff.role }, staff],
    [deactivate, {}, { ...staff, active: false }],
    [reactivate, {}, staff],
  ] as const) {
    assert.equal(
      (await invoke(handler, body, [[owner], [target]], target)).statusCode,
      200,
    );
    assert.equal(writes.length, 0);
    assert.equal(logs.length, 0);
  }
});
test("mutations reject callers demoted or disabled after route authorization and handle missing targets", async () => {
  for (const handler of [update, deactivate, reactivate]) {
    for (const actor of [
      { ...owner, role: "staff" },
      { ...owner, active: false },
    ]) {
      assert.equal(
        (await invoke(handler, { name: "New" }, [[actor]])).statusCode,
        403,
      );
      assert.equal(writes.length, 0);
      assert.equal(locks, 1);
    }
    assert.equal((await invoke(handler, {}, [[owner], []])).statusCode, 404);
    assert.equal(
      (await invoke(handler, {}, [], staff, "invalid")).statusCode,
      404,
    );
  }
});
test("JWT middleware uses current roles and denies missing or inactive accounts", async () => {
  for (const account of [staff, { ...owner, active: false }, null]) {
    reset([account ? [account] : []]);
    const req = {
      headers: { authorization: "Bearer a.b.c" },
      user: undefined,
    } as unknown as Request;
    const res = response();
    let next = false;
    await verifyJwt(req, res as unknown as Response, () => {
      next = true;
    });
    assert.equal(next, Boolean(account?.active));
    if (account?.active) assert.equal(req.user?.role, "staff");
    else assert.equal(res.statusCode, 401);
  }
});
test("fresh permissions deny stale Owner claims and accept a current Owner", async () => {
  for (const account of [owner, staff, { ...owner, active: false }, null]) {
    reset([account ? [account] : []]);
    const req = { user: { id: 1, role: "owner" } } as Request;
    const res = response();
    let next = false;
    await requireFreshPermission("account:manage")(
      req,
      res as unknown as Response,
      () => {
        next = true;
      },
    );
    assert.equal(next, account === owner);
    assert.equal(
      res.statusCode,
      account === owner ? 200 : account?.active ? 403 : 401,
    );
  }
  reset([]);
  const res = response();
  await requireFreshPermission("account:manage")(
    {} as Request,
    res as unknown as Response,
    () => assert.fail(),
  );
  assert.equal(res.statusCode, 401);
});
test("HTTP routes enforce permissions, validation and wire all three actions", async () => {
  const app = express();
  app.use(express.json());
  app.use(verifyJwt);
  app.use("/admin/accounts", adminRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/admin/accounts/2`;
  const headers = {
    authorization: "Bearer a.b.c",
    "content-type": "application/json",
  };
  try {
    for (const role of ["staff", "manager"]) {
      reset([[{ ...owner, role }], [{ ...owner, role }]]);
      assert.equal(
        (await fetch(url, { method: "PATCH", headers, body: '{"name":"New"}' }))
          .status,
        403,
      );
      assert.equal(writes.length, 0);
    }
    reset([[owner], [owner]]);
    assert.equal(
      (await fetch(url, { method: "PATCH", headers, body: '{"active":false}' }))
        .status,
      400,
    );
    for (const [suffix, method, body, target] of [
      ["", "PATCH", { name: "New" }, staff],
      ["/deactivate", "POST", {}, staff],
      ["/reactivate", "POST", {}, { ...staff, active: false }],
    ] as const) {
      reset([[owner], [owner], [owner], [target]], target);
      const res = await fetch(url + suffix, {
        method,
        headers,
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).success, true);
      assert.equal(reads.length, 0);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
