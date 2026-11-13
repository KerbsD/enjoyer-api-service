import { and, asc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  orderItemOptions,
  orderItems,
  orderNumberCounters,
  orders,
  shopTables,
} from "../db/schema.ts";
import type {
  OrderStatus,
  OrderCancelledBy,
  PaymentMethod,
  PaymentStatus,
} from "../db/schema.ts";
import type { DbReader, DbTransaction } from "./cart.ts";
import { fromCents, toCents } from "./money.ts";
import { readShopSettings } from "./settings.ts";
import { zonedParts } from "./storeHours.ts";

// Cancelled and rejected orders never count toward the table limit, the
// customer's combined total, or staff table totals.
export const ORDER_COUNT_STATUSES: OrderStatus[] = [
  "pending_confirmation",
  "received",
  "preparing",
  "ready",
  "served",
];

export const isCountedOrder = (status: OrderStatus): boolean =>
  status !== "cancelled" && status !== "rejected";

// The customer may cancel only before the kitchen starts preparing.
export const CUSTOMER_CANCELLABLE_STATUSES: OrderStatus[] = [
  "pending_confirmation",
  "received",
];

// Staff move one step at a time. Going back from received would reopen the
// confirmation gate, so the reverse map intentionally stops at preparing.
export const NEXT_ORDER_STATUS: Partial<Record<OrderStatus, OrderStatus>> = {
  received: "preparing",
  preparing: "ready",
  ready: "served",
};

export const PREVIOUS_ORDER_STATUS: Partial<Record<OrderStatus, OrderStatus>> = {
  preparing: "received",
  ready: "preparing",
  served: "ready",
};

export const orderStatusConflict = (status: OrderStatus): string => {
  switch (status) {
    case "pending_confirmation":
      return "This order is waiting for staff confirmation.";
    case "received":
      return "This order has already been received.";
    case "preparing":
      return "This order is already being prepared.";
    case "ready":
      return "This order is already ready.";
    case "served":
      return "This order has already been served.";
    case "cancelled":
      return "This order has already been cancelled.";
    case "rejected":
      return "This order was rejected.";
  }
};

export type OrderItemOptionView = {
  id: number;
  name: string;
  groupName: string;
  priceDelta: string;
};

export type OrderItemView = {
  id: number;
  menuItemId: number;
  name: string;
  unitPrice: string;
  quantity: number;
  note: string;
  lineTotal: string;
  options: OrderItemOptionView[];
};

export type OrderView = {
  id: string;
  orderNumber: string;
  tableId: number;
  tableName: string;
  tableSessionId: string;
  status: OrderStatus;
  subtotal: string;
  total: string;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod | null;
  paidAt: string | null;
  confirmedAt: string | null;
  cancellationReason: string | null;
  cancelledAt: string | null;
  cancelledBy: OrderCancelledBy | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  items: OrderItemView[];
};

const orderColumns = {
  id: orders.id,
  orderNumber: orders.orderNumber,
  tableSessionId: orders.tableSessionId,
  tableId: orders.tableId,
  tableName: shopTables.name,
  status: orders.status,
  subtotal: orders.subtotal,
  total: orders.total,
  paymentStatus: orders.paymentStatus,
  paymentMethod: orders.paymentMethod,
  paidAt: orders.paidAt,
  confirmedAt: orders.confirmedAt,
  cancellationReason: orders.cancellationReason,
  cancelledAt: orders.cancelledAt,
  cancelledBy: orders.cancelledBy,
  rejectionReason: orders.rejectionReason,
  createdAt: orders.createdAt,
  updatedAt: orders.updatedAt,
};

