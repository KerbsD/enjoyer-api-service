import { and, eq, notInArray, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db/index.ts";
import { carts, orders, shopTables, tableSessions } from "../../db/schema.ts";
import { CURRENCY } from "../../configs/currency.ts";
import { parseUuid } from "../../lib/helpers.ts";
import type { DbTransaction } from "../../lib/cart.ts";
import {
  findOrders,
  loadOrderView,
  loadSessionOrders,
  NEXT_ORDER_STATUS,
  orderStatusConflict,
  PREVIOUS_ORDER_STATUS,
  summarizeOrders,
  unpaidTotalsForSession,
} from "../../lib/orders.ts";
import { currentUser } from "../../middlewares/requirePermission.ts";
import { can } from "../../lib/permissions.ts";
import { parseId } from "../../lib/helpers.ts";
import type {
  CancelOrderInput,
  ListStaffOrdersQuery,
  MarkOrderPaidInput,
  RejectOrderInput,
  CloseTableInput,
} from "../../validators/orders.ts";

type ErrorFailure = {
  kind: "error";
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

type MutationResult =
  | ErrorFailure
  | { kind: "not-found" }
  | { kind: "ok"; id: string };

const orderNotFound = (res: Response) =>
  res.status(404).json({
    success: false,
    code: "ORDER_NOT_FOUND",
    message: "Order not found.",
  });

const statusConflict = (message: string, code = "ORDER_STATUS_CONFLICT") =>
  ({
    kind: "error",
    status: 409,
    code,
    message,
  }) satisfies ErrorFailure;

const sendMutation = async (res: Response, result: MutationResult) => {
  if (result.kind === "not-found") return orderNotFound(res);
  if (result.kind === "error")
    return res.status(result.status).json({
      success: false,
      code: result.code,
      message: result.message,
      ...(result.details ? { details: result.details } : {}),
    });

  const order = await loadOrderView(result.id);
  if (!order) throw new Error("order could not be reloaded");
  return res.json({ success: true, currency: CURRENCY, data: order });
};

const touchSession = (tx: DbTransaction, sessionId: string, now: Date) =>
  tx
    .update(tableSessions)
    .set({ lastActivityAt: now })
    .where(eq(tableSessions.id, sessionId));

export const listStaffOrders = async (req: Request, res: Response) => {
  const {
    status,
    tableId,
    paymentStatus,
    includeCancelled,
    limit,
    offset,
  } = res.locals.query as ListStaffOrdersQuery;

  const where = and(
    status
      ? eq(orders.status, status)
      : includeCancelled
        ? undefined
        : notInArray(orders.status, ["cancelled", "rejected"]),
    tableId === undefined ? undefined : eq(orders.tableId, tableId),
    paymentStatus === undefined
      ? undefined
      : eq(orders.paymentStatus, paymentStatus),
  );

  const rows = await findOrders(where, limit, offset);
  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(orders)
    .where(where);
  const total = count?.total ?? 0;

  return res.json({
    success: true,
    currency: CURRENCY,
    data: rows,
    pagination: {
      limit,
      offset,
      total,
      hasMore: offset + rows.length < total,
    },
  });
};

export const getStaffOrder = async (req: Request, res: Response) => {
  const id = parseUuid(req.params.id);
  if (!id) return orderNotFound(res);

  const order = await loadOrderView(id);
  return order
    ? res.json({ success: true, currency: CURRENCY, data: order })
    : orderNotFound(res);
};

// Confirming the first order is what opens the table session. Later orders are
// already received and never pass through here.
export const confirmOrder = async (req: Request, res: Response) => {
  const id = parseUuid(req.params.id);
  if (!id) return orderNotFound(res);
  const now = new Date();

  const result = await db.transaction(
    async (tx): Promise<MutationResult> => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, id))
        .limit(1)
        .for("update");
      if (!order) return { kind: "not-found" };
      if (order.status !== "pending_confirmation")
        return statusConflict(orderStatusConflict(order.status));

      const [session] = await tx
        .select()
        .from(tableSessions)
        .where(eq(tableSessions.id, order.tableSessionId))
        .limit(1)
        .for("update");
      if (!session || session.status === "closed")
        return statusConflict(
          "This table session is already closed.",
          "TABLE_SESSION_CLOSED",
        );

      await tx
        .update(orders)
        .set({ status: "received", confirmedAt: now, updatedAt: now })
        .where(eq(orders.id, order.id));

      if (session.status === "pending")
        await tx
          .update(tableSessions)
          .set({
            status: "open",
            startedAt: session.startedAt ?? now,
            lastActivityAt: now,
          })
          .where(eq(tableSessions.id, session.id));
      else await touchSession(tx, session.id, now);

      return { kind: "ok", id: order.id };
    },
  );

  return sendMutation(res, result);
};

