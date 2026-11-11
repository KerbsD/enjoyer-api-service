import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import type { RequestHandler } from "express";

// Test the production Express app and real bcrypt/JWT/session logic. Database
// responses are scripted; no real credentials, database or email service is used.
type Row = Record<string, unknown>;
let reads: Row[][] = [];
let returns: Row[][] = [];
let writes: { values: Row; operation: string }[] = [];
let mail: { kind: string; token?: string }[] = [];
let insertError: Error | undefined;
let mailFails = false;
let pwned = false;
const chain = (rows: Row[]) => ({
  from() { return this; }, where() { return this; }, limit() { return this; }, innerJoin() { return this; },
  for() { return this; }, orderBy() { return this; }, offset() { return this; },
  then(resolve: (rows: Row[]) => unknown) { return Promise.resolve(rows).then(resolve); },
});
function mutation(operation: string, values: Row) {
  writes.push({ operation, values });
  const rows = returns.shift() ?? [];
  return { ...chain(rows), returning: async () => rows };
}
const db = {
  select() { assert.ok(reads.length, "Unexpected database read"); return chain(reads.shift()!); },
  update: () => ({ set: (values: Row) => mutation("update", values) }),
  insert: () => ({ values: (values: Row) => {
    if (insertError) throw insertError;
    return mutation("insert", values);
  } }),
  execute: async () => {},
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
};
mock.module("../src/db/index.ts", { namedExports: { db, pool: { query: async () => ({ rows: [] }) } } });
mock.module("../src/configs/env.ts", { namedExports: { env: {
  NODE_ENV: "test", TRUST_PROXY_HOPS: 0, ACCESS_TOKEN_SECRET: "test-only-secret-not-used-outside-tests-12345",
  COOKIE_SAMESITE: "lax", CORS_ORIGINS: ["http://localhost:5173"], LOG_LEVEL: "silent",
} } });
mock.module("../src/lib/logger.ts", { namedExports: {
  securityLog() {}, serializeError: () => ({}), logger: { info() {}, warn() {}, error() {} },
} });
mock.module("../src/services/email.ts", { namedExports: {
  sendInviteEmail: async (_user: unknown, token: string) => { if (mailFails) throw new Error("SMTP unavailable"); mail.push({ kind: "invite", token }); },
  sendPasswordResetEmail: async (_email: string, token: string) => { mail.push({ kind: "reset", token }); },
  sendPasswordChangedEmail: async () => { mail.push({ kind: "changed" }); },
  queueEmail: (_label: string, send: () => Promise<void>) => { void send(); },
} });
mock.module("../src/lib/pwned.ts", { namedExports: {
  isPwnedPassword: async () => pwned,
  pwnedPasswordResponse: () => ({ success: false, message: "Breached password." }),
} });
const pass: RequestHandler = (_req, _res, next) => next();
mock.module("../src/lib/authLimiter.ts", { namedExports: Object.fromEntries([
  "globalLimiter", "loginIpLimiter", "loginLimiter", "loginUserBackoff", "forgotPasswordLimiter",
  "forgotPasswordEmailLimiter", "resetPasswordLimiter", "refreshFailLimiter", "refreshLimiter", "logoutLimiter",
].map(name => [name, pass])) });
const { default: app } = await import("../src/app.ts");
const { signAccessToken, newToken, sha256, verifyAccessToken } = await import("../src/lib/tokens.ts");
const { createSession, rotateSession, revokeSessionFamily } = await import("../src/lib/sessions.ts");
const owner = { id: 1, name: "Owner", email: "owner@example.test", role: "owner", active: true };
const manager = { id: 2, name: "Manager", email: "manager@example.test", role: "manager", active: true };
const password = "Fresh coffee password 123!";
const hash = await bcrypt.hash(password, 4);
const token = newToken();
const future = new Date(Date.now() + 60_000);
const sessionRow = { id: "session", userId: 2, familyId: "family", tokenHash: sha256(token),
  usedAt: null, revokedAt: null, expiresAt: future, absoluteExpiresAt: future, ip: null, userAgent: null };
