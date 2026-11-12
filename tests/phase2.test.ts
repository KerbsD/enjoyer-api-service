import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { drizzle } from "drizzle-orm/node-postgres";

// Real SQL generation, routing and validation; mocked pg replies. Rows are
// arrays because Drizzle reads node-postgres in rowMode: "array".
type Reply = unknown[][] | Error;
let replies: Reply[] = [];
let queries: { text: string; params: unknown[] }[] = [];
const client = {
  async query(config: { text: string } | string, params: unknown[] = []) {
    const text = typeof config === "string" ? config : config.text;
    queries.push({ text, params });
    if (["begin", "commit", "rollback"].includes(text)) return { rows: [] };
    assert.ok(replies.length, `Unexpected query: ${text}`);
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
      ACCESS_TOKEN_SECRET: "test-only-phase-two-secret-at-least-32-chars",
      CLIENT_URL: "https://admin.example.test",
      CUSTOMER_URL: "https://order.example.test",
    },
  },
});
mock.module("../src/lib/logger.ts", {
  namedExports: {
    securityLog() {},
    logger: { error() {}, info() {} },
    serializeError: () => ({}),
  },
});
const { default: adminSettings } =
  await import("../src/routes/settings/admin.ts");
const { default: adminStoreHours } =
  await import("../src/routes/storeHours/admin.ts");
const { default: adminHolidays } =
  await import("../src/routes/storeHours/holidays.ts");
const { getPublicStoreStatus } =
  await import("../src/controllers/storeHours/public.ts");
const { default: publicTables } = await import("../src/routes/tables/public.ts");
const { default: publicCart } = await import("../src/routes/cart/public.ts");
const { verifyJwt } = await import("../src/middlewares/verifyJwt.ts");
const { signAccessToken } = await import("../src/lib/tokens.ts");
const { default: errorHandler } =
  await import("../src/middlewares/errorHandler.ts");
const { resolveStoreStatus } = await import("../src/lib/storeHours.ts");
const { validateOptionSelection, summarizeCart } =
  await import("../src/lib/cart.ts");
const { toCents, fromCents } = await import("../src/lib/money.ts");

const app = express();
app.use(express.json());
app.get("/store/status", getPublicStoreStatus);
app.use("/tables/cart", publicCart);
app.use("/tables", publicTables);
app.use(verifyJwt);
app.use("/admin/settings", adminSettings);
app.use("/admin/store-hours", adminStoreHours);
app.use("/admin/holiday-overrides", adminHolidays);
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
const sessionId = "11111111-1111-4111-8111-111111111111";
const cartId = "22222222-2222-4222-8222-222222222222";
const date = new Date();
const account = (role: Role = "manager", active = true) => [[role, active]];
const settingRows = (values: Record<string, string>) =>
  Object.entries(values).map(([key, value]) => [key, value]);
const defaultSettings = settingRows({
  idle_timeout_minutes: "180",
  confirmation_expiry_minutes: "10",
  shop_timezone: "Asia/Manila",
});
const table = [1, "Table 1", 5, true];
const sessionRow = (
  status: "pending" | "open" = "pending",
  lastActivityAt = date,
) => [
  [
    sessionId,
    1,
    status,
    date,
    status === "open" ? date : null,
    lastActivityAt,
    null,
    null,
    null,
  ],
];
const cartRow = (version = 0) => [[cartId, sessionId, version, date, date]];
const menuItemRow = (id = 3, available = true, hidden = false) => [
  [id, available, hidden],
];
const cartItemRow = (
  id = 10,
  quantity = 2,
  note = "",
  menuItemId = 3,
  name = "Latte",
  price = "120.00",
  available = true,
  hidden = false,
) => [id, quantity, note, menuItemId, name, price, available, hidden];
const optionRow = (
  cartItemId = 10,
  id = 5,
  name = "Oat milk",
  priceDelta = "30.00",
  available = true,
  groupId = 2,
  groupName = "Milk substitution",
  groupSortOrder = 2,
  optionSortOrder = 0,
) => [
  cartItemId,
  id,
  name,
  priceDelta,
  available,
  groupId,
  groupName,
  groupSortOrder,
  optionSortOrder,
];
const itemOptionGroupRow = (
  optionId = 5,
  minSelections = 0,
  maxSelections = 1,
) => [
  2,
  "Milk substitution",
  minSelections,
  maxSelections,
  2,
  optionId,
  "Oat milk",
  "30.00",
  true,
  0,
];