// Rejecting frees the order limit slot. The session stays pending, so the next
// order is again held for confirmation.
export const rejectOrder = async (req: Request, res: Response) => {
  const id = parseUuid(req.params.id);
  if (!id) return orderNotFound(res);
  const input = req.body as RejectOrderInput;
  const now = new Date();

  const result = await db.transaction(
    async (tx): Promise<MutationResult> => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, id))
        .limit(1)
        .for("update");
      if (!order) return { kind: "not-found" };
      if (order.status !== "pending_confirmation")
        return statusConflict(orderStatusConflict(order.status));

      await tx
        .update(orders)
        .set({
          status: "rejected",
          rejectionReason: input.reason?.length ? input.reason : null,
          updatedAt: now,
        })
        .where(eq(orders.id, order.id));
      await touchSession(tx, order.tableSessionId, now);

      return { kind: "ok", id: order.id };
    },
  );

  return sendMutation(res, result);
};

export const advanceOrder = async (req: Request, res: Response) => {
  const id = parseUuid(req.params.id);
  if (!id) return orderNotFound(res);
  const now = new Date();

  const result = await db.transaction(
    async (tx): Promise<MutationResult> => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, id))
        .limit(1)
        .for("update");
      if (!order) return { kind: "not-found" };
      if (order.status === "pending_confirmation")
        return statusConflict(
          "Confirm this first order before advancing it.",
          "ORDER_CONFIRMATION_REQUIRED",
        );

      const next = NEXT_ORDER_STATUS[order.status];
      if (!next) return statusConflict(orderStatusConflict(order.status));

      await tx
        .update(orders)
        .set({ status: next, updatedAt: now })
        .where(eq(orders.id, order.id));
      await touchSession(tx, order.tableSessionId, now);

      return { kind: "ok", id: order.id };
    },
  );

  return sendMutation(res, result);
};

// Manager-only undo. Received cannot go back to pending_confirmation because
// that would re-close a session that is already open.
export const revertOrder = async (req: Request, res: Response) => {
  const id = parseUuid(req.params.id);
  if (!id) return orderNotFound(res);
  const now = new Date();

  const result = await db.transaction(
    async (tx): Promise<MutationResult> => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, id))
        .limit(1)
        .for("update");
      if (!order) return { kind: "not-found" };

      const previous = PREVIOUS_ORDER_STATUS[order.status];
      if (!previous)
        return statusConflict(
          "Only preparing, ready or served orders can be moved back a step.",
        );

      await tx
        .update(orders)
        .set({ status: previous, updatedAt: now })
        .where(eq(orders.id, order.id));
      await touchSession(tx, order.tableSessionId, now);

      return { kind: "ok", id: order.id };
    },
  );

  return sendMutation(res, result);
};