const server = app.listen(0, "127.0.0.1");
let base: string;
before(async () => {
  if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string"); base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
});
function setup(rows: Row[][] = [], resultRows: Row[][] = []) {
  reads = rows; returns = resultRows; writes = []; mail = []; insertError = undefined; mailFails = false; pwned = false;
}
async function request(method: string, path: string, body?: unknown, auth?: "owner" | "manager", cookie?: string, origin = "http://localhost:5173") {
  const res = await fetch(base + path, { method, headers: {
    "content-type": "application/json", origin,
    ...(auth ? { authorization: `Bearer ${signAccessToken(auth === "owner" ? 1 : 2, auth)}` } : {}),
    ...(cookie ? { cookie: `refresh=${cookie}` } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  assert.equal(reads.length, 0, `${method} ${path}: unconsumed reads`);
  return { status: res.status, data, cookie: res.headers.get("set-cookie"), cache: res.headers.get("cache-control") };
}

test("Owner creates a Manager; invite stores only a hash and pending account cannot log in", async () => {
  setup([[owner], [owner]], [[{ ...manager, invitePending: true }]]);
  const created = await request("POST", "/admin/accounts", { name: manager.name, email: manager.email, role: "manager" }, "owner");
  assert.equal(created.status, 201); assert.equal(created.data.inviteEmailSent, true);
  assert.equal(writes[0].values.password, null);
  assert.equal(writes[0].values.resetPasswordTokenHash, sha256(mail[0].token!));
  assert.equal(created.data.data.password, undefined); assert.equal(created.cache, "no-store");
  setup([[{ ...manager, password: null }]]);
  assert.equal((await request("POST", "/auth/login", { email: manager.email, pwd: password })).status, 401);
});
test("invite validation and acceptance work without login; link cannot accept an existing account", async () => {
  setup([[{ password: null, active: true, expiresAt: future }]]);
  assert.equal((await request("POST", "/auth/invite/validate", { token })).status, 200);
  setup([[{ ...manager, password: null, expiresAt: future }]]);
  const accepted = await request("PATCH", "/auth/invite/accept", { token, newPwd: password });
  assert.equal(accepted.status, 200); assert.match(accepted.data.message, /now log in/);
  assert.equal(writes[0].values.resetPasswordTokenHash, null);
  assert.ok(await bcrypt.compare(password, writes[0].values.password as string));
  assert.ok(writes[1].values.revokedAt instanceof Date);
  for (const user of [null, { ...manager, password: hash, expiresAt: future },
    { ...manager, active: false, password: null, expiresAt: future },
    { ...manager, password: null, expiresAt: new Date(0) }]) {
    setup([user ? [user] : []]);
    assert.equal((await request("PATCH", "/auth/invite/accept", { token, newPwd: password })).status, 400);
    assert.equal(writes.length, 0);
  }
  setup(); assert.equal((await request("PATCH", "/auth/invite/accept", { token, newPwd: "short" })).status, 400);
  setup(); assert.equal((await request("POST", "/auth/invite/validate", { token: "bad" })).status, 400);
});
test("Manager logs in, reads own profile, refreshes and logs out but cannot manage accounts", async () => {
  setup([[{ ...manager, password: hash }], [{ ...manager, password: hash }]]);
  const login = await request("POST", "/auth/login", { email: manager.email, pwd: password });
  assert.equal(login.status, 200); assert.equal(verifyAccessToken(login.data.accessToken).role, "manager");
  assert.match(login.cookie!, /HttpOnly/);
  setup([[manager], [manager]]);
  assert.equal((await request("GET", "/auth/me", undefined, "manager")).data.data.email, manager.email);
  setup([[manager], [manager]]);
  assert.equal((await request("POST", "/admin/accounts", { name: "Denied" }, "manager")).status, 403);
  setup([[{ userId: 2 }], [manager], [sessionRow]]);
  const refreshed = await request("POST", "/auth/refresh", {}, undefined, token);
  assert.equal(refreshed.status, 200); assert.notEqual(refreshed.cookie, login.cookie);
  setup([[{ userId: 2, familyId: "family" }], [{ id: 2 }]]);
  assert.equal((await request("POST", "/auth/logout", {}, undefined, token)).status, 204);
  assert.ok(writes[0].values.revokedAt instanceof Date);
});
test("login rejects wrong passwords, inactive users and untrusted origins", async () => {
  setup([[{ ...manager, password: hash }]]);
  assert.equal((await request("POST", "/auth/login", { email: manager.email, pwd: "wrong" })).status, 401);
  setup([[{ ...manager, password: hash, active: false }]]);
  assert.equal((await request("POST", "/auth/login", { email: manager.email, pwd: password })).status, 403);
  setup(); assert.equal((await request("POST", "/auth/login", {}, undefined, undefined, "https://untrusted.test")).status, 403);
  setup(); assert.equal((await request("POST", "/auth/refresh", {})).status, 401);
  setup(); assert.equal((await request("POST", "/auth/refresh", {}, undefined, "bad")).status, 403);
  setup(); assert.equal((await request("POST", "/auth/logout", {})).status, 204);
});
test("forgot/reset flow uses neutral responses and consumes reset tokens", async () => {
  setup([], [[{ id: 2, email: manager.email }]]);
  const known = await request("POST", "/auth/password/forgot", { email: manager.email });
  assert.equal(mail[0].kind, "reset");
  setup([], [[]]);
  const unknown = await request("POST", "/auth/password/forgot", { email: "unknown@example.test" });
  assert.deepEqual(known.data, unknown.data);
  setup([[{ ...manager, password: hash, expiresAt: future }]]);
  assert.equal((await request("PATCH", "/auth/password/reset", { token, newPwd: password + "new" })).status, 200);
  assert.equal(mail[0].kind, "changed"); assert.equal(writes[0].values.resetPasswordTokenHash, null);
  setup([[]]); assert.equal((await request("PATCH", "/auth/password/reset", { token, newPwd: password })).status, 400);
});
test("authenticated password change requires current password and revokes sessions", async () => {
  setup(); assert.equal((await request("PATCH", "/auth/password/change", { currentPwd: password, newPwd: password + "new" })).status, 401);
  setup([[manager], [{ ...manager, password: hash }]]);
  assert.equal((await request("PATCH", "/auth/password/change", { currentPwd: "wrong", newPwd: password + "new" }, "manager")).status, 400);
  setup([[manager], [{ ...manager, password: hash }]]);
  assert.equal((await request("PATCH", "/auth/password/change", { currentPwd: password, newPwd: password }, "manager")).status, 400);
  setup([[manager], [{ ...manager, password: hash }], [{ ...manager, password: hash }]]);
  const changed = await request("PATCH", "/auth/password/change", { currentPwd: password, newPwd: password + "new" }, "manager");
  assert.equal(changed.status, 200); assert.match(changed.cookie!, /Expires=/);
  assert.ok(writes[1].values.revokedAt instanceof Date); assert.equal(mail[0].kind, "changed");
});
test("account list/details, duplicate emails, mail failures and invite resend errors", async () => {
  setup([[owner], [owner], [manager], [{ total: 1 }]]);
  const list = await request("GET", "/admin/accounts?role=manager", undefined, "owner");
  assert.equal(list.status, 200); assert.equal(list.data.pagination.total, 1);
  setup([[owner], [owner], [manager]]);
  assert.equal((await request("GET", "/admin/accounts/2", undefined, "owner")).data.data.id, 2);
  setup([[owner], [owner]], [[{ ...manager, invitePending: true }]]); mailFails = true;
  const failedMail = await request("POST", "/admin/accounts", manager, "owner");
  assert.equal(failedMail.status, 201); assert.equal(failedMail.data.inviteEmailSent, false);
  setup([[owner], [owner]]); insertError = Object.assign(new Error("duplicate"), { constraint: "users_email_lower_idx" });
  assert.equal((await request("POST", "/admin/accounts", manager, "owner")).status, 409);
  setup([[owner], [owner]], [[manager]]);
  assert.equal((await request("POST", "/admin/accounts/2/resend-invite", {}, "owner")).status, 200);
  assert.equal(mail[0].kind, "invite");
  for (const [target, status] of [[{ active: true, invitePending: false }, 409],
    [{ active: false, invitePending: true }, 409], [{ active: true, invitePending: true }, 429]] as const) {
    setup([[owner], [owner], [target]], [[]]);
    assert.equal((await request("POST", "/admin/accounts/2/resend-invite", {}, "owner")).status, status);
  }
});
test("session creation rejects changed credentials; refresh rejects revoked, expired and replayed tokens", async () => {
  for (const user of [{ ...manager, password: hash, active: false }, { ...manager, password: "changed" }]) {
    setup([[user]]); assert.equal(await createSession(2, hash), null); assert.equal(writes.length, 0);
  }
  for (const patch of [{ revokedAt: new Date() }, { expiresAt: new Date(0) }]) {
    setup([[{ userId: 2 }], [manager], [{ ...sessionRow, ...patch }]]);
    assert.equal((await rotateSession(token)).ok, false); assert.equal(writes.length, 0);
  }
  setup([[{ userId: 2 }], [manager], [{ ...sessionRow, usedAt: new Date(Date.now() - 20_000) }]]);
  const replay = await rotateSession(token);
  assert.ok(!replay.ok && replay.reason === "reuse"); assert.equal(writes.length, 1);
  setup([[]]); await revokeSessionFamily(token); assert.equal(writes.length, 0);
});

test("production app mounts category routes under Manager permissions", async () => {
  setup([[manager], [], [{ total: 0 }]]);
  const result = await request("GET", "/admin/categories", undefined, "manager");
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.data, []);
});

test("production app mounts public menu before authentication and protects item routes", async () => {
  setup([[]]);
  assert.equal((await request("GET", "/menu")).status, 200);
  setup([[manager], [], [{ total: 0 }]]);
  assert.equal((await request("GET", "/admin/menu-items", undefined, "manager")).status, 200);
  setup([[manager]], [[{ id: 1, isAvailable: false }]]);
  assert.equal((await request("PATCH", "/staff/menu-items/1/availability", { isAvailable: false }, "manager")).status, 200);
});
