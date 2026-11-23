import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
    if (["begin", "begin isolation level repeatable read read only", "commit", "rollback"].includes(text))
      return { rows: [] };
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
const { default: publicOrders } = await import("../src/routes/orders/public.ts");
const { verifyJwt } = await import("../src/middlewares/verifyJwt.ts");
const { signAccessToken } = await import("../src/lib/tokens.ts");
const { default: errorHandler } =
  await import("../src/middlewares/errorHandler.ts");
const { resolveStoreStatus } = await import("../src/lib/storeHours.ts");
const { listStaffOrders } = await import("../src/controllers/orders/staff.ts");
const { listStaffOrdersQuerySchema } = await import("../src/validators/orders.ts");
const { validateOptionSelection, summarizeCart } =
  await import("../src/lib/cart.ts");
const { toCents, fromCents } = await import("../src/lib/money.ts");
const {
  orderDateKey,
  orderNumberFromCounter,
  NEXT_ORDER_STATUS,
  PREVIOUS_ORDER_STATUS,
  isCountedOrder,
} = await import("../src/lib/orders.ts");

const app = express();
app.use(express.json());
app.get("/store/status", getPublicStoreStatus);
app.use("/tables/cart", publicCart);
app.use("/tables/orders", publicOrders);
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
  id = sessionId,
) => [
  [
    id,
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
const checkout = {
  cartId, version: 0, requestId: "55555555-5555-4555-8555-555555555555", total: "300.00",
  reviewFingerprint: createHash("sha256").update(JSON.stringify([
    [10, 3, "Latte", "120.00", 2, "less ice", "150.00", "300.00", [
      [5, 2, "Milk substitution", "Oat milk", "30.00"],
    ]],
  ])).digest("hex"),
};
const submitOrder = (body: unknown = checkout) =>
  request("POST", "/tables/orders", body, { role: null, token });
const orderRow = (status: "received" | "pending_confirmation") => [
  checkout.requestId, "20261119-001", sessionId, 1, "Table 1", status, "300.00", "300.00",
  "unpaid", null, null, null, null, null, null, null, date, date,
];
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

test("order numbers use the shop-local calendar day and a padded daily counter", () => {
  // 16:30 UTC is already the next calendar day in Manila.
  const instant = new Date("2026-11-12T16:30:00.000Z");
  const localDate = orderDateKey(instant, "Asia/Manila");
  assert.equal(localDate, "2026-11-13");
  assert.equal(orderNumberFromCounter(localDate.replaceAll("-", ""), 1), "20261113-001");
  assert.equal(orderNumberFromCounter("20261113", 1200), "20261113-1200");
});

test("order lifecycle allows only one-step moves and excludes cancelled/rejected from limits", () => {
  assert.equal(NEXT_ORDER_STATUS.received, "preparing");
  assert.equal(NEXT_ORDER_STATUS.preparing, "ready");
  assert.equal(NEXT_ORDER_STATUS.ready, "served");
  assert.equal(NEXT_ORDER_STATUS.pending_confirmation, undefined);
  assert.equal(PREVIOUS_ORDER_STATUS.served, "ready");
  assert.equal(PREVIOUS_ORDER_STATUS.received, undefined);
  assert.equal(isCountedOrder("pending_confirmation"), true);
  assert.equal(isCountedOrder("cancelled"), false);
  assert.equal(isCountedOrder("rejected"), false);
});

test("active-session order filter excludes closed visits without changing default lists", async () => {
  assert.equal(
    listStaffOrdersQuerySchema.safeParse({
      status: "served",
      activeSessionOnly: "true",
      limit: "100",
      offset: "0",
    }).success,
    true,
  );
  const query = {
    status: "served",
    activeSessionOnly: true,
    limit: 100,
    offset: 0,
  };
  let result: unknown;
  const res = {
    locals: { query },
    json(value: unknown) {
      result = value;
      return this;
    },
  };
  queries = [];
  replies = [[], [[0]]];
  await listStaffOrders({} as never, res as never);
  assert.equal((result as { pagination: { total: number } }).pagination.total, 0);
  assert.equal(queries.length, 2);
  for (const statement of queries) {
    assert.match(statement.text, /table_sessions/);
    assert.ok(statement.params.includes("closed"));
  }

  queries = [];
  replies = [[], [[0]]];
  res.locals.query.activeSessionOnly = false;
  await listStaffOrders({} as never, res as never);
  for (const statement of queries)
    assert.doesNotMatch(statement.text, /table_sessions/);
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

test("resuming reuses the exact remembered session without creating or joining", async () => {
  setup(
    defaultSettings,
    [table],
    sessionRow(),
    cartRow(4),
    sessionRow(),
    [],
  );
  const result = await request(
    "POST",
    "/tables/resume",
    { token, sessionId },
    { role: null },
  );
  assert.equal(result.status, 200);
  assert.equal(result.data.data.session.id, sessionId);
  assert.equal(result.data.data.cart.id, cartId);
  assert.equal(result.data.data.cart.version, 4);
  assert.equal(result.data.data.cart.items.length, 0);
  assert.ok(
    queries.some(({ text }) =>
      text.startsWith('update "table_sessions" set "last_activity_at"'),
    ),
  );
  assert.ok(!queries.some(({ text }) => /^(insert|delete)\b/.test(text)));
});

test("resuming never adopts a replacement session", async () => {
  const replacementSessionId = "33333333-3333-4333-8333-333333333333";
  setup(
    defaultSettings,
    [table],
    sessionRow("pending", date, replacementSessionId),
  );
  const result = await request(
    "POST",
    "/tables/resume",
    { token, sessionId },
    { role: null },
  );
  assert.equal(result.status, 409);
  assert.equal(result.data.code, "TABLE_SESSION_REQUIRED");
  assert.equal(result.data.data, undefined);
  assert.ok(!queries.some(({ text }) => /^(insert|update|delete)\b/.test(text)));
});

test("resuming an expired visit requires a new visit", async () => {
  setup(
    defaultSettings,
    [table],
    sessionRow("pending", new Date("2020-01-01T00:00:00.000Z")),
  );
  const result = await request(
    "POST",
    "/tables/resume",
    { token, sessionId },
    { role: null },
  );
  assert.equal(result.status, 409);
  assert.equal(result.data.code, "TABLE_SESSION_REQUIRED");
  assert.ok(!queries.some(({ text }) => /^(insert|update|delete)\b/.test(text)));
});

test("resuming validates the session ID and table token", async () => {
  setup();
  for (const body of [
    { token, sessionId: "not-a-uuid" },
    { token, sessionId: "11111111-1111-1111-1111-111111111111" },
    { sessionId },
  ]) {
    assert.equal(
      (await request("POST", "/tables/resume", body, { role: null })).status,
      400,
    );
  }

  setup(defaultSettings, []);
  const unknown = await request(
    "POST",
    "/tables/resume",
    { token, sessionId },
    { role: null },
  );
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.code, "INVALID_TABLE_QR");
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

// ---------- Order placement ----------

test("checkout rejects a replacement cart under lock, even at the same version", async () => {
  const replacement = [["33333333-3333-4333-8333-333333333333", sessionId, 0, date, date]];
  setup([table], sessionRow(), cartRow(), defaultSettings, [], [], sessionRow(), replacement);
  const result = await submitOrder();
  assert.equal(result.status, 409);
  assert.equal(result.data.code, "TABLE_SESSION_REQUIRED");
  assert.ok(queries.some(({ text }) => /from "carts".*for update/.test(text)));
  assert.ok(queries.every(({ text }) => !/^(insert|update|delete)\b/.test(text)));
});

test("checkout enforces pending, limit, empty and unavailable gates without changing the cart", async () => {
  for (const [code, responses] of [
    ["ORDER_AWAITING_CONFIRMATION", [[[checkout.requestId]]]],
    ["ORDER_LIMIT_REACHED", [[], [[5]]]],
    ["CART_EMPTY", [[], [[0]], []]],
    ["MENU_ITEM_UNAVAILABLE", [[], [[0]], [cartItemRow(10, 2, "", 3, "Latte", "120.00", false)], []]],
    ["OPTION_SELECTION_INVALID", [[], [[0]], [cartItemRow()], [], [itemOptionGroupRow(5, 1)]]],
  ] satisfies [string, Reply[]][]) {
    setup([table], sessionRow(), cartRow(), defaultSettings, [], [], sessionRow(), cartRow(), [], ...responses);
    const result = await submitOrder();
    assert.ok([400, 409].includes(result.status), code);
    assert.equal(result.data.code, code);
    assert.ok(queries.every(({ text }) => !/^(insert|update|delete)\b/.test(text)));
  }
});

test("checkout rejects a closed shop and changed details even when version and total match", async () => {
  setup(
    [table], sessionRow(), cartRow(), defaultSettings,
    Array.from({ length: 7 }, (_, day) => [day, null, null, true, date]),
    [], sessionRow(), cartRow(), [],
  );
  const closed = await submitOrder();
  assert.equal(closed.data.code, "STORE_CLOSED");
  assert.ok(queries.every(({ text }) => !/^(insert|update|delete)\b/.test(text)));

  setup(
    [table], sessionRow(), cartRow(), defaultSettings, [], [], sessionRow(), cartRow(), [], [], [[0]],
    [cartItemRow(10, 2, "less ice", 3, "Renamed Latte")], [optionRow()], [itemOptionGroupRow()],
    cartRow(), [cartItemRow(10, 2, "less ice", 3, "Renamed Latte")], [optionRow()],
  );
  const changed = await submitOrder();
  assert.equal(changed.status, 409);
  assert.equal(changed.data.code, "CART_VERSION_CONFLICT");
  assert.equal(changed.data.data.totals.total, "300.00");
  assert.notEqual(changed.data.data.reviewFingerprint, checkout.reviewFingerprint);
  assert.ok(queries.every(({ text }) => !/^(insert|update|delete)\b/.test(text)));
});

test("checkout snapshots the order and clears the cart in the same transaction", async () => {
  for (const [sessionStatus, orderStatus] of [
    ["pending", "pending_confirmation"],
    ["open", "received"],
  ] as const) {
    setup(
      [table], sessionRow(sessionStatus), cartRow(), defaultSettings, [], [],
      sessionRow(sessionStatus), cartRow(), [], [], [[0]],
      [cartItemRow(10, 2, "less ice")], [optionRow()], [itemOptionGroupRow()],
      [[1]], [[checkout.requestId]], [[20]], [], [], [], [],
      [orderRow(orderStatus)], [[20, checkout.requestId, 3, "Latte", "120.00", 2, "less ice", "300.00"]],
      [[30, 20, "Oat milk", "Milk substitution", "30.00"]], cartRow(1), [],
    );
    const result = await submitOrder();
    assert.equal(result.status, 201);
    assert.equal(result.data.data.order.status, orderStatus);
    assert.equal(result.data.data.order.items[0].note, "less ice");
    assert.equal(result.data.data.order.items[0].options[0].priceDelta, "30.00");
    assert.equal(result.data.data.cart.version, 1);
    assert.deepEqual(result.data.data.cart.items, []);
    assert.equal(result.data.data.summary.ordersRemaining, 4);
    const insert = queries.findIndex(({ text }) => text.startsWith('insert into "orders"'));
    const clear = queries.findIndex(({ text }) => text.startsWith('delete from "cart_items"'));
    assert.ok(insert > 0 && clear > insert && queries.findIndex(({ text }) => text === "commit") > clear);
    assert.ok(queries[insert].params.includes(checkout.requestId));
    assert.ok(queries[insert].params.includes(orderStatus));
    assert.ok(queries.find(({ text }) => text.startsWith('insert into "order_items"'))?.params.includes("less ice"));
  }
});

test("retrying a committed order returns its receipt without rewriting a newer cart", async () => {
  setup(
    [table], sessionRow(), cartRow(2), defaultSettings, [], [],
    sessionRow(), cartRow(2), [[checkout.requestId]], [[1]],
    [orderRow("pending_confirmation")], [], cartRow(2), [],
  );
  const replay = await submitOrder();
  assert.equal(replay.status, 200);
  assert.equal(replay.data.data.order.id, checkout.requestId);
  assert.equal(replay.data.data.cart.version, 2);
  assert.ok(queries.every(({ text }) => !/^(insert|update|delete)\b/.test(text)));
});

test("resolution fences off a delayed placement without clearing its cart", async () => {
  setup([table], sessionRow(), cartRow(), defaultSettings, sessionRow(), cartRow(), [], []);
  const closed = await submitOrder({ ...checkout, resolveOnly: true });
  assert.equal(closed.status, 409);
  assert.equal(closed.data.code, "ORDER_ATTEMPT_CLOSED");
  assert.equal(queries.filter(({ text }) => text.startsWith('update "carts"')).length, 1);
  assert.ok(queries.every(({ text }) => !/^(insert|delete)\b/.test(text)));

  setup([table], sessionRow(), cartRow(1), defaultSettings, [], [], sessionRow(), cartRow(1), [], cartRow(1), [cartItemRow()], [optionRow()]);
  const delayed = await submitOrder();
  assert.equal(delayed.data.code, "CART_VERSION_CONFLICT");
  assert.equal(delayed.data.data.items.length, 1);
  assert.ok(queries.every(({ text }) => !/^(insert|update|delete)\b/.test(text)));
});

test("resolution returns a committed receipt instead of fencing a newer cart", async () => {
  setup(
    [table], sessionRow(), cartRow(1), defaultSettings, sessionRow(), cartRow(1),
    [[checkout.requestId]], [[1]], [orderRow("pending_confirmation")], [], cartRow(1), [],
  );
  const placed = await submitOrder({ ...checkout, resolveOnly: true });
  assert.equal(placed.status, 200);
  assert.equal(placed.data.data.order.id, checkout.requestId);
  assert.ok(queries.every(({ text }) => !/^(insert|update|delete)\b/.test(text)));
});

// ---------- Table order tracking ----------

test("a remembered visit cannot list or cancel orders in its replacement", async () => {
  const staleId = "33333333-3333-4333-8333-333333333333";
  for (const method of ["GET", "POST"]) {
    setup([table], sessionRow(), cartRow());
    const path = method === "GET" ? "/tables/orders" : `/tables/orders/${checkout.requestId}/cancel`;
    const result = await request(method, `${path}?sessionId=${staleId}`, undefined, { role: null, token });
    assert.equal(result.status, 409);
    assert.equal(result.data.code, "TABLE_SESSION_REQUIRED");
    assert.equal(result.data.data, undefined);
    assert.ok(queries.every(({ text }) => !text.includes('from "orders"')));
  }
});

test("tracking snapshots current orders and excludes cancelled totals and capacity", async () => {
  const cancelled = orderRow("received");
  cancelled[0] = "33333333-3333-4333-8333-333333333333";
  cancelled[5] = "cancelled";
  setup([table], sessionRow("open"), cartRow(), defaultSettings, sessionRow("open"),
    [orderRow("received"), cancelled], [],);
  const result = await request("GET", `/tables/orders?sessionId=${sessionId}`, undefined, { role: null, token });
  assert.equal(result.status, 200);
  assert.equal(result.data.data.session.id, sessionId);
  assert.equal(result.data.data.orders.length, 2);
  assert.equal(result.data.data.summary.total, "300.00");
  assert.equal(result.data.data.summary.ordersRemaining, 4);
  assert.ok(queries.some(({ text }) => text === "begin isolation level repeatable read read only"));
});

test("cancellation checks the locked status and never revives an expired visit", async () => {
  const path = `/tables/orders/${checkout.requestId}/cancel?sessionId=${sessionId}`;
  for (const [status, session, code] of [
    ["preparing", sessionRow("open"), "ORDER_NOT_CANCELLABLE"],
    ["received", sessionRow("open", new Date("2020-01-01")), "TABLE_SESSION_REQUIRED"],
  ] as const) {
    setup([table], sessionRow("open"), cartRow(), defaultSettings, [[checkout.requestId, status]], session);
    const rejected = await request("POST", path, undefined, { role: null, token });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.data.code, code);
    assert.ok(queries.every(({ text }) => !text.startsWith("update")));
  }
});

test("cancelling a live received order changes its status without returning items to the cart", async () => {
  const cancelled = orderRow("received");
  cancelled[5] = "cancelled";
  setup([table], sessionRow("open"), cartRow(), defaultSettings, [[checkout.requestId, "received"]],
    sessionRow("open"), [], [], [cancelled], []);
  const path = `/tables/orders/${checkout.requestId}/cancel?sessionId=${sessionId}`;
  const result = await request("POST", path, undefined, { role: null, token });
  assert.equal(result.status, 200);
  assert.equal(result.data.data.status, "cancelled");
  assert.ok(queries.some(({ text, params }) => text.startsWith('update "orders"') && params.includes("cancelled")));
  assert.ok(queries.every(({ text }) => !/^(insert|update|delete).*cart/.test(text)));
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
  const start = queries.findIndex(({ text }) => text === "begin isolation level repeatable read read only");
  assert.notEqual(start, -1);
  assert.deepEqual(
    queries.slice(start + 1, start + 4).map(({ text }) => text.match(/ from "([^"]+)"/)?.[1]),
    ["carts", "cart_items", "cart_item_options"],
  );
  assert.equal(queries[start + 4]?.text, "commit");
});

test("a cart removed before the snapshot requires a new visit", async () => {
  setup([table], sessionRow(), cartRow(0), []);
  const result = await request("GET", "/tables/cart", undefined, { role: null, token });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, "TABLE_SESSION_REQUIRED");
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
    { menuItemId: 3, quantity: 2, optionIds: [5], cartId, version: 0 },
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
    { menuItemId: 3, quantity: 1, optionIds: [], cartId, version: 0 },
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
    { menuItemId: 3, quantity: 1, cartId, version: 0 },
    { role: null, token },
  );
  assert.equal(result.status, 409);
  assert.equal(result.data.code, "CART_VERSION_CONFLICT");
  assert.equal(result.data.data.version, 5);
});

test("cart writes reject missing cart IDs, malformed versions and unknown lines", async () => {
  for (const query of [
    "?version=0",
    "?cartId=invalid&version=0",
    ...["-1", "abc", "1.5"].map((version) => `?cartId=${cartId}&version=${version}`),
  ]) {
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
  for (const [method, path, value] of [
    ["POST", "/tables/cart/items", { menuItemId: 3, version: 0 }],
    ["PATCH", "/tables/cart/items/99", { quantity: 2, version: 0 }],
  ] as const) {
    setup([table], sessionRow(), cartRow(0));
    assert.equal((await request(method, path, value, { role: null, token })).status, 400);
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
    { quantity: 2, cartId, version: 0 },
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
    { quantity: 1, optionIds: [5], note: "", cartId, version: 0 },
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
    `/tables/cart/items/10?cartId=${cartId}&version=0`,
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
  const cleared = await request("DELETE", `/tables/cart?cartId=${cartId}&version=1`, undefined, {
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

test("all cart writes reject a different locked cart even if the version matches", async () => {
  const replacementCartId = "33333333-3333-4333-8333-333333333333";
  const replacementCart = [[replacementCartId, sessionId, 0, date, date]];
  for (const [method, path, body] of [
    ["POST", "/tables/cart/items", { menuItemId: 3, cartId, version: 0 }],
    ["PATCH", "/tables/cart/items/10", { quantity: 1, cartId, version: 0 }],
    ["DELETE", `/tables/cart/items/10?cartId=${cartId}&version=0`, undefined],
    ["DELETE", `/tables/cart?cartId=${cartId}&version=0`, undefined],
  ] as const) {
    setup([table], sessionRow(), cartRow(0), defaultSettings, sessionRow(), replacementCart);
    const result = await request(method, path, body, { role: null, token });
    assert.equal(result.status, 409, `${method} ${path}`);
    assert.equal(result.data.code, "TABLE_SESSION_REQUIRED");
    assert.equal(result.data.data, undefined);
    assert.ok(queries.some(({ text }) => /from "carts".*for update/.test(text)));
    assert.ok(!queries.some(({ text }) => /^(insert|update|delete)\b/.test(text)));
    assert.equal(replies.length, 0);
  }
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
    { menuItemId: 3, quantity: 1, cartId, version: 0 },
    { role: null, token },
  );
  assert.equal(result.status, 409);
  assert.equal(result.data.code, "TABLE_SESSION_REQUIRED");
});
