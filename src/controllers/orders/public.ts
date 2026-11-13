import { and, eq, inArray, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db/index.ts";
import {
  cartItems,
  carts,
  orderItemOptions,
  orderItems,
  orders,
  tableSessions,
} from "../../db/schema.ts";
import { CURRENCY } from "../../configs/currency.ts";
import { fromCents, toCents } from "../../lib/money.ts";
import {
  loadCartLines,
  loadCartView,
  loadItemOptionGroups,
  lockCart,
  validateOptionSelection,
} from "../../lib/cart.ts";
import type { SelectionResult } from "../../lib/cart.ts";
import { parseUuid } from "../../lib/helpers.ts";
import {
  allocateOrderNumber,
  CUSTOMER_CANCELLABLE_STATUSES,
  loadOrderView,
  loadSessionOrders,
  ORDER_COUNT_STATUSES,
  summarizeOrders,
} from "../../lib/orders.ts";
import { readShopSettings } from "../../lib/settings.ts";
import { getStoreStatus } from "../../lib/storeHours.ts";
import { idleCutoff } from "../../lib/tableSessions.ts";
import { getTableSessionContext } from "../../middlewares/tableSession.ts";
import type { PlaceOrderInput } from "../../validators/orders.ts";

type ErrorFailure = {
  kind: "error";
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

type Failure =
  | { kind: "session" }
  | { kind: "conflict"; cartId: string }
  | ErrorFailure;

type PlacementResult =
  | Failure
  | { kind: "ok"; orderId: string; ordersUsed: number };

const sessionRequired = (res: Response) =>
  res.status(409).json({
    success: false,
    code: "TABLE_SESSION_REQUIRED",
    message: "Scan the table QR code again to start or join this table.",
  });

const orderNotFound = (res: Response) =>
  res.status(404).json({
    success: false,
    code: "ORDER_NOT_FOUND",
    message: "Order not found.",
  });

const selectionFailure = (
  selection: Extract<SelectionResult, { ok: false }>,
): Failure => ({
  kind: "error",
  status: selection.code === "OPTION_UNAVAILABLE" ? 409 : 400,
  code: selection.code,
  message: selection.message,
  details: {
    ...(selection.groupId === undefined
      ? {}
      : { groupId: selection.groupId }),
    ...(selection.minSelections === undefined
      ? {}
      : { minSelections: selection.minSelections }),
    ...(selection.maxSelections === undefined
      ? {}
      : { maxSelections: selection.maxSelections }),
    ...(selection.selected === undefined
      ? {}
      : { selected: selection.selected }),
  },
});

// Places the shared cart as an order. Everything that must be atomic (limit,
// number allocation, snapshots, cart clear) happens in one transaction; the
// HTTP response is rendered only after commit.
export const placeOrder = async (req: Request, res: Response) => {
  const context = getTableSessionContext(res);
  const input = req.body as PlaceOrderInput;

  const settings = await readShopSettings();
  const now = new Date();
  const cutoff = idleCutoff(settings, now);
  const store = await getStoreStatus(now, settings);

  if (!store.isOpen)
    return res.status(409).json({
      success: false,
      code: "STORE_CLOSED",
      message:
        "The store is closed right now. Ordering opens again during store hours.",
      details: {
        timezone: store.timezone,
        localDate: store.localDate,
        localTime: store.localTime,
        today: store.today,
        closesAt: store.closesAt,
        nextOpen: store.nextOpen,
      },
    });

  const result = await db.transaction(async (tx): Promise<PlacementResult> => {
    const locked = await lockCart(tx, context.table.id, cutoff);
    if (!locked) return { kind: "session" };
    const { session, cart } = locked;
    if (cart.version !== input.version)
      return { kind: "conflict", cartId: cart.id };

    // The first order of a new session is the confirmation gate. While it is
    // waiting, another order would leave the session neither open nor
    // confirmed, so the customer is asked to wait for staff first.
    const [pending] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.tableSessionId, session.id),
          eq(orders.status, "pending_confirmation"),
        ),
      )
      .limit(1);
    if (pending)
      return {
        kind: "error",
        status: 409,
        code: "ORDER_AWAITING_CONFIRMATION",
        message:
          "Your first order is waiting for staff confirmation. Please wait before placing another order.",
      };

    const [countRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(
        and(
          eq(orders.tableSessionId, session.id),
          inArray(orders.status, ORDER_COUNT_STATUSES),
        ),
      );
    const ordersUsed = countRow?.count ?? 0;
    if (ordersUsed >= context.table.orderLimit)
      return {
        kind: "error",
        status: 409,
        code: "ORDER_LIMIT_REACHED",
        message:
          "This table has reached its order limit. Please contact staff to place another order.",
        details: {
          orderLimit: context.table.orderLimit,
          ordersUsed,
          ordersRemaining: 0,
        },
      };

    const items = await loadCartLines(tx, cart.id);
    if (items.length === 0)
      return {
        kind: "error",
        status: 409,
        code: "CART_EMPTY",
        message: "Add something to the cart before placing an order.",
      };

    // Revalidate availability and option rules against the menu as it is now,
    // not as it was when the line was added.
    const groupsByItem = new Map<
      number,
      Awaited<ReturnType<typeof loadItemOptionGroups>>
    >();
    for (const item of items) {
      if (item.menuItem.isHidden)
        return {
          kind: "error",
          status: 409,
          code: "MENU_ITEM_UNAVAILABLE",
          message: "An item in your cart is no longer available.",
          details: { menuItemId: item.menuItem.id },
        };
      if (!item.menuItem.isAvailable)
        return {
          kind: "error",
          status: 409,
          code: "MENU_ITEM_UNAVAILABLE",
          message: `${item.menuItem.name} is sold out right now.`,
          details: { menuItemId: item.menuItem.id },
        };

      let groups = groupsByItem.get(item.menuItem.id);
      if (!groups) {
        groups = await loadItemOptionGroups(tx, item.menuItem.id);
        groupsByItem.set(item.menuItem.id, groups);
      }
      const selection = validateOptionSelection(
        groups,
        item.options.map((option) => option.id),
      );
      if (!selection.ok) return selectionFailure(selection);
    }

    let subtotalCents = 0;
    const lines = items.map((item) => {
      const lineTotal = toCents(item.unitPrice) * item.quantity;
      subtotalCents += lineTotal;
      return { item, lineTotal };
    });
    const total = fromCents(subtotalCents);

    const orderNumber = await allocateOrderNumber(
      tx,
      now,
      settings.shopTimezone,
    );
    const [created] = await tx
      .insert(orders)
      .values({
        orderNumber,
        tableSessionId: session.id,
        tableId: context.table.id,
        // A provisional session (no confirmed first order yet) keeps every
        // order behind the confirmation gate. An open session skips it.
        status:
          session.status === "pending" ? "pending_confirmation" : "received",
        subtotal: total,
        total,
      })
      .returning({ id: orders.id });
    if (!created) throw new Error("order insert returned no row");

    for (const line of lines) {
      const [orderItem] = await tx
        .insert(orderItems)
        .values({
          orderId: created.id,
          menuItemId: line.item.menuItem.id,
          nameSnapshot: line.item.menuItem.name,
          unitPriceSnapshot: line.item.menuItem.price,
          quantity: line.item.quantity,
          note: line.item.note,
          lineTotal: fromCents(line.lineTotal),
        })
        .returning({ id: orderItems.id });
      if (!orderItem) throw new Error("order item insert returned no row");

      if (line.item.options.length > 0)
        await tx.insert(orderItemOptions).values(
          line.item.options.map((option) => ({
            orderItemId: orderItem.id,
            optionId: option.id,
            nameSnapshot: option.name,
            groupNameSnapshot: option.groupName,
            priceDeltaSnapshot: option.priceDelta,
          })),
        );
    }

    await tx.delete(cartItems).where(eq(cartItems.cartId, cart.id));
    await tx
      .update(carts)
      .set({ version: cart.version + 1, updatedAt: now })
      .where(eq(carts.id, cart.id));
    await tx
      .update(tableSessions)
      .set({ lastActivityAt: now })
      .where(eq(tableSessions.id, session.id));

    return { kind: "ok", orderId: created.id, ordersUsed: ordersUsed + 1 };
  });

  switch (result.kind) {
    case "session":
      return sessionRequired(res);
    case "conflict": {
      const cart = await loadCartView(result.cartId);
      return res.status(409).json({
        success: false,
        code: "CART_VERSION_CONFLICT",
        message:
          "The cart changed on another device. Review the latest cart and try again.",
        data: cart,
      });
    }
    case "error":
      return res.status(result.status).json({
        success: false,
        code: result.code,
        message: result.message,
        ...(result.details ? { details: result.details } : {}),
      });
    case "ok": {
      const order = await loadOrderView(result.orderId);
      if (!order) throw new Error("placed order could not be reloaded");
      const cart = await loadCartView(context.cart.id);
      return res.status(201).json({
        success: true,
        currency: CURRENCY,
        data: {
          order,
          cart,
          summary: {
            orderLimit: context.table.orderLimit,
            ordersUsed: result.ordersUsed,
            ordersRemaining: Math.max(
              0,
              context.table.orderLimit - result.ordersUsed,
            ),
          },
        },
      });
    }
  }
};