type OrderRow = {
  id: string;
  orderNumber: string;
  tableSessionId: string;
  tableId: number;
  tableName: string;
  status: OrderStatus;
  subtotal: string;
  total: string;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod | null;
  paidAt: Date | null;
  confirmedAt: Date | null;
  cancellationReason: string | null;
  cancelledAt: Date | null;
  cancelledBy: OrderCancelledBy | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

// Loads lines and option snapshots for a batch of orders, then assembles the
// API views. Batched queries keep the staff board from issuing N+1 reads.
const hydrateOrders = async (rows: OrderRow[]): Promise<OrderView[]> => {
  if (rows.length === 0) return [];
  const orderIds = rows.map((row) => row.id);

  const itemRows = await db
    .select({
      id: orderItems.id,
      orderId: orderItems.orderId,
      menuItemId: orderItems.menuItemId,
      name: orderItems.nameSnapshot,
      unitPrice: orderItems.unitPriceSnapshot,
      quantity: orderItems.quantity,
      note: orderItems.note,
      lineTotal: orderItems.lineTotal,
    })
    .from(orderItems)
    .where(inArray(orderItems.orderId, orderIds))
    .orderBy(asc(orderItems.id));

  const itemIds = itemRows.map((row) => row.id);
  const optionRows = itemIds.length
    ? await db
        .select({
          id: orderItemOptions.id,
          orderItemId: orderItemOptions.orderItemId,
          name: orderItemOptions.nameSnapshot,
          groupName: orderItemOptions.groupNameSnapshot,
          priceDelta: orderItemOptions.priceDeltaSnapshot,
        })
        .from(orderItemOptions)
        .where(inArray(orderItemOptions.orderItemId, itemIds))
        .orderBy(asc(orderItemOptions.id))
    : [];

  const optionsByItem = new Map<number, OrderItemOptionView[]>();
  for (const row of optionRows) {
    const list = optionsByItem.get(row.orderItemId) ?? [];
    list.push({
      id: row.id,
      name: row.name,
      groupName: row.groupName,
      priceDelta: row.priceDelta,
    });
    optionsByItem.set(row.orderItemId, list);
  }

  const itemsByOrder = new Map<string, OrderItemView[]>();
  for (const row of itemRows) {
    const list = itemsByOrder.get(row.orderId) ?? [];
    list.push({
      id: row.id,
      menuItemId: row.menuItemId,
      name: row.name,
      unitPrice: row.unitPrice,
      quantity: row.quantity,
      note: row.note,
      lineTotal: row.lineTotal,
      options: optionsByItem.get(row.id) ?? [],
    });
    itemsByOrder.set(row.orderId, list);
  }

  return rows.map((row) => {
    const items = itemsByOrder.get(row.id) ?? [];
    return {
      id: row.id,
      orderNumber: row.orderNumber,
      tableId: row.tableId,
      tableName: row.tableName,
      tableSessionId: row.tableSessionId,
      status: row.status,
      subtotal: row.subtotal,
      total: row.total,
      paymentStatus: row.paymentStatus,
      paymentMethod: row.paymentMethod,
      paidAt: iso(row.paidAt),
      confirmedAt: iso(row.confirmedAt),
      cancellationReason: row.cancellationReason,
      cancelledAt: iso(row.cancelledAt),
      cancelledBy: row.cancelledBy,
      rejectionReason: row.rejectionReason,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
      items,
    };
  });
};

export const loadOrderView = async (id: string): Promise<OrderView | null> => {
  const rows = await db
    .select(orderColumns)
    .from(orders)
    .innerJoin(shopTables, eq(orders.tableId, shopTables.id))
    .where(eq(orders.id, id))
    .limit(1);
  return (await hydrateOrders(rows))[0] ?? null;
};

export const loadSessionOrders = async (
  sessionId: string,
): Promise<OrderView[]> => {
  const rows = await db
    .select(orderColumns)
    .from(orders)
    .innerJoin(shopTables, eq(orders.tableId, shopTables.id))
    .where(eq(orders.tableSessionId, sessionId))
    .orderBy(asc(orders.createdAt), asc(orders.id));
  return hydrateOrders(rows);
};

// Oldest first: the board should show the queue in the order it arrived.
export const findOrders = async (
  where: SQL | undefined,
  limit: number,
  offset: number,
): Promise<OrderView[]> => {
  const rows = await db
    .select(orderColumns)
    .from(orders)
    .innerJoin(shopTables, eq(orders.tableId, shopTables.id))
    .where(where)
    .orderBy(asc(orders.createdAt), asc(orders.id))
    .limit(limit)
    .offset(offset);
  return hydrateOrders(rows);
};

export const summarizeOrders = (
  views: Pick<OrderView, "status" | "total">[],
): { ordersUsed: number; total: string } => {
  let ordersUsed = 0;
  let total = 0;
  for (const view of views) {
    if (!isCountedOrder(view.status)) continue;
    ordersUsed += 1;
    total += toCents(view.total);
  }
  return { ordersUsed, total: fromCents(total) };
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

// Order numbers use the shop's local calendar day, not UTC: a 00:30 order in
// Manila belongs to that day's counter.
export const orderDateKey = (now: Date, timezone: string): string => {
  const local = zonedParts(now, timezone);
  return `${local.year}-${pad2(local.month)}-${pad2(local.day)}`;
};

export const orderNumberFromCounter = (
  dateKey: string,
  counter: number,
): string => `${dateKey}-${String(counter).padStart(3, "0")}`;

// Allocated inside the placement transaction. The upsert locks that day's row
// until commit, so two concurrent placements can never reuse a number.
export const allocateOrderNumber = async (
  tx: DbTransaction,
  now: Date,
  timezone: string,
): Promise<string> => {
  const dateKey = orderDateKey(now, timezone);
  const [row] = await tx
    .insert(orderNumberCounters)
    .values({ date: dateKey, counter: 1 })
    .onConflictDoUpdate({
      target: orderNumberCounters.date,
      set: { counter: sql`${orderNumberCounters.counter} + 1` },
    })
    .returning({ counter: orderNumberCounters.counter });
  if (!row) throw new Error("order number allocation returned no row");
  return orderNumberFromCounter(dateKey.replaceAll("-", ""), row.counter);
};

// Rejects unconfirmed first orders after the configured expiry. The session is
// left pending so the next order is again held for confirmation. The job does
// not touch lastActivityAt: expiry is a system action, not table activity.
export const expireUnconfirmedOrders = async (
  now = new Date(),
): Promise<number> => {
  const settings = await readShopSettings();
  const cutoff = new Date(
    now.getTime() - settings.confirmationExpiryMinutes * 60_000,
  );

  return db.transaction(async (tx) => {
    const stale = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.status, "pending_confirmation"),
          lt(orders.createdAt, cutoff),
        ),
      )
      // Deterministic lock order keeps two app instances from deadlocking.
      .orderBy(asc(orders.id))
      .for("update");
    if (stale.length === 0) return 0;

    await tx
      .update(orders)
      .set({
        status: "rejected",
        rejectionReason: "expired",
        updatedAt: now,
      })
      .where(
        inArray(
          orders.id,
          stale.map((order) => order.id),
        ),
      );
    return stale.length;
  });
};

// Used by staff endpoints that need the current unpaid state of one session.
export const unpaidTotalsForSession = async (
  tx: DbReader,
  sessionId: string,
): Promise<{ orderCount: number; total: string }> => {
  const [row] = await tx
    .select({
      orderCount: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(${orders.total}), 0)::text`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.tableSessionId, sessionId),
        eq(orders.paymentStatus, "unpaid"),
        notInArray(orders.status, ["cancelled", "rejected"]),
      ),
    );
  return {
    orderCount: row?.orderCount ?? 0,
    total: fromCents(toCents(row?.total ?? "0.00")),
  };
};
