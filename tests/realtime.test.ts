import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Response } from "express";
import { EventEmitter } from "node:events";
import { drizzle } from "drizzle-orm/node-postgres";
import { RealtimeHub } from "../src/lib/realtime/hub.ts";
import type { RealtimeAccess } from "../src/lib/realtime/access.ts";
import type { RevisionState } from "../src/lib/realtime/revisions.ts";
import { sseMessages, watchRealtime } from "../src/client/realtime.ts";

let replies: (unknown[] | Error)[] = [];
let queries: { text: string; params: unknown[] }[] = [];
const client = {
  async query(config: { text: string } | string, params: unknown[] = []) {
    const text = typeof config === "string" ? config : config.text;
    queries.push({ text, params });
    assert.ok(replies.length, `Unexpected query: ${text}`);
    const rows = replies.shift()!;
    if (rows instanceof Error) throw rows;
    return { rows };
  },
};
mock.module("../src/db/index.ts", { namedExports: { db: drizzle(client as never) } });
mock.module("../src/configs/env.ts", { namedExports: { env: {
  NODE_ENV: "test", ACCESS_TOKEN_SECRET: "test-only-realtime-secret-at-least-32-characters",
} } });
mock.module("../src/lib/logger.ts", { namedExports: {
  securityLog() {}, serializeError: () => ({}), logger: { error() {}, info() {} },
} });
mock.module("../src/lib/rateLimitStore.ts", { namedExports: { createStore: () => undefined } });

const { tableRealtime, staffRealtime } = await import("../src/routes/realtime.ts");
const { signAccessToken } = await import("../src/lib/tokens.ts");
const { tableAccess, staffAccess } = await import("../src/lib/realtime/access.ts");
const { readRevisions } = await import("../src/lib/realtime/revisions.ts");
const { openRealtimeStream, closeRealtimeStreams } = await import("../src/lib/realtime/stream.ts");
const { default: errorHandler } = await import("../src/middlewares/errorHandler.ts");

const sessionId = "11111111-1111-4111-8111-111111111111";
const otherSession = "33333333-3333-4333-8333-333333333333";
const cartId = "22222222-2222-4222-8222-222222222222";
const token = "A".repeat(43);
const now = new Date();
const account = [["staff", true]];
const table = [[1, "Table 1", 5, true]];
const session = [[sessionId, 1, "pending", now, null, now, null, null, null]];
const cart = [[cartId, sessionId, 0, now, now]];
const liveSession = [[true, token, "pending", now, cartId]];
const settingRows = [["idle_timeout_minutes", "180"]];
const resources = { orders: "a", tables: "b", menu: "c", store: "d", cart: "e" };
const state: RevisionState = { revision: "a".repeat(64), resources };
let streamState = state;
let streamFailure: Awaited<ReturnType<RealtimeAccess["check"]>> = null;
let sourceFails = false;
const streamSource = new RealtimeHub(async () => {
  if (sourceFails) throw new Error("Database unavailable");
  return streamState;
}, 10);

