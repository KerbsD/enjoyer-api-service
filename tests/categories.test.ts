import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { drizzle } from "drizzle-orm/node-postgres";

// Keep real Drizzle query generation and result mapping. Only pg's query
// boundary is scripted: no database connection or user data is touched.
type Reply = unknown[][] | Error;
let replies: Reply[] = [];
let queries: { text: string; params: unknown[] }[] = [];
const client = {
  async query(config: { text: string }, params: unknown[]) {
    queries.push({ text: config.text, params });
    assert.ok(replies.length, "Unexpected database query");
    const reply = replies.shift()!;
    if (reply instanceof Error) throw reply;
    return { rows: reply };
  },
};
mock.module("../src/db/index.ts", {
  namedExports: { db: drizzle(client as never) },
});
mock.module("../src/configs/env.ts", {
  namedExports: {
    env: {
      NODE_ENV: "test",
      ACCESS_TOKEN_SECRET: "test-only-category-secret-at-least-32-characters",
    },
  },
});
mock.module("../src/lib/logger.ts", {
  namedExports: {
    securityLog() {},
    logger: { error() {} },
    serializeError: () => ({}),
  },
});
const { default: router } = await import("../src/routes/categories/admin.ts");
const { verifyJwt } = await import("../src/middlewares/verifyJwt.ts");
const { signAccessToken } = await import("../src/lib/tokens.ts");
const { default: errorHandler } =
  await import("../src/middlewares/errorHandler.ts");
const app = express();
app.use(express.json());
app.use(verifyJwt);
app.use("/admin/categories", router);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
let base: string;
before(async () => {
  if (!server.listening)
    await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}/admin/categories`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});
const date = "2026-11-11T00:00:00.000Z";
const row = (id = 1, name = "Sandwiches", position = 0) => [
  id,
  name,
  position,
  date,
  date,
];
const account = (role = "manager", active = true) => [[role, active]];
function setup(...values: Reply[]) {
  replies = values;
  queries = [];
}
async function request(
  method: string,
  path = "",
  body?: unknown,
  role: "staff" | "manager" | "owner" | null = "manager",
) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(role ? { authorization: `Bearer ${signAccessToken(1, role)}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  assert.equal(replies.length, 0, "Unconsumed database replies");
  return { status: res.status, data };
}

test("all category routes require an active Manager or Owner", async () => {
  for (const [method, path, body] of [
    ["GET", "", undefined],
    ["POST", "", { name: "Test" }],
    ["PATCH", "/1", { name: "Test" }],
  ] as const) {
    setup();
    assert.equal((await request(method, path, body, null)).status, 401);
    setup(account("staff"));
    assert.equal((await request(method, path, body, "staff")).status, 403);
    assert.equal(queries.length, 1);
    setup(account("manager", false));
    assert.equal((await request(method, path, body)).status, 401);
  }
  // A stale Owner token cannot retain menu permissions after demotion to Staff.
  setup(account("staff"));
  assert.equal(
    (await request("POST", "", { name: "Test" }, "owner")).status,
    403,
  );
});
test("Manager and Owner can create trimmed categories with explicit or default sort positions", async () => {
  for (const role of ["manager", "owner"] as const) {
    setup(account(role), [row()]);
    const result = await request("POST", "", { name: "  Sandwiches  " }, role);
    assert.equal(result.status, 201);
    assert.equal(result.data.data.name, "Sandwiches");
    assert.deepEqual(queries[1].params, ["Sandwiches", 0]);
    assert.match(queries[1].text, /^insert into "categories"/);
  }
  setup(account(), [row(2, "Pastries", 10)]);
  const result = await request("POST", "", { name: "Pastries", sortOrder: 10 });
  assert.equal(result.status, 201);
  assert.equal(result.data.data.sortOrder, 10);
});
test("invalid bodies are rejected before category writes", async () => {
  for (const body of [
    {},
    { name: " " },
    { name: "x".repeat(101) },
    { name: 42 },
    { name: "Test", sortOrder: -1 },
    { name: "Test", sortOrder: 1.5 },
    { name: "Test", sortOrder: "1" },
    { name: "Test", sortOrder: 2_147_483_648 },
    { name: "Test", isHidden: true },
  ]) {
    setup(account());
    assert.equal((await request("POST", "", body)).status, 400);
    assert.equal(queries.length, 1);
  }
  for (const body of [
    {},
    { name: null },
    { sortOrder: null },
    { active: false },
  ]) {
    setup(account());
    assert.equal((await request("PATCH", "/1", body)).status, 400);
  }
});
test("listing uses stable display order and limit/offset pagination", async () => {
  setup(account(), [row(2, "Pastries", 10)], [[3]]);
  const result = await request("GET", "?limit=1&offset=1");
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.pagination, {
    limit: 1,
    offset: 1,
    total: 3,
    hasMore: true,
  });
  assert.match(
    queries[1].text,
    /order by "categories"\."sort_order" asc, "categories"\."id" asc/,
  );
  assert.deepEqual(queries[1].params, [1, 1]);
  setup(account(), [], [[0]]);
  const empty = await request("GET");
  assert.deepEqual(empty.data.data, []);
  assert.deepEqual(empty.data.pagination, {
    limit: 50,
    offset: 0,
    total: 0,
    hasMore: false,
  });
  for (const query of [
    "?limit=0",
    "?limit=101",
    "?offset=-1",
    "?limit=abc",
    "?sort=name",
  ]) {
    setup(account());
    assert.equal((await request("GET", query)).status, 400);
  }
});
test("partial edits target one ID and preserve omitted fields", async () => {
  setup(account(), [row(7, "Hot drinks", 10)]);
  assert.equal(
    (await request("PATCH", "/7", { name: "Hot drinks" })).status,
    200,
  );
  assert.match(queries[1].text, /where "categories"\."id" = \$\d+/);
  assert.equal(queries[1].params.at(-1), 7);
  const setClause = queries[1].text.split(" where ")[0];
  assert.ok(!setClause.includes('"sort_order" ='));
  setup(account(), [row(7, "Hot drinks", 0)]);
  assert.equal((await request("PATCH", "/7", { sortOrder: 0 })).status, 200);
  assert.ok(!queries[1].text.split(" where ")[0].includes('"name" ='));
  assert.equal(queries[1].params[0], 0);
});
test("invalid and missing category IDs return 404; database errors remain generic", async () => {
  for (const id of ["invalid", "0", "-1", "1.5", "2147483648"]) {
    setup(account());
    assert.equal(
      (await request("PATCH", `/${id}`, { name: "Test" })).status,
      404,
    );
  }
  setup(account(), []);
  assert.equal((await request("PATCH", "/999", { name: "Test" })).status, 404);
  setup(account(), new Error("private database error"));
  const failed = await request("POST", "", { name: "Test" });
  assert.equal(failed.status, 500);
  assert.equal(failed.data.message, "Internal Server Error");
  assert.ok(!JSON.stringify(failed.data).includes("private database error"));
});
