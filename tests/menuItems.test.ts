import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { drizzle } from "drizzle-orm/node-postgres";

// Real SQL generation, JWT verification and HTTP handlers; mocked pg replies.
type Reply = unknown[][] | Error;
let replies: Reply[] = [];
let queries: { text: string; params: unknown[] }[] = [];
const client = {
  async query(config: { text: string } | string, params: unknown[] = []) {
    const text = typeof config === "string" ? config : config.text;
    queries.push({ text, params });
    if (["begin", "commit", "rollback"].includes(text)) return { rows: [] };
    assert.ok(replies.length, "Unexpected query");
    const result = replies.shift()!;
    if (result instanceof Error) throw result;
    return { rows: result };
  },
};
mock.module("../src/db/index.ts", {
  namedExports: { db: drizzle(client as never) },
});
mock.module("../src/configs/env.ts", {
  namedExports: {
    env: {
      NODE_ENV: "test",
      ACCESS_TOKEN_SECRET: "test-only-menu-secret-at-least-32-characters",
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
const { default: admin } = await import("../src/routes/menuItems/admin.ts");
const { default: staff } = await import("../src/routes/menuItems/staff.ts");
const { default: optionGroups } =
  await import("../src/routes/menuItems/optionGroups.ts");
const { handlePublicMenu } =
  await import("../src/controllers/menuItems/public.ts");
const { verifyJwt } = await import("../src/middlewares/verifyJwt.ts");
const { signAccessToken } = await import("../src/lib/tokens.ts");
const { default: errorHandler } =
  await import("../src/middlewares/errorHandler.ts");
const app = express();
app.use(express.json());
app.get("/menu", handlePublicMenu);
app.use(verifyJwt);
app.use("/admin/menu-items", admin);
app.use("/staff/menu-items", staff);
app.use("/admin/option-groups", optionGroups);
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
const date = "2026-11-11T00:00:00.000Z";
const item = [
  5,
  2,
  "Cheese Burger",
  "Angus beef",
  "350.00",
  false,
  true,
  false,
  0,
  date,
  date,
];
const account = (role: Role = "manager", active = true) => [[role, active]];
const body = { categoryId: 2, name: "Cheese Burger", price: "350.00" };
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
  assert.equal(replies.length, 0, "Unconsumed replies");
  return { status: res.status, data };
}
const root = "/admin/menu-items";

test("menu management rejects unauthenticated, Staff, inactive and stale-role callers", async () => {
  for (const [method, path, input] of [
    ["POST", root, body],
    ["GET", root, undefined],
    ["GET", root + "/5", undefined],
    ["PATCH", root + "/5", { price: 10 }],
  ] as const) {
    setup();
    assert.equal((await request(method, path, input, null)).status, 401);
    setup(account("staff"));
    assert.equal((await request(method, path, input, "staff")).status, 403);
    setup(account("manager", false));
    assert.equal((await request(method, path, input)).status, 401);
  }
  setup(account("staff"));
  assert.equal((await request("POST", root, body, "owner")).status, 403);
});
test("Manager and Owner create items with exact prices and defaults", async () => {
  for (const role of ["manager", "owner"] as const) {
    setup(account(role), [item]);
    const result = await request(
      "POST",
      root,
      { ...body, name: " Cheese Burger ", price: 350 },
      role,
    );
    assert.equal(result.status, 201);
    assert.equal(result.data.currency, "PHP");
    assert.equal(result.data.data.price, "350.00");
    assert.deepEqual(queries[1].params, [
      2,
      "Cheese Burger",
      "",
      "350.00",
      false,
      true,
      false,
      0,
    ]);
  }
  for (const [price, canonical] of [
    [0, "0.00"],
    [0.1, "0.10"],
    ["60.5", "60.50"],
    ["99999999.99", "99999999.99"],
  ] as const) {
    setup(account(), [item]);
    assert.equal((await request("POST", root, { ...body, price })).status, 201);
    assert.equal(queries[1].params[3], canonical);
  }
});
test("bad prices, fields and category IDs are rejected before writes", async () => {
  for (const patch of [
    { price: -1 },
    { price: "1.001" },
    { price: 0.1 + 0.2 },
    { price: "1e2" },
    { price: "100000000" },
    { price: null },
    { categoryId: 0 },
    { categoryId: "2" },
    { name: " " },
    { name: "x".repeat(101) },
    { description: "x".repeat(2001) },
    { isSpicy: "true" },
    { isHidden: 1 },
    { sortOrder: -1 },
    { sortOrder: 1.2 },
    { tags: ["Seasonal"] },
  ]) {
    setup(account());
    assert.equal(
      (await request("POST", root, { ...body, ...patch })).status,
      400,
    );
    assert.equal(queries.length, 1);
  }
  setup(account());
  assert.equal((await request("PATCH", root + "/5", {})).status, 400);
});
test("missing categories return a useful error on create and update", async () => {
  for (const [method, path] of [
    ["POST", root],
    ["PATCH", root + "/5"],
  ]) {
    setup(
      account(),
      Object.assign(new Error("foreign key failed"), {
        code: "23503",
        constraint: "menu_items_category_id_categories_id_fk",
      }),
    );
    const result = await request(method, path, body);
    assert.equal(result.status, 400);
    assert.equal(result.data.message, "Category does not exist.");
  }
});
test("admin list filters false flags explicitly and uses stable category/item order", async () => {
  setup(account(), [item], [[3]]);
  const result = await request(
    "GET",
    root + "?categoryId=2&isHidden=false&isAvailable=false&limit=1&offset=1",
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.pagination, {
    limit: 1,
    offset: 1,
    total: 3,
    hasMore: true,
  });
  assert.deepEqual(queries[1].params, [2, false, false, 1, 1]);
  assert.match(
    queries[1].text,
    /order by "categories"\."sort_order" asc, "categories"\."id" asc, "menu_items"\."sort_order" asc, "menu_items"\."id" asc/,
  );
  assert.deepEqual(queries[2].params, [2, false, false]);
  for (const query of [
    "?categoryId=0",
    "?categoryId=1e2",
    "?isHidden=1",
    "?isAvailable=yes",
    "?limit=101",
  ]) {
    setup(account());
    assert.equal((await request("GET", root + query)).status, 400);
  }
});
test("editing preserves omitted fields and accepts false, zero and empty description", async () => {
  setup(account(), [item]);
  assert.equal(
    (
      await request("PATCH", root + "/5", {
        isHidden: false,
        sortOrder: 0,
        description: "",
      })
    ).status,
    200,
  );
  const sql = queries[1].text.split(" where ")[0];
  assert.ok(!sql.includes('"price" ='));
  assert.ok(!sql.includes('"category_id" ='));
  assert.match(queries[1].text, /where "menu_items"\."id" = \$\d+/);
  assert.equal(queries[1].params.at(-1), 5);
  setup(account(), [item]);
  assert.equal((await request("GET", root + "/5")).data.data.categoryId, 2);
  for (const id of ["0", "abc", "2147483648"]) {
    setup(account());
    assert.equal(
      (await request("PATCH", root + "/" + id, { name: "Test" })).status,
      404,
    );
  }
  setup(account(), []);
  assert.equal((await request("GET", root + "/999")).status, 404);
  setup(account(), []);
  assert.equal(
    (await request("PATCH", root + "/999", { name: "Test" })).status,
    404,
  );
});
test("Staff can set availability but cannot smuggle price or visibility edits", async () => {
  const path = "/staff/menu-items/5/availability";
  for (const role of ["staff", "manager", "owner"] as const) {
    for (const isAvailable of [false, true]) {
      setup(account(role), [item]);
      assert.equal(
        (await request("PATCH", path, { isAvailable }, role)).status,
        200,
      );
      const sql = queries[1].text.split(" where ")[0];
      assert.match(sql, /"is_available" =/);
      assert.ok(!sql.includes('"price" ='));
      assert.equal(queries[1].params[0], isAvailable);
    }
  }
  for (const body of [
    {},
    { isAvailable: "false" },
    { isAvailable: false, price: 1 },
    { isAvailable: false, isHidden: true },
  ]) {
    setup(account("staff"));
    assert.equal((await request("PATCH", path, body, "staff")).status, 400);
  }
  setup();
  assert.equal(
    (await request("PATCH", path, { isAvailable: false }, null)).status,
    401,
  );
  setup(account("staff"), []);
  assert.equal(
    (await request("PATCH", path, { isAvailable: false }, "staff")).status,
    404,
  );
});
test("public menu needs no login, excludes hidden items and retains sold-out items", async () => {
  setup(
    [
      [2, "Sandwiches", 0, 5, "Cheese Burger", "", "350.00", false, false, 0],
      [2, "Sandwiches", 0, 6, "Chicken", "", "350.00", true, true, 1],
      [3, "Pastries", 1, 7, "Croissant", "", "130.00", false, true, 0],
    ],
    [[5, 1, "Sandwich extras", false, 0, 1, 0, 1, "Side Fries", "60.00", true, 0]],
  );
  const result = await request("GET", "/menu?isHidden=true", undefined, null);
  assert.equal(result.status, 200);
  assert.equal(result.data.currency, "PHP");
  assert.equal(result.data.data.length, 2);
  assert.equal(result.data.data[0].items.length, 2);
  assert.equal(result.data.data[0].items[0].isAvailable, false);
  assert.equal(result.data.data[0].items[1].isSpicy, true);
  assert.equal(result.data.data[0].items[0].isHidden, undefined);
  assert.equal(queries.length, 2);
  assert.equal(
    result.data.data[0].items[0].optionGroups[0].options[0].priceDelta,
    "60.00",
  );
  assert.deepEqual(result.data.data[0].items[1].optionGroups, []);
  const predicate = queries[0].text.split(" where ")[1].split(" order by ")[0];
  assert.equal(predicate, '"menu_items"."is_hidden" = $1');
  assert.deepEqual(queries[0].params, [false]);
  setup([]);
  assert.deepEqual(
    (await request("GET", "/menu", undefined, null)).data.data,
    [],
  );
});
test("unrelated database errors return a generic 500", async () => {
  setup(account(), new Error("private database error"));
  const result = await request("POST", root, body);
  assert.equal(result.status, 500);
  assert.equal(result.data.message, "Internal Server Error");
});

test("option groups require menu permission and validate choices", async () => {
  setup(account("staff"));
  assert.equal(
    (await request("GET", "/admin/option-groups", undefined, "staff")).status,
    403,
  );
  for (const input of [
    { name: "Temperature", options: [] },
    { name: "Milk", options: [{ name: "Oat", priceDelta: "1.001" }] },
  ]) {
    setup(account());
    assert.equal(
      (await request("POST", "/admin/option-groups", input)).status,
      400,
    );
  }
  setup(
    account(),
    [[1, "Temperature", true, 1, 1, 0]],
    [
      [1, 1, "Hot", "0.00", true, 0],
      [2, 1, "Iced", "0.00", true, 0],
    ],
  );
  const result = await request("POST", "/admin/option-groups", {
    name: "Temperature",
    required: true,
    options: [{ name: "Hot" }, { name: "Iced" }],
  });
  assert.equal(result.status, 201);
  assert.equal(result.data.data.maxSelections, 1);
  assert.equal(result.data.data.options.length, 2);
  assert.ok(queries.some((q) => q.text === "commit"));
});
test("failed option creation rolls back the group", async () => {
  setup(account(), [[1, "Milk", false, 0, 1, 0]], new Error("insert failed"));
  assert.equal(
    (
      await request("POST", "/admin/option-groups", {
        name: "Milk",
        options: [{ name: "Oat" }],
      })
    ).status,
    500,
  );
  assert.ok(queries.some((q) => q.text === "rollback"));
  assert.ok(!queries.some((q) => q.text === "commit"));
});
test("option edits target both option and group IDs and prices remain exact", async () => {
  setup(account(), [[3, 2, "Oat milk", "30.50", false, 0]]);
  const result = await request("PATCH", "/admin/option-groups/2/options/3", {
    priceDelta: "30.5",
    isAvailable: false,
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.data.priceDelta, "30.50");
  assert.deepEqual(queries[1].params, ["30.50", false, 3, 2]);
  setup(account(), []);
  assert.equal(
    (
      await request("PATCH", "/admin/option-groups/2/options/999", {
        name: "Unknown",
      })
    ).status,
    404,
  );
});
test("item assignments validate every group before replacing links", async () => {
  setup(account());
  assert.equal(
    (await request("PUT", root + "/5/option-groups", { groupIds: [1, 1] }))
      .status,
    400,
  );
  setup(account(), [[5]], [[1]]);
  assert.equal(
    (await request("PUT", root + "/5/option-groups", { groupIds: [1, 999] }))
      .status,
    400,
  );
  assert.ok(!queries.some((q) => q.text.startsWith("delete")));
  setup(account(), [[5]], [[1], [2]], [], []);
  assert.equal(
    (await request("PUT", root + "/5/option-groups", { groupIds: [1, 2] }))
      .status,
    200,
  );
  assert.ok(queries.some((q) => q.text.includes("for update")));
  assert.ok(queries.some((q) => q.text === "commit"));
  setup(account(), [[5]], []);
  assert.equal(
    (await request("PUT", root + "/5/option-groups", { groupIds: [] })).status,
    200,
  );
});