// Staff may cancel at any status, including served. Payment status is left
// untouched: a paid order stays paid and displays as "cancelled - paid".
export const cancelStaffOrder = async (req: Request, res: Response) => {
  const id = parseUuid(req.params.id);
  if (!id) return orderNotFound(res);
  const input = req.body as CancelOrderInput;
  const user = currentUser(req);
  const now = new Date();

  const result = await db.transaction(
    async (tx): Promise<MutationResult> => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, id))
        .limit(1)
        .for("update");
      if (!order) return { kind: "not-found" };
      if (order.status === "cancelled")
        return statusConflict(
          "This order was already cancelled.",
          "ORDER_ALREADY_CANCELLED",
        );
      if (order.status === "rejected")
        return statusConflict("This order was rejected.", "ORDER_REJECTED");

      await tx
        .update(orders)
        .set({
          status: "cancelled",
          cancellationReason: input.reason,
          cancelledAt: now,
          cancelledBy: "staff",
          cancelledByUserId: user.id,
          updatedAt: now,
        })
        .where(eq(orders.id, order.id));
      await touchSession(tx, order.tableSessionId, now);

      return { kind: "ok", id: order.id };
    },
  );

  return sendMutation(res, result);
};

export const markOrderPaid = async (req: Request, res: Response) => {
  const id = parseUuid(req.params.id);
  if (!id) return orderNotFound(res);
  const input = req.body as MarkOrderPaidInput;
  const user = currentUser(req);
  const now = new Date();

  const result = await db.transaction(
    async (tx): Promise<MutationResult> => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, id))
        .limit(1)
        .for("update");
      if (!order) return { kind: "not-found" };
      if (order.status !== "served")
        return statusConflict(
          "Only served orders can be marked paid.",
          "ORDER_NOT_SERVED",
        );
      if (order.paymentStatus === "paid")
        return statusConflict(
          "This order is already paid.",
          "ORDER_ALREADY_PAID",
        );

      await tx
        .update(orders)
        .set({
          paymentStatus: "paid",
          paymentMethod: input.method,
          paidAt: now,
          paidByUserId: user.id,
          updatedAt: now,
        })
        .where(eq(orders.id, order.id));
      await touchSession(tx, order.tableSessionId, now);

      return { kind: "ok", id: order.id };
    },
  );

  return sendMutation(res, result);
};

// Staff table overview: current sessions only, with counts excluding cancelled
// and rejected orders. The unpaid amount intentionally ignores cancelled
// orders, even when they were previously paid (no refunds are supported).
export const listTableOverview = async (_req: Request, res: Response) => {
  const tables = await db
    .select({ id: shopTables.id, name: shopTables.name, orderLimit: shopTables.orderLimit })
    .from(shopTables)
    .where(eq(shopTables.active, true))
    .orderBy(shopTables.id);

  const activeSessions = await db
    .select()
    .from(tableSessions)
    .where(notInArray(tableSessions.status, ["closed"]));

  const sessionsByTable = new Map(activeSessions.map((session) => [session.tableId, session]));
  const data = await Promise.all(tables.map(async (table) => {
    const session = sessionsByTable.get(table.id);
    if (!session) return {
      table: { id: table.id, name: table.name },
      status: "free" as const,
      session: null,
      ordersUsed: 0,
      ordersRemaining: table.orderLimit,
      unpaidOrderCount: 0,
      unpaidTotal: "0.00",
    };

    const [counts] = await db
      .select({
        ordersUsed: sql<number>`count(*) filter (where ${orders.status} not in ('cancelled', 'rejected'))::int`,
      })
      .from(orders)
      .where(eq(orders.tableSessionId, session.id));
    const unpaid = await unpaidTotalsForSession(db, session.id);
    const [cart] = await db
      .select({ id: carts.id })
      .from(carts)
      .where(eq(carts.tableSessionId, session.id))
      .limit(1);

    return {
      table: { id: table.id, name: table.name },
      status: session.status === "pending" ? "pending" as const : "open" as const,
      session: {
        id: session.id,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
        startedAt: session.startedAt?.toISOString() ?? null,
        lastActivityAt: session.lastActivityAt.toISOString(),
      },
      cartId: cart?.id ?? null,
      ordersUsed: counts?.ordersUsed ?? 0,
      ordersRemaining: Math.max(0, table.orderLimit - (counts?.ordersUsed ?? 0)),
      unpaidOrderCount: unpaid.orderCount,
      unpaidTotal: unpaid.total,
    };
  }));

  return res.json({ success: true, currency: CURRENCY, data });
};