function setup(...values: Reply[]) {
  replies = [...values];
  queries = [];
}
async function request(
  method: string,
  path: string,
  body?: unknown,
  options: { role?: Role | null; token?: string } = {},
) {
  const { role = "manager", token: tableToken } = options;
  const response = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(role ? { authorization: `Bearer ${signAccessToken(1, role)}` } : {}),
      ...(tableToken ? { "x-table-token": tableToken } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const data = response.headers
    .get("content-type")
    ?.includes("application/json")
    ? JSON.parse(text)
    : text;
  assert.equal(
    replies.length,
    0,
    `Unconsumed database replies after ${response.status}: ${text.slice(0, 300)}`,
  );
  return { status: response.status, data };
}

// ---------- Money and pure cart rules ----------

test("money conversions stay exact and reject malformed decimals", () => {
  assert.equal(toCents("350.00"), 35_000);
  assert.equal(toCents("0.05"), 5);
  assert.equal(toCents("99999999.99"), 9_999_999_999);
  assert.equal(fromCents(35_000), "350.00");
  assert.equal(fromCents(5), "0.05");
  for (const value of ["350.001", "-1.00", "1,000.00", "", "01.00"])
    assert.throws(() => toCents(value));
});

test("option selection enforces per-group minimums, maximums and availability", () => {
  const single = {
    id: 1,
    name: "Temperature",
    minSelections: 1,
    maxSelections: 1,
    options: [
      {
        id: 11,
        name: "Iced",
        priceDelta: "0.00",
        isAvailable: true,
        groupId: 1,
        groupName: "Temperature",
        groupSortOrder: 0,
        optionSortOrder: 0,
      },
      {
        id: 12,
        name: "Hot",
        priceDelta: "0.00",
        isAvailable: false,
        groupId: 1,
        groupName: "Temperature",
        groupSortOrder: 0,
        optionSortOrder: 1,
      },
    ],
  };
  const multi = {
    id: 2,
    name: "Sandwich extras",
    minSelections: 0,
    maxSelections: 2,
    options: [
      {
        id: 21,
        name: "Fries",
        priceDelta: "60.00",
        isAvailable: true,
        groupId: 2,
        groupName: "Sandwich extras",
        groupSortOrder: 1,
        optionSortOrder: 0,
      },
      {
        id: 22,
        name: "Slaw",
        priceDelta: "20.00",
        isAvailable: true,
        groupId: 2,
        groupName: "Sandwich extras",
        groupSortOrder: 1,
        optionSortOrder: 0,
      },
      {
        id: 23,
        name: "Pickles",
        priceDelta: "10.00",
        isAvailable: true,
        groupId: 2,
        groupName: "Sandwich extras",
        groupSortOrder: 1,
        optionSortOrder: 0,
      },
    ],
  };
  const groups = [single, multi];

  const missing = validateOptionSelection(groups, []);
  assert.equal(missing.ok, false);
  assert.equal(!missing.ok && missing.code, "OPTION_SELECTION_INVALID");
  assert.equal(!missing.ok && missing.groupId, 1);

  const tooMany = validateOptionSelection(groups, [11, 21, 22, 23]);
  assert.equal(tooMany.ok, false);
  assert.equal(!tooMany.ok && tooMany.selected, 3);

  const unavailable = validateOptionSelection(groups, [12]);
  assert.equal(unavailable.ok, false);
  assert.equal(!unavailable.ok && unavailable.code, "OPTION_UNAVAILABLE");

  const foreign = validateOptionSelection(groups, [11, 999]);
  assert.equal(foreign.ok, false);
  assert.equal(!foreign.ok && foreign.code, "OPTION_INVALID");

  const ok = validateOptionSelection(groups, [11, 21, 22]);
  assert.equal(ok.ok, true);
  assert.deepEqual(
    ok.ok && ok.options.map((option) => option.id),
    [11, 21, 22],
  );
});

test("cart totals use current prices, option deltas and quantities", () => {
  assert.deepEqual(
    summarizeCart([
      {
        quantity: 2,
        menuItem: {
          id: 1,
          name: "Latte",
          price: "120.00",
          isAvailable: true,
          isHidden: false,
        },
        options: [
          {
            id: 5,
            name: "Oat milk",
            priceDelta: "30.00",
            isAvailable: true,
            groupId: 2,
            groupName: "Milk",
            groupSortOrder: 0,
            optionSortOrder: 0,
          },
        ],
      },
    ]),
    { itemCount: 2, subtotal: "300.00", total: "300.00" },
  );
});

// ---------- Store status (pure) ----------

const weekly = (dayOfWeek: number, openTime: string, closeTime: string) => ({
  dayOfWeek,
  openTime: `${openTime}:00`,
  closeTime: `${closeTime}:00`,
  closed: false,
});

test("store status handles unconfigured, open, before open and holiday states", () => {
  const settings = {
    idleTimeoutMinutes: 180,
    confirmationExpiryMinutes: 10,
    shopTimezone: "Asia/Manila",
  };
  // 2026-11-09 is a Monday; Manila is UTC+8.
  const monday = new Date("2026-11-09T02:00:00.000Z"); // 10:00 local

  const open = resolveStoreStatus({
    now: monday,
    settings,
    weekly: [weekly(1, "08:00", "17:00")],
    holidays: [],
  });
  assert.equal(open.isOpen, true);
  assert.equal(open.closesAt, "2026-11-09T09:00:00.000Z"); // 17:00 local
  assert.equal(open.week.length, 7);
  assert.equal(open.week[0]?.date, "2026-11-09");
  assert.equal(open.week[1]?.closed, true); // configured schedule, Tuesday missing

  const early = resolveStoreStatus({
    now: new Date("2026-11-08T23:00:00.000Z"), // Monday 07:00 local
    settings,
    weekly: [weekly(1, "08:00", "17:00")],
    holidays: [],
  });
  assert.equal(early.isOpen, false);
  assert.equal(early.nextOpen, "2026-11-09T00:00:00.000Z"); // 08:00 local

  const closing = resolveStoreStatus({
    now: new Date("2026-11-09T09:00:00.000Z"), // exactly 17:00 local
    settings,
    weekly: [weekly(1, "08:00", "17:00")],
    holidays: [],
  });
  assert.equal(closing.isOpen, false);
  assert.equal(closing.nextOpen, "2026-11-16T00:00:00.000Z");

  const holiday = resolveStoreStatus({
    now: monday,
    settings,
    weekly: [weekly(1, "08:00", "17:00")],
    holidays: [
      { date: "2026-11-09", openTime: null, closeTime: null, closed: true },
    ],
  });
  assert.equal(holiday.isOpen, false);
  assert.equal(holiday.today.source, "holiday");
  assert.equal(holiday.nextOpen, "2026-11-16T00:00:00.000Z");

  const unconfigured = resolveStoreStatus({
    now: monday,
    settings,
    weekly: [],
    holidays: [],
  });
  assert.equal(unconfigured.isOpen, true);
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.closesAt, null);
  assert.equal(unconfigured.nextOpen, null);
});

