import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import express from "express";

type Reply = unknown[][] | Error;
let replies: Reply[] = [];
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

const { resolveDateRange, localDateBoundary, getDashboard } = await import("../src/lib/reports.ts");
const { dashboardQuerySchema, historyQuerySchema, exportQuerySchema } = await import("../src/validators/reports.ts");
const { csvCell } = await import("../src/controllers/reports.ts");
const { dashboardRoute, historyRoute, exportRoute } = await import("../src/routes/reports/admin.ts");

test("report ranges use inclusive shop-local calendar dates and UTC half-open boundaries", () => {
  const now = new Date("2026-11-13T17:30:00.000Z"); // 2026-11-14 01:30 Manila
  const today = resolveDateRange({}, now, "Asia/Manila");
  assert.equal(today.from, "2026-11-14");
  assert.equal(today.to, "2026-11-14");
  assert.equal(today.start.toISOString(), "2026-11-13T16:00:00.000Z");
  assert.equal(today.endExclusive.toISOString(), "2026-11-14T16:00:00.000Z");

  const seven = resolveDateRange({ period: "7days" }, now, "Asia/Manila");
  assert.equal(seven.from, "2026-11-08");
  assert.equal(seven.to, "2026-11-14");
  const custom = resolveDateRange({ from: "2026-11-01", to: "2026-11-03" }, now, "Asia/Manila");
  assert.equal(custom.start.toISOString(), "2026-10-31T16:00:00.000Z");
  assert.equal(custom.endExclusive.toISOString(), "2026-11-03T16:00:00.000Z");
  assert.equal(localDateBoundary("2026-11-14", "Asia/Manila").toISOString(), today.start.toISOString());
});

test("report query validators require paired valid dates and reject contradictory filters", () => {
  assert.equal(dashboardQuerySchema.safeParse({ period: "30days" }).success, true);
  assert.equal(dashboardQuerySchema.safeParse({ from: "2026-11-01", to: "2026-11-30" }).success, true);
  for (const value of [
    { from: "2026-11-01" },
    { from: "2026-11-03", to: "2026-11-02" },
    { period: "today", from: "2026-11-01", to: "2026-11-02" },
    { period: "year" },
  ]) assert.equal(dashboardQuerySchema.safeParse(value).success, false);
  assert.equal(historyQuerySchema.safeParse({ itemId: "4", q: " Latte ", limit: "25" }).success, true);
  assert.equal(historyQuerySchema.safeParse({ paymentStatus: "unknown" }).success, false);
  assert.equal(exportQuerySchema.safeParse({ from: "2026-11-01", to: "2026-11-30" }).success, true);
  assert.equal(exportQuerySchema.safeParse({}).success, false);
});

test("dashboard reports paid revenue including paid-cancelled orders and shop-local peak hours", async () => {
  replies = [
    [[4, "950.00", 3, 1]],
    [["served", 2], ["cancelled", 1], ["rejected", 1]],
    [[7, "Latte", 5, "750.00"], [8, "Croissant", 2, "260.00"]],
    [[9, 3], [10, 2]],
  ];
  queries = [];
  const dashboard = await getDashboard(
    { period: "today" },
    new Date("2026-11-13T17:30:00.000Z"),
    "Asia/Manila",
  );
  assert.deepEqual(dashboard.range, { from: "2026-11-14", to: "2026-11-14", timezone: "Asia/Manila" });
  assert.equal(dashboard.totalOrders, 4);
  assert.equal(dashboard.revenue, "950.00");
  assert.equal(dashboard.paidOrders, 3);
  assert.equal(dashboard.unpaidOrders, 1);
  assert.deepEqual(dashboard.statusBreakdown, [
    { status: "served", count: 2 },
    { status: "cancelled", count: 1 },
    { status: "rejected", count: 1 },
  ]);
  assert.deepEqual(dashboard.bestSellers[0], {
    menuItemId: 7, name: "Latte", quantity: 5, revenue: "750.00",
  });
  assert.deepEqual(dashboard.peakHours[9], { hour: 9, orders: 3 });
  assert.deepEqual(dashboard.peakHours[10], { hour: 10, orders: 2 });
  assert.equal(dashboard.peakHours.length, 24);
  const metricsSql = queries[0]!.text;
  assert.match(metricsSql, /payment_status/);
  assert.match(metricsSql, /total/);
  assert.ok(queries.some((query) => query.text.includes("at time zone")));
  assert.equal(replies.length, 0);
});

test("CSV cells are quoted and spreadsheet formula prefixes are neutralized", () => {
  assert.equal(csvCell("plain, \"quoted\""), '"plain, ""quoted"""');
  assert.equal(csvCell("=1+1"), "\"'=1+1\"");
  assert.equal(csvCell("  @SUM(A1:A2)"), "\"'  @SUM(A1:A2)\"");
  assert.equal(csvCell("Enjoyer"), '"Enjoyer"');
  assert.equal(csvCell(null), '""');
});

test("report routes enforce their distinct manager permissions before querying", async (t) => {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 1, role: req.get("x-test-role") === "staff" ? "staff" : "manager" };
    next();
  });
  app.use("/admin/dashboard", dashboardRoute);
  app.use("/admin/orders", historyRoute);
  app.use("/admin/exports", exportRoute);
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  for (const path of ["/admin/dashboard", "/admin/orders", "/admin/exports/orders.csv?from=2026-11-01&to=2026-11-02"]) {
    const before = queries.length;
    const response = await fetch(base + path, { headers: { "x-test-role": "staff" } });
    assert.equal(response.status, 403);
    assert.equal(queries.length, before, "forbidden request must not query reports");
  }

  replies = [[ ["shop_timezone", "Asia/Manila"] ], []];
  const exported = await fetch(`${base}/admin/exports/orders.csv?from=2026-11-01&to=2026-11-02`, {
    headers: { "x-test-role": "manager" },
  });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-type")!, /^text\/csv/);
  assert.match(exported.headers.get("content-disposition")!, /enjoyer-orders-2026-11-01-to-2026-11-02\.csv/);
  assert.match(await exported.text(), /"Order ID".*"Cancelled"/);
  assert.equal(replies.length, 0);
});
