import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { drizzle } from "drizzle-orm/node-postgres";

type Reply = unknown[][] | Error;
let replies: Reply[] = [];
let queries: { text: string; params: unknown[] }[] = [];
const client = {
  async query(config: { text: string }, params: unknown[] = []) {
    queries.push({ text: config.text, params });
    assert.ok(replies.length, "Unexpected database query");
    const rows = replies.shift()!;
    if (rows instanceof Error) throw rows;
    return { rows };
  },
};
mock.module("../src/db/index.ts", {
  namedExports: { db: drizzle(client as never) },
});
mock.module("../src/configs/env.ts", {
  namedExports: {
    env: {
      NODE_ENV: "test",
      ACCESS_TOKEN_SECRET: "test-only-tables-secret-at-least-32-chars",
      CLIENT_URL: "https://admin.example.test",
      CUSTOMER_URL: "https://order.example.test",
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
const { default: admin } = await import("../src/routes/tables/admin.ts");
const { default: staff } = await import("../src/routes/tables/staff.ts");
const { resolveTable } = await import("../src/controllers/tables/public.ts");
const { validateResolveTable } = await import("../src/validators/tables.ts");
const { verifyJwt } = await import("../src/middlewares/verifyJwt.ts");
const { signAccessToken } = await import("../src/lib/tokens.ts");
const { default: errorHandler } =
  await import("../src/middlewares/errorHandler.ts");
const { qrSvg, tableUrl } = await import("../src/lib/tableQr.ts");
const app = express();
app.use(express.json());
app.post("/tables/resolve", validateResolveTable, resolveTable);
app.use(verifyJwt);
app.use("/admin/tables", admin);
app.use("/staff/tables", staff);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
let base: string;
before(async () => {
  if (!server.listening)
    await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});
type Role = "staff" | "manager" | "owner";
const token = "A".repeat(43);
const date = "2026-11-11T00:00:00.000Z";
const table = [1, "Table 1", token, 5, true, date, date];
const account = (role: Role = "manager", active = true) => [[role, active]];
function setup(...values: Reply[]) {
  replies = values;
  queries = [];
}
async function request(
  method: string,
  path: string,
  body?: unknown,
  role: Role | null = "manager",
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(role ? { authorization: `Bearer ${signAccessToken(1, role)}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString();
  const data = response.headers
    .get("content-type")
    ?.includes("application/json")
    ? JSON.parse(text)
    : text;
  assert.equal(replies.length, 0, "Unconsumed database replies");
  return { status: response.status, headers: response.headers, data, bytes };
}
const root = "/admin/tables";

test("all table admin actions reject unauthenticated, Staff and disabled users", async () => {
  for (const [method, path, body] of [
    ["GET", root, undefined],
    ["POST", root, { name: "Table 1" }],
    ["GET", root + "/1", undefined],
    ["PATCH", root + "/1", { active: false }],
    ["GET", root + "/1/qr", undefined],
    ["GET", root + "/qr-sheet", undefined],
  ] as const) {
    setup();
    assert.equal((await request(method, path, body, null)).status, 401);
    setup(account("staff"));
    assert.equal((await request(method, path, body, "staff")).status, 403);
    setup(account("manager", false));
    assert.equal((await request(method, path, body)).status, 401);
  }
  setup(account("staff"));
  assert.equal(
    (await request("POST", root, { name: "Table 1" }, "owner")).status,
    403,
  );
});

test("Managers and Owners create tables with generated tokens, defaults and customer URLs", async () => {
  const tokens: string[] = [];
  for (const role of ["manager", "owner"] as const) {
    setup(account(role), [table]);
    const result = await request("POST", root, { name: " Table 1 " }, role);
    assert.equal(result.status, 201);
    assert.equal(
      result.data.data.qrUrl,
      `https://order.example.test/order#table=${token}`,
    );
    const [, generated, limit, active] = queries[1].params;
    assert.equal(queries[1].params[0], "Table 1");
    assert.match(generated as string, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(limit, 5);
    assert.equal(active, true);
    tokens.push(generated as string);
  }
  assert.notEqual(tokens[0], tokens[1]);
});

test("table validation rejects malformed bodies, immutable fields and invalid queries", async () => {
  for (const body of [
    {},
    { name: " " },
    { name: "x", orderLimit: 0 },
    { name: "x", orderLimit: 1.5 },
    { name: "x", orderLimit: 2147483648 },
    { name: "x", active: "false" },
    { name: "x", qrToken: token },
  ]) {
    setup(account());
    assert.equal((await request("POST", root, body)).status, 400);
  }
  for (const body of [{}, { qrToken: token }, { id: 2 }, { active: null }]) {
    setup(account());
    assert.equal((await request("PATCH", root + "/1", body)).status, 400);
  }
  for (const query of ["?active=1", "?limit=101", "?offset=-1", "?other=x"]) {
    setup(account());
    assert.equal((await request("GET", root + query)).status, 400);
  }
  setup(account());
  assert.equal((await request("GET", root + "/1/qr?format=html")).status, 400);
});

test("partial edits preserve the QR token and support deactivation/reactivation", async () => {
  for (const active of [false, true]) {
    setup(account(), [[1, "Renamed", token, 7, active, date, date]]);
    const result = await request("PATCH", root + "/1", {
      name: " Renamed ",
      orderLimit: 7,
      active,
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.data.active, active);
    assert.equal(result.data.data.qrToken, token);
    assert.doesNotMatch(
      queries[1].text.split(" returning ")[0],
      /"qr_token"\s*=/,
    );
    assert.ok(queries[1].params.includes(active));
  }
  setup(account(), [table]);
  assert.equal((await request("GET", root + "/1")).data.data.name, "Table 1");
});

test("admin lists include QR details while Staff lists contain metadata only", async () => {
  setup(account(), [[1, "Table 1", 5, true, date, date, token]], [[1]]);
  const adminResult = await request(
    "GET",
    root + "?active=true&limit=1&offset=0",
  );
  assert.equal(adminResult.data.data[0].qrToken, token);
  assert.deepEqual(adminResult.data.pagination, {
    limit: 1,
    offset: 0,
    total: 1,
    hasMore: false,
  });
  assert.match(queries[1].text, /order by "shop_tables"\."id" asc/);
  assert.ok(queries[1].params.includes(true));
  setup(account("staff"), [[1, "Table 1", 5, false, date, date]], [[1]]);
  const staffResult = await request(
    "GET",
    "/staff/tables?active=false",
    undefined,
    "staff",
  );
  assert.equal(staffResult.status, 200);
  assert.equal(staffResult.data.data[0].active, false);
  assert.equal(staffResult.data.data[0].qrToken, undefined);
  assert.equal(staffResult.data.data[0].qrUrl, undefined);
  assert.doesNotMatch(queries[1].text, /qr_token/);
  assert.ok(queries[1].params.includes(false));
});

test("public resolution rejects malformed, unknown and inactive QR tokens", async () => {
  setup();
  assert.equal(
    (await request("POST", "/tables/resolve", {}, null)).status,
    400,
  );
  setup();
  const malformed = await request(
    "POST",
    "/tables/resolve",
    { token: "bad" },
    null,
  );
  assert.equal(malformed.status, 404);
  for (const rows of [[], [[1, "Table 1", 5, false]]]) {
    setup(rows);
    const result = await request("POST", "/tables/resolve", { token }, null);
    assert.equal(result.status, 404);
    assert.deepEqual(result.data, malformed.data);
  }
  setup([[1, "Table 1", 5, true]]);
  const valid = await request("POST", "/tables/resolve", { token }, null);
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.data.data, { id: 1, name: "Table 1", orderLimit: 5 });
  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /^select/);
});

test("QR downloads produce PNG/SVG attachments and inactive tables cannot download", async () => {
  setup(account(), [table]);
  const png = await request("GET", root + "/1/qr");
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.match(
    png.headers.get("content-disposition")!,
    /attachment; filename="?table-1\.png"?/,
  );
  assert.equal(png.bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.bytes.readUInt32BE(16), 512);
  setup(account(), [table]);
  const svg = await request("GET", root + "/1/qr?format=svg");
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get("content-type")!, /image\/svg\+xml/);
  assert.equal(svg.data, await qrSvg(token));
  assert.equal(new URL(tableUrl(token)).search, "");
  setup(account(), [[1, "Table 1", token, 5, false, date, date]]);
  assert.equal((await request("GET", root + "/1/qr")).status, 409);
});

test("print sheet escapes table names, embeds QR images and selects active tables", async () => {
  setup(account(), [[1, '<img src=x onerror="alert(1)">', token]]);
  const result = await request("GET", root + "/qr-sheet");
  assert.equal(result.status, 200);
  assert.match(
    result.headers.get("content-disposition")!,
    /enjoyer-table-qr-codes.html/,
  );
  assert.ok(
    result.data.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"),
  );
  assert.ok(!result.data.includes("<img src=x"));
  assert.ok(result.data.includes("data:image/svg+xml;base64,"));
  assert.deepEqual(queries[1].params, [true]);
  setup(account(), []);
  assert.match(
    (await request("GET", root + "/qr-sheet")).data,
    /No active tables/,
  );
});

test("invalid or missing IDs return 404 and unexpected DB failures stay generic", async () => {
  for (const id of ["0", "-1", "1e3", "2147483648", "abc"]) {
    setup(account());
    assert.equal((await request("GET", root + "/" + id)).status, 404);
  }
  setup(account(), []);
  assert.equal((await request("GET", root + "/1")).status, 404);
  setup(account(), new Error("private database details"));
  const result = await request("GET", root + "/1");
  assert.equal(result.status, 500);
  assert.doesNotMatch(JSON.stringify(result.data), /private database/);
});