export const getTableOrders = async (req: Request, res: Response) => {
  const tableId = parseId(req.params.tableId);
  if (!tableId)
    return res.status(404).json({ success: false, code: "TABLE_NOT_FOUND", message: "Table not found." });

  const [table] = await db
    .select({ id: shopTables.id, orderLimit: shopTables.orderLimit })
    .from(shopTables)
    .where(eq(shopTables.id, tableId))
    .limit(1);
  if (!table)
    return res.status(404).json({ success: false, code: "TABLE_NOT_FOUND", message: "Table not found." });

  const [session] = await db
    .select()
    .from(tableSessions)
    .where(and(eq(tableSessions.tableId, tableId), notInArray(tableSessions.status, ["closed"])))
    .limit(1);
  if (!session)
    return res.json({
      success: true,
      currency: CURRENCY,
      data: {
        session: null,
        orders: [],
        summary: {
          ordersUsed: 0,
          ordersRemaining: table.orderLimit,
          total: "0.00",
          unpaidOrderCount: 0,
          unpaidTotal: "0.00",
        },
      },
    });

  const orderViews = await loadSessionOrders(session.id);
  const summary = summarizeOrders(orderViews);
  const unpaid = await unpaidTotalsForSession(db, session.id);
  return res.json({
    success: true,
    currency: CURRENCY,
    data: {
      session: { id: session.id, status: session.status, createdAt: session.createdAt.toISOString(), startedAt: session.startedAt?.toISOString() ?? null, lastActivityAt: session.lastActivityAt.toISOString() },
      orders: orderViews,
      summary: {
        ordersUsed: summary.ordersUsed,
        ordersRemaining: Math.max(0, table.orderLimit - summary.ordersUsed),
        total: summary.total,
        unpaidOrderCount: unpaid.orderCount,
        unpaidTotal: unpaid.total,
      },
    },
  });
};

export const closeTable = async (req: Request, res: Response) => {
  const tableId = parseId(req.params.tableId);
  if (!tableId)
    return res.status(404).json({ success: false, code: "TABLE_NOT_FOUND", message: "Table not found." });
  const input = req.body as CloseTableInput;
  const user = currentUser(req);
  if (input.overrideUnpaid && !can(user.role, "table:close-override-unpaid"))
    return res.status(403).json({
      success: false,
      code: "MANAGER_OVERRIDE_REQUIRED",
      message: "Only a Manager or Owner can close a table with unpaid orders.",
    });
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    const [table] = await tx.select({ id: shopTables.id }).from(shopTables).where(eq(shopTables.id, tableId)).limit(1).for("update");
    if (!table) return { kind: "table-not-found" as const };
    const [session] = await tx.select().from(tableSessions).where(and(eq(tableSessions.tableId, tableId), notInArray(tableSessions.status, ["closed"]))).limit(1).for("update");
    if (!session) return { kind: "no-session" as const };
    const unpaid = await unpaidTotalsForSession(tx, session.id);
    if (unpaid.orderCount > 0 && !input.overrideUnpaid)
      return { kind: "unpaid" as const, unpaid };

    await tx.update(tableSessions).set({ status: "closed", closedAt: now, closedBy: "staff", closedByUserId: user.id }).where(eq(tableSessions.id, session.id));
    await tx.delete(carts).where(eq(carts.tableSessionId, session.id));
    return { kind: "closed" as const, sessionId: session.id, unpaid };
  });

  if (result.kind === "table-not-found") return res.status(404).json({ success: false, code: "TABLE_NOT_FOUND", message: "Table not found." });
  if (result.kind === "no-session") return res.status(409).json({ success: false, code: "TABLE_NOT_OPEN", message: "This table has no open session." });
  if (result.kind === "unpaid") return res.status(409).json({ success: false, code: "UNPAID_ORDERS_REMAIN", message: "This table has unpaid orders. A Manager must override to close it.", details: result.unpaid });
  return res.json({ success: true, data: { tableId, sessionId: result.sessionId, closedAt: now.toISOString(), unpaid: result.unpaid } });
};