// ---------- Settings ----------

test("settings require management permission and return defaults", async () => {
  setup(account("staff"));
  assert.equal(
    (await request("GET", "/admin/settings", undefined, { role: "staff" }))
      .status,
    403,
  );
  setup();
  assert.equal(
    (await request("GET", "/admin/settings", undefined, { role: null })).status,
    401,
  );

  setup(account(), defaultSettings);
  const result = await request("GET", "/admin/settings");
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.data, {
    idleTimeoutMinutes: 180,
    confirmationExpiryMinutes: 10,
    shopTimezone: "Asia/Manila",
  });
});

test("settings updates validate bounds and persist the change", async () => {
  for (const body of [
    {},
    { idleTimeoutMinutes: 0 },
    { idleTimeoutMinutes: 1_441 },
    { confirmationExpiryMinutes: 0 },
    { confirmationExpiryMinutes: 121 },
    { idleTimeoutMinutes: 30, extra: true },
  ]) {
    setup(account());
    assert.equal((await request("PATCH", "/admin/settings", body)).status, 400);
  }

  setup(
    account(),
    [],
    settingRows({
      idle_timeout_minutes: "240",
      confirmation_expiry_minutes: "10",
      shop_timezone: "Asia/Manila",
    }),
  );
  const result = await request("PATCH", "/admin/settings", {
    idleTimeoutMinutes: 240,
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.data.idleTimeoutMinutes, 240);
  assert.ok(
    queries.some((query) => query.params.includes("idle_timeout_minutes")),
  );
});

// ---------- Store hours and holidays ----------

test("store hours list every weekday and update one day", async () => {
  setup(account(), defaultSettings, [
    [1, 1, "08:00:00", "17:00:00", false, date, date],
  ]);
  const listed = await request("GET", "/admin/store-hours");
  assert.equal(listed.status, 200);
  assert.equal(listed.data.data.length, 7);
  assert.equal(listed.data.data[0].configured, false);
  assert.deepEqual(
    listed.data.data.filter((day: { configured: boolean }) => day.configured),
    [
      {
        dayOfWeek: 1,
        openTime: "08:00",
        closeTime: "17:00",
        closed: false,
        configured: true,
      },
    ],
  );

  setup(account(), [[2, 2, "09:00:00", "18:00:00", false, date, date]]);
  const updated = await request("PUT", "/admin/store-hours/2", {
    closed: false,
    openTime: "09:00",
    closeTime: "18:00",
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.data.dayOfWeek, 2);
  assert.equal(updated.data.data.openTime, "09:00");

  setup(account(), [[3, 3, null, null, true, date, date]]);
  const closed = await request("PUT", "/admin/store-hours/3", { closed: true });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.data.closed, true);
  assert.equal(closed.data.data.openTime, null);
});

test("store hour validation rejects overnight, missing and malformed values", async () => {
  for (const [day, body] of [
    ["7", { closed: true }],
    ["x", { closed: true }],
    ["1", { closed: true, openTime: "08:00" }],
    ["1", { closed: false }],
    ["1", { closed: false, openTime: "17:00", closeTime: "08:00" }],
    ["1", { closed: false, openTime: "8:00", closeTime: "17:00" }],
    ["1", { closed: false, openTime: "08:00", closeTime: "17:00", x: 1 }],
  ] as const) {
    setup(account());
    assert.equal(
      (await request("PUT", `/admin/store-hours/${day}`, body)).status,
      400,
    );
  }
});

test("holiday overrides list, upsert and delete by calendar date", async () => {
  setup(account(), [[1, "2026-12-25", null, null, true, date, date]], [[1]]);
  const listed = await request(
    "GET",
    "/admin/holiday-overrides?from=2026-12-01&to=2026-12-31",
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.data[0], {
    date: "2026-12-25",
    openTime: null,
    closeTime: null,
    closed: true,
  });
  assert.equal(listed.data.pagination.total, 1);

  setup(account(), [
    [2, "2026-12-31", "10:00:00", "14:00:00", false, date, date],
  ]);
  const upserted = await request("PUT", "/admin/holiday-overrides/2026-12-31", {
    closed: false,
    openTime: "10:00",
    closeTime: "14:00",
  });
  assert.equal(upserted.status, 200);
  assert.equal(upserted.data.data.openTime, "10:00");

  setup(account(), [["2026-12-25"]]);
  assert.equal(
    (await request("DELETE", "/admin/holiday-overrides/2026-12-25")).status,
    204,
  );
  setup(account(), []);
  assert.equal(
    (await request("DELETE", "/admin/holiday-overrides/2026-12-25")).status,
    404,
  );
  for (const dateValue of ["2026-02-30", "25-12-2026", "tomorrow"]) {
    setup(account());
    assert.equal(
      (
        await request(
          "DELETE",
          `/admin/holiday-overrides/${encodeURIComponent(dateValue)}`,
        )
      ).status,
      400,
    );
  }
});

test("public store status is available without login", async () => {
  setup(defaultSettings, [], []);
  const result = await request("GET", "/store/status", undefined, {
    role: null,
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.data.configured, false);
  assert.equal(result.data.data.isOpen, true);
  assert.equal(result.data.data.week.length, 7);
});

// ---------- Table opening ----------

test("opening a table creates a provisional session and empty cart", async () => {
  setup(
    defaultSettings,
    [table],
    [],
    sessionRow(),
    [],
    cartRow(0),
    cartRow(0),
    [],
  );
  const result = await request(
    "POST",
    "/tables/open",
    { token },
    { role: null },
  );
  assert.equal(result.status, 200);
  assert.equal(result.data.data.created, true);
  assert.equal(result.data.data.table.name, "Table 1");
  assert.equal(result.data.data.session.status, "pending");
  assert.equal(result.data.data.cart.version, 0);
  assert.deepEqual(result.data.data.cart.items, []);
  assert.equal(result.data.currency, "PHP");
});

test("opening again reuses the current session and cart", async () => {
  setup(
    defaultSettings,
    [table],
    sessionRow(),
    sessionRow(),
    cartRow(4),
    cartRow(4),
    [],
  );
  const result = await request(
    "POST",
    "/tables/open",
    { token },
    { role: null },
  );
  assert.equal(result.status, 200);
  assert.equal(result.data.data.created, false);
  assert.equal(result.data.data.cart.version, 4);
});

test("opening closes an idle session before creating a new one", async () => {
  const stale = new Date("2020-01-01T00:00:00.000Z");
  setup(
    defaultSettings,
    [table],
    sessionRow("pending", stale),
    [],
    [],
    sessionRow(),
    [],
    cartRow(0),
    cartRow(0),
    [],
  );
  const result = await request(
    "POST",
    "/tables/open",
    { token },
    { role: null },
  );
  assert.equal(result.status, 200);
  assert.equal(result.data.data.created, true);
});

test("table opening rejects inactive and unknown QR tokens", async () => {
  setup(defaultSettings, []);
  const unknown = await request(
    "POST",
    "/tables/open",
    { token },
    { role: null },
  );
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.code, "INVALID_TABLE_QR");

  setup(defaultSettings, [[1, "Table 1", 5, false]]);
  assert.equal(
    (await request("POST", "/tables/open", { token }, { role: null })).status,
    404,
  );
});

// ---------- Shared cart ----------

test("cart authentication requires a valid table token and live session", async () => {
  setup();
  const missing = await request("GET", "/tables/cart", undefined, {
    role: null,
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.code, "INVALID_TABLE_QR");

  setup([table], []);
  const noSession = await request("GET", "/tables/cart", undefined, {
    role: null,
    token,
  });
  assert.equal(noSession.status, 409);
  assert.equal(noSession.data.code, "TABLE_SESSION_REQUIRED");});

test("cart reads show current prices, options and server totals", async () => {
  setup(
    [table],
    sessionRow(),
    cartRow(3),
    cartRow(3),
    [cartItemRow()],
    [optionRow()],
  );
  const result = await request("GET", "/tables/cart", undefined, {
    role: null,
    token,
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.currency, "PHP");
  assert.equal(result.data.data.version, 3);
  assert.deepEqual(result.data.data.totals, {
    itemCount: 2,
    subtotal: "300.00",
    total: "300.00",
  });
  const line = result.data.data.items[0];
  assert.equal(line.menuItem.price, "120.00");
  assert.equal(line.unitPrice, "150.00");
  assert.equal(line.lineTotal, "300.00");
  assert.equal(line.options[0].name, "Oat milk");
});

test("cart adds merge matching lines and validate option rules", async () => {
  setup(
    [table],
    sessionRow(),
    cartRow(0),
    defaultSettings,
    sessionRow(),
    cartRow(0),
    menuItemRow(),
    [itemOptionGroupRow()],
    [[10, 1]],
    [[10, 5]],
    [],
    [],
    [],
    cartRow(1),
    [cartItemRow(10, 3, "", 3, "Latte", "120.00")],
    [optionRow(10)],
  );
  const result = await request(
    "POST",
    "/tables/cart/items",
    { menuItemId: 3, quantity: 2, optionIds: [5], version: 0 },
    { role: null, token },
  );
  assert.equal(result.status, 200);
  assert.equal(result.data.data.version, 1);
  assert.equal(result.data.data.items[0].quantity, 3);
  assert.equal(result.data.data.totals.total, "450.00");
  assert.ok(
    queries.some(
      (query) =>
        /update "cart_items"/.test(query.text) &&
        query.params.includes(3) &&
        !query.params.includes(2),
    ),
  );

  setup(
    [table],
    sessionRow(),
    cartRow(0),
    defaultSettings,
    sessionRow(),
    cartRow(0),
    menuItemRow(),
    [itemOptionGroupRow(5, 1, 1)],
  );
  const missingOption = await request(
    "POST",
    "/tables/cart/items",
    { menuItemId: 3, quantity: 1, optionIds: [], version: 0 },
    { role: null, token },
  );
  assert.equal(missingOption.status, 400);
  assert.equal(missingOption.data.code, "OPTION_SELECTION_INVALID");
  assert.equal(missingOption.data.details.groupId, 2);
});

test("stale cart versions return 409 with the latest cart", async () => {
  setup(
    [table],
    sessionRow(),
    cartRow(0),
    defaultSettings,
    sessionRow(),
    cartRow(5),
    cartRow(5),
    [],
  );
  const result = await request(
    "POST",
    "/tables/cart/items",
    { menuItemId: 3, quantity: 1, version: 0 },
    { role: null, token },
  );
  assert.equal(result.status, 409);
  assert.equal(result.data.code, "CART_VERSION_CONFLICT");
  assert.equal(result.data.data.version, 5);
});

test("cart edits reject malformed versions and unknown lines", async () => {
  for (const query of ["", "?version=-1", "?version=abc", "?version=1.5"]) {
    setup([table], sessionRow(), cartRow(0));
    assert.equal(
      (
        await request("DELETE", `/tables/cart${query}`, undefined, {
          role: null,
          token,
        })
      ).status,
      400,
    );
  }

  setup(
    [table],
    sessionRow(),
    cartRow(0),
    defaultSettings,
    sessionRow(),
    cartRow(0),
    [],
  );
  const missing = await request(
    "PATCH",
    "/tables/cart/items/99",
    { quantity: 2, version: 0 },
    { role: null, token },
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.data.code, "CART_ITEM_NOT_FOUND");
});

test("cart updates replace options and recalculate totals", async () => {
  setup(
    [table],
    sessionRow(),
    cartRow(0),
    defaultSettings,
    sessionRow(),
    cartRow(0),
    [[10, cartId, 3, 1, "", date, date]],
    menuItemRow(),
    [itemOptionGroupRow()],
    [],
    [],
    [],
    [],
    [],
    cartRow(1),
    [cartItemRow(10, 1, "", 3, "Latte", "120.00")],
    [optionRow(10)],
  );
  const result = await request(
    "PATCH",
    "/tables/cart/items/10",
    { quantity: 1, optionIds: [5], note: "", version: 0 },
    { role: null, token },
  );
  assert.equal(result.status, 200);
  assert.equal(result.data.data.version, 1);
  assert.deepEqual(result.data.data.totals, {
    itemCount: 1,
    subtotal: "150.00",
    total: "150.00",
  });
});

test("cart deletes remove one line or clear the whole cart", async () => {
  setup(
    [table],
    sessionRow(),
    cartRow(0),
    defaultSettings,
    sessionRow(),
    cartRow(0),
    [[10]],
    [],
    [],
    cartRow(1),
    [],
  );
  const removed = await request(
    "DELETE",
    "/tables/cart/items/10?version=0",
    undefined,
    { role: null, token },
  );
  assert.equal(removed.status, 200);
  assert.equal(removed.data.data.version, 1);
  assert.deepEqual(removed.data.data.items, []);

  setup(
    [table],
    sessionRow(),
    cartRow(1),
    defaultSettings,
    sessionRow(),
    cartRow(1),
    [],
    [],
    [],
    cartRow(2),
    [],
  );
  const cleared = await request("DELETE", "/tables/cart?version=1", undefined, {
    role: null,
    token,
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.data.version, 2);
  assert.deepEqual(cleared.data.data.totals, {
    itemCount: 0,
    subtotal: "0.00",
    total: "0.00",
  });
});

test("cart mutations close a session that outlived the idle timeout", async () => {
  const stale = new Date("2020-01-01T00:00:00.000Z");
  setup(
    [table],
    sessionRow("pending", stale),
    cartRow(0),
    defaultSettings,
    sessionRow("pending", stale),
    [],
    [],
  );
  const result = await request(
    "POST",
    "/tables/cart/items",
    { menuItemId: 3, quantity: 1, version: 0 },
    { role: null, token },
  );
  assert.equal(result.status, 409);
  assert.equal(result.data.code, "TABLE_SESSION_REQUIRED");
});
