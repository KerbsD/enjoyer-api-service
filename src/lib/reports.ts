import {
  and, asc, desc, eq, exists, gte, ilike, lt, or, sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  orderItems, orders, shopTables,
} from "../db/schema.ts";
import { findOrders } from "./orders.ts";
import type { OrderView } from "./orders.ts";
import { fromCents, toCents } from "./money.ts";
import { zonedParts } from "./storeHours.ts";
import type { DashboardQuery, HistoryQuery } from "../validators/reports.ts";

export type DateRange = { from: string; to: string; start: Date; endExclusive: Date };
const pad2 = (value: number) => String(value).padStart(2, "0");
const formatDate = (date: Date) => `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
const shiftDate = (date: string, days: number) => {
  const [year, month, day] = date.split("-").map(Number);
  return formatDate(new Date(Date.UTC(year!, month! - 1, day! + days)));
};

// Resolve local wall-clock midnight to UTC. Iteration handles timezone offset
// changes on DST calendars; Manila itself does not observe DST.
export const localDateBoundary = (date: string, timeZone: string): Date => {
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year!, month! - 1, day!);
  let timestamp = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = zonedParts(new Date(timestamp), timeZone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    timestamp = target - (represented - Math.floor(timestamp / 1000) * 1000);
  }
  return new Date(timestamp);
};

export const resolveDateRange = (
  input: Pick<DashboardQuery, "period" | "from" | "to">,
  now: Date,
  timeZone: string,
): DateRange => {
  const todayParts = zonedParts(now, timeZone);
  const today = `${todayParts.year}-${pad2(todayParts.month)}-${pad2(todayParts.day)}`;
  let from = input.from;
  let to = input.to;
  if (!from || !to) {
    to = today;
    const days = input.period === "30days" ? 30 : input.period === "7days" ? 7 : 1;
    from = shiftDate(today, -(days - 1));
  }
  return {
    from,
    to,
    start: localDateBoundary(from, timeZone),
    endExclusive: localDateBoundary(shiftDate(to, 1), timeZone),
  };
};

const inRange = (range: DateRange): SQL => and(
  gte(orders.createdAt, range.start),
  lt(orders.createdAt, range.endExclusive),
)!;

export type Dashboard = {
  range: { from: string; to: string; timezone: string };
  totalOrders: number;
  revenue: string;
  paidOrders: number;
  unpaidOrders: number;
  statusBreakdown: { status: string; count: number }[];
  bestSellers: { menuItemId: number; name: string; quantity: number; revenue: string }[];
  peakHours: { hour: number; orders: number }[];
};

export const getDashboard = async (
  input: DashboardQuery,
  now: Date,
  timeZone: string,
): Promise<Dashboard> => {
  const range = resolveDateRange(input, now, timeZone);
  const filter = inRange(range);
  const [metrics, statuses, sellers, peaks] = await Promise.all([
    db.select({
      totalOrders: sql<number>`count(*)::int`,
      revenue: sql<string>`coalesce(sum(${orders.total}) filter (where ${orders.paymentStatus} = 'paid'), 0)::text`,
      paidOrders: sql<number>`count(*) filter (where ${orders.paymentStatus} = 'paid')::int`,
      unpaidOrders: sql<number>`count(*) filter (where ${orders.paymentStatus} = 'unpaid' and ${orders.status} not in ('cancelled', 'rejected'))::int`,
    }).from(orders).where(filter),
    db.select({ status: orders.status, count: sql<number>`count(*)::int` })
      .from(orders).where(filter).groupBy(orders.status).orderBy(orders.status),
    db.select({
      menuItemId: orderItems.menuItemId,
      name: orderItems.nameSnapshot,
      quantity: sql<number>`sum(${orderItems.quantity})::int`,
      revenue: sql<string>`sum(${orderItems.lineTotal})::text`,
    }).from(orderItems).innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(and(filter, sql`${orders.status} not in ('cancelled', 'rejected')`))
      .groupBy(orderItems.menuItemId, orderItems.nameSnapshot)
      .orderBy(desc(sql`sum(${orderItems.quantity})`), asc(orderItems.nameSnapshot))
      .limit(10),
    db.select({
      hour: sql<number>`extract(hour from (${orders.createdAt} at time zone ${timeZone}))::int`,
      count: sql<number>`count(*)::int`,
    }).from(orders).where(and(filter, sql`${orders.status} not in ('cancelled', 'rejected')`))
      // Group/order by the selected ordinal: each interpolation of the
      // timezone creates a different bind placeholder, which PostgreSQL treats
      // as a different expression even when the bound values happen to match.
      .groupBy(sql`1`)
      .orderBy(sql`1`),
  ]);
  return {
    range: { from: range.from, to: range.to, timezone: timeZone },
    totalOrders: metrics[0]?.totalOrders ?? 0,
    revenue: fromCents(toCents(metrics[0]?.revenue ?? "0.00")),
    paidOrders: metrics[0]?.paidOrders ?? 0,
    unpaidOrders: metrics[0]?.unpaidOrders ?? 0,
    statusBreakdown: statuses,
    bestSellers: sellers.map((item) => ({
      ...item, revenue: fromCents(toCents(item.revenue)),
    })),
    peakHours: Array.from({ length: 24 }, (_, hour) => ({
      hour, orders: peaks.find((peak) => peak.hour === hour)?.count ?? 0,
    })),
  };
};

export const findHistoricalOrders = async (input: HistoryQuery, range?: DateRange) => {
  const itemFilter = input.itemId === undefined ? undefined : exists(
    db.select({ one: sql`1` }).from(orderItems).where(and(
      eq(orderItems.orderId, orders.id), eq(orderItems.menuItemId, input.itemId),
    )),
  );
  const search = input.q === undefined ? undefined : or(
    ilike(orders.orderNumber, `%${input.q}%`),
    exists(db.select({ one: sql`1` }).from(shopTables).where(and(
      eq(shopTables.id, orders.tableId), ilike(shopTables.name, `%${input.q}%`),
    ))),
    exists(db.select({ one: sql`1` }).from(orderItems).where(and(
      eq(orderItems.orderId, orders.id), ilike(orderItems.nameSnapshot, `%${input.q}%`),
    ))),
  );
  const where = and(
    range ? inRange(range) : undefined,
    input.tableId === undefined ? undefined : eq(orders.tableId, input.tableId),
    input.status === undefined ? undefined : eq(orders.status, input.status),
    input.paymentStatus === undefined ? undefined : eq(orders.paymentStatus, input.paymentStatus),
    itemFilter,
    search,
  );
  const [rows, [count]] = await Promise.all([
    findOrders(where, input.limit, input.offset),
    db.select({ total: sql<number>`count(*)::int` }).from(orders).where(where),
  ]);
  const total = count?.total ?? 0;
  return { rows, pagination: { limit: input.limit, offset: input.offset, total, hasMore: input.offset + rows.length < total } };
};

export const exportRangeOrders = async (range: DateRange, offset: number, limit: number): Promise<OrderView[]> => {
  return findOrders(inRange(range), limit, offset);
};