export const listCustomerOrders = async (_req: Request, res: Response) => {
  const context = getTableSessionContext(res);
  const views = await loadSessionOrders(context.session.id);
  const summary = summarizeOrders(views);

  return res.json({
    success: true,
    currency: CURRENCY,
    data: {
      session: {
        id: context.session.id,
        status: context.session.status,
        createdAt: context.session.createdAt.toISOString(),
        startedAt: context.session.startedAt?.toISOString() ?? null,
        lastActivityAt: context.session.lastActivityAt.toISOString(),
      },
      orders: views,
      summary: {
        orderLimit: context.table.orderLimit,
        orderCount: views.length,
        ordersUsed: summary.ordersUsed,
        ordersRemaining: Math.max(
          0,
          context.table.orderLimit - summary.ordersUsed,
        ),
        total: summary.total,
        awaitingConfirmation: views.some(
          (view) => view.status === "pending_confirmation",
        ),
      },
    },
  });
};

export const cancelCustomerOrder = async (req: Request, res: Response) => {
  const id = parseUuid(req.params.id);
  if (!id) return orderNotFound(res);

  const context = getTableSessionContext(res);
  const now = new Date();

  const result = await db.transaction(
    async (
      tx,
    ): Promise<
      | ErrorFailure
      | { kind: "session" }
      | { kind: "not-found" }
      | { kind: "ok"; id: string }
    > => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.id, id),
            eq(orders.tableSessionId, context.session.id),
          ),
        )
        .limit(1)
        .for("update");
      if (!order) return { kind: "not-found" };

      // Order lifecycle mutations consistently lock the order before the
      // session, avoiding lock inversion with staff confirm/status actions.
      const [session] = await tx
        .select()
        .from(tableSessions)
        .where(eq(tableSessions.id, context.session.id))
        .limit(1)
        .for("update");
      if (!session || session.status === "closed") return { kind: "session" };

      if (!CUSTOMER_CANCELLABLE_STATUSES.includes(order.status)) {
        const code =
          order.status === "cancelled"
            ? "ORDER_ALREADY_CANCELLED"
            : order.status === "rejected"
              ? "ORDER_REJECTED"
              : "ORDER_NOT_CANCELLABLE";
        const message =
          order.status === "cancelled"
            ? "This order was already cancelled."
            : order.status === "rejected"
              ? "This order was rejected."
              : "Staff have started preparing this order. Please ask staff if you need to cancel it.";
        return { kind: "error", status: 409, code, message };
      }

      await tx
        .update(orders)
        .set({
          status: "cancelled",
          cancelledAt: now,
          cancelledBy: "customer",
          cancelledByUserId: null,
          cancellationReason: null,
          updatedAt: now,
        })
        .where(eq(orders.id, order.id));
      await tx
        .update(tableSessions)
        .set({ lastActivityAt: now })
        .where(eq(tableSessions.id, session.id));

      return { kind: "ok", id: order.id };
    },
  );

  if (result.kind === "session") return sessionRequired(res);
  if (result.kind === "not-found") return orderNotFound(res);
  if (result.kind === "error")
    return res.status(result.status).json({
      success: false,
      code: result.code,
      message: result.message,
      ...(result.details ? { details: result.details } : {}),
    });

  const order = await loadOrderView(result.id);
  if (!order) throw new Error("cancelled order could not be reloaded");
  return res.json({ success: true, currency: CURRENCY, data: order });
};
