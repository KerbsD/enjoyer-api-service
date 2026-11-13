import { test, mock } from "node:test";
import assert from "node:assert/strict";

type Row = Record<string, any>;
let original: Row;
let reads: Row[][] = [];
let issued: Row[] = [];
let revocations = 0;
const chain = (rows: Row[]) => ({
  from() {
    return this;
  },
  where() {
    return this;
  },
  limit() {
    return this;
  },
  for() {
    return this;
  },
  then(resolve: (rows: Row[]) => unknown) {
    return Promise.resolve(rows).then(resolve);
  },
});
const db = {
  transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  select: () => {
    assert.ok(reads.length);
    return chain(reads.shift()!);
  },
  update: () => ({
    set(values: Row) {
      if (values.usedAt) Object.assign(original, values);
      if (values.revokedAt) {
        revocations++;
        for (const row of [original, ...issued]) Object.assign(row, values);
      }
      return chain([]);
    },
  }),
  insert: () => ({
    values(row: Row) {
      issued.push(row);
      return Promise.resolve();
    },
  }),
};
mock.module("../src/db/index.ts", { namedExports: { db } });
mock.module("../src/configs/env.ts", {
  namedExports: {
    env: {
      NODE_ENV: "test",
      ACCESS_TOKEN_SECRET: "test-only-session-secret-at-least-32-chars",
    },
  },
});
mock.module("../src/lib/logger.ts", { namedExports: { securityLog() {} } });
const { rotateSession } = await import("../src/lib/sessions.ts");
const { newToken, REFRESH_GRACE_MS } = await import("../src/lib/tokens.ts");
const token = newToken();

function setup() {
  original = {
    id: "test-session",
    userId: 1,
    familyId: "test-family",
    ip: "192.0.2.1",
    userAgent: "TestBrowser",
    usedAt: null,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 86400_000),
    absoluteExpiresAt: new Date(Date.now() + 604800_000),
  };
  reads = [];
  issued = [];
  revocations = 0;
}
async function rotate(ip: string, userAgent = "TestBrowser") {
  // Real transactions serialize these calls; model the state after each commit.
  reads.push(
    [{ userId: 1 }],
    [{ name: "Test user", role: "staff", active: true }],
    [{ ...original }],
  );
  return rotateSession(token, { ip, userAgent });
}

test("same-client refresh races succeed before and after a network change", async () => {
  for (const ip of ["192.0.2.1", "192.0.2.2"]) {
    setup();
    assert.equal((await rotate(ip)).ok, true);
    const usedAt = original.usedAt;
    assert.equal((await rotate(ip)).ok, true);
    assert.equal(original.ip, ip);
    assert.equal(
      original.usedAt,
      usedAt,
      "a retry must not extend the grace window",
    );
    assert.equal(issued.length, 2);
    assert.equal(revocations, 0);
  }
});

test("different IP or user-agent replays revoke the whole family during grace", async () => {
  for (const [ip, agent] of [
    ["192.0.2.1", "TestBrowser"],
    ["192.0.2.2", "OtherBrowser"],
  ]) {
    setup();
    assert.equal((await rotate("192.0.2.2")).ok, true);
    const result = await rotate(ip, agent);
    assert.ok(
      !result.ok && result.reason === "reuse" && result.cause === "grace",
    );
    assert.equal(revocations, 1);
    assert.ok(issued[0].revokedAt instanceof Date);
    assert.equal(issued.length, 1);
  }
});

test("the same client still loses its session when replaying outside grace", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  setup();
  assert.equal((await rotate("192.0.2.2")).ok, true);
  t.mock.timers.tick(REFRESH_GRACE_MS + 1);
  const result = await rotate("192.0.2.2");
  assert.ok(
    !result.ok && result.reason === "reuse" && result.cause === "window",
  );
  assert.equal(revocations, 1);
  assert.ok(issued[0].revokedAt instanceof Date);
});