const app = express();
app.use("/tables/realtime", tableRealtime);
app.use("/staff/realtime", staffRealtime);
app.get("/test/events", (_req, res) => openRealtimeStream(res, {
  scope: { kind: "staff" }, key: "test", check: async () => streamFailure,
}, streamSource));
let fallbackRequests: string[] = [];
app.get("/fallback/events", (_req, res) => {
  fallbackRequests.push("events");
  res.sendStatus(503);
});
app.get("/fallback/changes", (_req, res) => {
  fallbackRequests.push("changes");
  res.json({ success: true, data: { ...state, scope: { kind: "staff" } } });
});
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
let base: string;
before(async () => {
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  closeRealtimeStreams();
  streamSource.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function setup(...rows: (unknown[] | Error)[]) { replies = rows; queries = []; }
async function request(path: string, staff = false) {
  const response = await fetch(base + path, { headers: staff
    ? { authorization: `Bearer ${signAccessToken(1, "staff")}` }
    : { "x-table-token": token }, signal: AbortSignal.timeout(3_000) });
  const body = await response.text();
  assert.equal(replies.length, 0, body);
  return { status: response.status, data: body && response.headers.get("content-type")?.includes("application/json") ? JSON.parse(body) : body };
}

test("customer polling is session-bound and never accepts a new visit implicitly", async () => {
  setup(table, session, cart);
  const result = await request(`/tables/realtime/changes?sessionId=${otherSession}`);
  assert.equal(result.status, 409);
  assert.equal(result.data.code, "TABLE_SESSION_REQUIRED");
  setup(table, session, cart);
  assert.equal((await request("/tables/realtime/changes")).status, 400);
  setup([]);
  assert.equal((await request(`/tables/realtime/events?sessionId=${sessionId}`)).status, 404);
});

test("polling returns revisions, then 204 for unchanged state with fresh authorization", async () => {
  setup(table, session, cart, liveSession, settingRows, [resources], liveSession, settingRows);
  const first = await request(`/tables/realtime/changes?sessionId=${sessionId}`);
  assert.equal(first.status, 200);
  assert.deepEqual(first.data.data.resources, resources);
  assert.deepEqual(first.data.data.scope, { kind: "table", tableId: 1, sessionId });
  const revision = first.data.data.revision;
  assert.match(revision, /^[a-f0-9]{64}$/);
  const query = queries.find((query) => query.text.includes("string_agg"))!;
  assert.ok(query.params.includes(sessionId));
  assert.ok(!query.params.includes(otherSession));
  assert.ok(!JSON.stringify(first.data).includes(token));

  setup(table, session, cart, liveSession, settingRows, [resources], liveSession, settingRows);
  assert.equal((await request(`/tables/realtime/changes?sessionId=${sessionId}&since=${revision}`)).status, 204);
});

test("staff polling requires a current active account and omits cart scope", async () => {
  setup();
  const missing = await fetch(base + "/staff/realtime/changes");
  assert.equal(missing.status, 401);
  setup([["staff", false]]);
  assert.equal((await request("/staff/realtime/changes", true)).status, 401);
  const { cart: _cart, ...staffResources } = resources;
  setup(account, [staffResources], [[true, "staff"]]);
  const result = await request("/staff/realtime/changes", true);
  assert.equal(result.status, 200);
  assert.equal(result.data.data.resources.cart, undefined);
  setup(account);
  assert.equal((await request("/staff/realtime/changes?since=invalid", true)).status, 400);
});

test("active stream guards reject expired tokens, deactivated QR, closed and idle sessions", async () => {
  setup();
  assert.equal((await staffAccess(1, "invalid").check())?.status, 401);
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const expiring = signAccessToken(1, "staff");
    mock.timers.tick(11 * 60_000);
    assert.equal((await staffAccess(1, expiring).check())?.code, "AUTH_REQUIRED");
    assert.equal(queries.length, 0);
  } finally { mock.timers.reset(); }
  setup([[false, "staff"]]);
  assert.equal((await staffAccess(1, signAccessToken(1, "staff")).check())?.status, 401);
  setup([[false, token, "pending", now, cartId]]);
  assert.equal((await tableAccess(1, sessionId, token).check())?.code, "INVALID_TABLE_QR");
  setup([[true, token, "closed", now, null]]);
  assert.equal((await tableAccess(1, sessionId, token).check())?.code, "TABLE_SESSION_REQUIRED");
  setup([[true, token, "open", new Date(0), cartId]], settingRows);
  assert.equal((await tableAccess(1, sessionId, token).check())?.status, 409);
  assert.equal(replies.length, 0);
});

test("revision fingerprints are independent of object key order and change with resources", async () => {
  setup([resources], [Object.fromEntries(Object.entries(resources).reverse())], [{ ...resources, orders: "new" }]);
  const a = await readRevisions({ kind: "staff" });
  const b = await readRevisions({ kind: "staff" });
  const c = await readRevisions({ kind: "staff" });
  assert.equal(a.revision, b.revision);
  assert.notEqual(a.revision, c.revision);
});

test("shared hub coalesces readers and detaches listeners during an in-flight read", async () => {
  let resolve!: (state: RevisionState) => void;
  let reads = 0;
  const hub = new RealtimeHub(() => { reads++; return new Promise((done) => { resolve = done; }); });
  let staleDeliveries = 0;
  let got!: () => void;
  const delivered = new Promise<void>((done) => { got = done; });
  const first = hub.subscribe({ kind: "staff" }, () => { staleDeliveries++; });
  const second = hub.subscribe({ kind: "staff" }, () => got());
  assert.equal(reads, 1);
  first();
  resolve(state);
  await delivered;
  second();
  assert.equal(staleDeliveries, 0);
  hub.close();
});

test("SSE emits sync, scoped change and access-ended, then closes", { timeout: 3_000 }, async () => {
  streamState = state;
  streamFailure = null;
  sourceFails = false;
  const response = await fetch(base + "/test/events", { signal: AbortSignal.timeout(2_500) });
  assert.match(response.headers.get("content-type")!, /^text\/event-stream/);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.match(response.headers.get("cache-control")!, /no-transform/);
  const messages = sseMessages(response.body!);
  assert.equal((await messages.next()).value?.event, "sync");
  streamState = { revision: "b".repeat(64), resources: { ...resources, orders: "new" } };
  const change = (await messages.next()).value!;
  assert.equal(change.event, "change");
  assert.deepEqual(JSON.parse(change.data).changed, ["orders"]);
  streamFailure = { status: 401, code: "AUTH_REQUIRED", message: "Expired" };
  assert.equal((await messages.next()).value?.event, "access-ended");
  assert.equal((await messages.next()).done, true);
  streamFailure = null;
});

test("stream failure instructs fallback and shutdown ends long-lived responses", { timeout: 3_000 }, async () => {
  sourceFails = true;
  let response = await fetch(base + "/test/events", { signal: AbortSignal.timeout(2_500) });
  let messages = sseMessages(response.body!);
  assert.equal((await messages.next()).value?.event, "unavailable");
  assert.equal((await messages.next()).done, true);
  sourceFails = false;
  response = await fetch(base + "/test/events", { signal: AbortSignal.timeout(2_500) });
  messages = sseMessages(response.body!);
  assert.equal((await messages.next()).value?.event, "sync");
  closeRealtimeStreams();
  assert.equal((await messages.next()).value?.event, "reconnect");
  assert.equal((await messages.next()).done, true);
});

test("slow readers are disconnected before subscribing to a source", () => {
  let reads = 0;
  const source = new RealtimeHub(async () => { reads++; return state; });
  let destroyed = false;
  const emitter = new EventEmitter();
  const response = Object.assign(emitter, {
    status() { return this; }, set() { return this; }, flushHeaders() {},
    write: () => false,
    destroy() { destroyed = true; emitter.emit("close"); },
  }) as unknown as Response;
  openRealtimeStream(response, { key: "slow", scope: { kind: "staff" }, check: async () => null }, source);
  assert.equal(destroyed, true);
  assert.equal(reads, 0);
  source.close();
});

test("browser helper falls back to polling, applies state, and stops cleanly", { timeout: 3_000 }, async () => {
  fallbackRequests = [];
  const abort = new AbortController();
  const transports: string[] = [];
  let applied = false;
  const watcher = watchRealtime({
    url: base + "/fallback", headers: () => ({ "x-table-token": token }), signal: abort.signal,
    onTransport: (transport) => { transports.push(transport); },
    onChange(next, changed) {
      assert.equal(next.revision, state.revision);
      assert.deepEqual(changed.sort(), Object.keys(resources).sort());
      applied = true;
      abort.abort();
    },
  });
  await watcher.done;
  assert.equal(applied, true);
  assert.deepEqual(fallbackRequests, ["events", "changes"]);
  assert.deepEqual(transports, ["polling"]);
});

test("SSE parser handles byte-split UTF-8, CRLF, comments and multiline JSON", async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\nevent: change\r\ndata: {"name":"₱",\r\ndata: "ok":true}\r\n\r\n');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const output = [];
  for await (const message of sseMessages(body)) output.push(message);
  assert.equal(output.length, 1);
  assert.equal(output[0].event, "change");
  assert.deepEqual(JSON.parse(output[0].data), { name: "₱", ok: true });
});
