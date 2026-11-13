import { and, eq, inArray } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db/index.ts";
import {
  cartItemOptions,
  cartItems,
  carts,
  menuItems,
  tableSessions,
} from "../../db/schema.ts";
import { CURRENCY } from "../../configs/currency.ts";
import {
  loadCartView,
  loadItemOptionGroups,
  lockCart,
  validateOptionSelection,
} from "../../lib/cart.ts";
import type {
  CartOption,
  DbTransaction,
  LockedCart,
  SelectionResult,
} from "../../lib/cart.ts";
import { parseId } from "../../lib/helpers.ts";
import { readShopSettings } from "../../lib/settings.ts";
import { idleCutoff } from "../../lib/tableSessions.ts";
import { getTableSessionContext } from "../../middlewares/tableSession.ts";
import type {
  AddCartItemInput,
  CartVersionQuery,
  UpdateCartItemInput,
} from "../../validators/cart.ts";

// Mutations return one of these from inside the transaction; the HTTP response
// is written after commit so rendering a conflict never holds row locks.
type Failure =
  | { kind: "session" }
  | { kind: "not-found" }
  | {
      kind: "error";
      status: number;
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };

type MutationResult =
  | Failure
  | { kind: "ok"; cartId: string }
  | { kind: "conflict"; cartId: string };

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

const sessionRequired = (res: Response) =>
  res.status(409).json({
    success: false,
    code: "TABLE_SESSION_REQUIRED",
    message: "Scan the table QR code again to start or join this table.",
  });

const itemNotFound = (res: Response) =>
  res.status(404).json({
    success: false,
    code: "CART_ITEM_NOT_FOUND",
    message: "This cart item no longer exists.",
  });

const respond = async (res: Response, result: MutationResult) => {
  switch (result.kind) {
    case "ok":
      return res.json({
        success: true,
        currency: CURRENCY,
        data: await loadCartView(result.cartId),
      });
    case "conflict":
      // Send the latest cart so the client can re-render and retry without an
      // extra round trip.
      return res.status(409).json({
        success: false,
        code: "CART_VERSION_CONFLICT",
        message:
          "The cart changed on another device. Review the latest cart and try again.",
        data: await loadCartView(result.cartId),
      });
    case "session":
      return sessionRequired(res);
    case "not-found":
      return itemNotFound(res);
    case "error":
      return res.status(result.status).json({
        success: false,
        code: result.code,
        message: result.message,
        ...(result.details ? { details: result.details } : {}),
      });
  }
};

const bumpCart = async (
  tx: DbTransaction,
  cartId: string,
  version: number,
  sessionId: string,
  now: Date,
) => {
  await tx
    .update(carts)
    .set({ version: version + 1, updatedAt: now })
    .where(eq(carts.id, cartId));
  await tx
    .update(tableSessions)
    .set({ lastActivityAt: now })
    .where(eq(tableSessions.id, sessionId));
};

// Query the active session and cart under lock, then verify the version. Every
// mutation starts here so the version rule is identical everywhere.
const beginMutation = async (
  tx: DbTransaction,
  tableId: number,
  cutoff: Date,
  version: number,
): Promise<
  | { kind: "locked"; locked: LockedCart }
  | { kind: "session" }
  | { kind: "conflict"; cartId: string }
> => {
  const locked = await lockCart(tx, tableId, cutoff);
  if (!locked) return { kind: "session" };
  if (locked.cart.version !== version)
    return { kind: "conflict", cartId: locked.cart.id };
  return { kind: "locked", locked };
};

const optionIdsByLine = async (
  tx: DbTransaction,
  lineIds: number[],
): Promise<Map<number, number[]>> => {
  const byLine = new Map<number, number[]>();
  if (lineIds.length === 0) return byLine;
  const rows = await tx
    .select({
      cartItemId: cartItemOptions.cartItemId,
      optionId: cartItemOptions.optionId,
    })
    .from(cartItemOptions)
    .where(inArray(cartItemOptions.cartItemId, lineIds));
  for (const row of rows) {
    const list = byLine.get(row.cartItemId) ?? [];
    list.push(row.optionId);
    byLine.set(row.cartItemId, list);
  }
  return byLine;
};

const sameSelection = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const sortedIds = (options: CartOption[]): number[] =>
  options.map((option) => option.id).sort((a, b) => a - b);

// Validates that the menu item can still be ordered. Hidden items look missing
// to customers; sold-out items are a conflict rather than bad input.
const checkItem = async (
  tx: DbTransaction,
  menuItemId: number,
): Promise<{ id: number } | Failure> => {
  const [item] = await tx
    .select({
      id: menuItems.id,
      isAvailable: menuItems.isAvailable,
      isHidden: menuItems.isHidden,
    })
    .from(menuItems)
    .where(eq(menuItems.id, menuItemId))
    .limit(1);
  if (!item || item.isHidden)
    return {
      kind: "error",
      status: 404,
      code: "MENU_ITEM_NOT_FOUND",
      message: "Menu item not found.",
    };
  if (!item.isAvailable)
    return {
      kind: "error",
      status: 409,
      code: "MENU_ITEM_UNAVAILABLE",
      message: "This item is sold out right now.",
    };
  return { id: item.id };
};

export const getCart = async (_req: Request, res: Response) => {
  const context = getTableSessionContext(res);
  return res.json({
    success: true,
    currency: CURRENCY,
    data: await loadCartView(context.cart.id),
  });
};

export const addCartItem = async (req: Request, res: Response) => {
  const context = getTableSessionContext(res);
  const input = req.body as AddCartItemInput;
  const settings = await readShopSettings();
  const now = new Date();
  const cutoff = idleCutoff(settings, now);

  const result = await db.transaction(
    async (tx): Promise<MutationResult> => {
      const started = await beginMutation(
        tx,
        context.table.id,
        cutoff,
        input.version,
      );
      if (started.kind !== "locked") return started;
      const { cart, session } = started.locked;

      const item = await checkItem(tx, input.menuItemId);
      if ("kind" in item) return item;

      const groups = await loadItemOptionGroups(tx, input.menuItemId);
      const selection = validateOptionSelection(groups, input.optionIds);
      if (!selection.ok) return selectionFailure(selection);

      // Identical lines (same item, note, and option set) merge into one, so a
      // customer tapping "add" twice does not create duplicate rows.
      const candidates = await tx
        .select({ id: cartItems.id, quantity: cartItems.quantity })
        .from(cartItems)
        .where(
          and(
            eq(cartItems.cartId, cart.id),
            eq(cartItems.menuItemId, input.menuItemId),
            eq(cartItems.note, input.note),
          ),
        );
      const wanted = sortedIds(selection.options);
      if (candidates.length > 0) {
        const existingOptions = await optionIdsByLine(
          tx,
          candidates.map((candidate) => candidate.id),
        );
        const match = candidates.find((candidate) =>
          sameSelection(
            (existingOptions.get(candidate.id) ?? []).sort((a, b) => a - b),
            wanted,
          ),
        );
        if (match) {
          await tx
            .update(cartItems)
            .set({ quantity: Math.min(99, match.quantity + input.quantity) })
            .where(eq(cartItems.id, match.id));
          await bumpCart(tx, cart.id, cart.version, session.id, now);
          return { kind: "ok", cartId: cart.id };
        }
      }

      const [line] = await tx
        .insert(cartItems)
        .values({
          cartId: cart.id,
          menuItemId: input.menuItemId,
          quantity: input.quantity,
          note: input.note,
        })
        .returning({ id: cartItems.id });
      if (!line) throw new Error("cart item insert returned no row");
      if (selection.options.length > 0)
        await tx.insert(cartItemOptions).values(
          selection.options.map((option) => ({
            cartItemId: line.id,
            optionId: option.id,
          })),
        );

      await bumpCart(tx, cart.id, cart.version, session.id, now);
      return { kind: "ok", cartId: cart.id };
    },
  );

  return respond(res, result);
};

export const updateCartItem = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return itemNotFound(res);

  const context = getTableSessionContext(res);
  const input = req.body as UpdateCartItemInput;
  const settings = await readShopSettings();
  const now = new Date();
  const cutoff = idleCutoff(settings, now);

  const result = await db.transaction(
    async (tx): Promise<MutationResult> => {
      const started = await beginMutation(
        tx,
        context.table.id,
        cutoff,
        input.version,
      );
      if (started.kind !== "locked") return started;
      const { cart, session } = started.locked;

      const [line] = await tx
        .select()
        .from(cartItems)
        .where(and(eq(cartItems.id, id), eq(cartItems.cartId, cart.id)))
        .limit(1);
      if (!line) return { kind: "not-found" };

      const item = await checkItem(tx, line.menuItemId);
      if ("kind" in item) return item;

      if (input.optionIds !== undefined) {
        const groups = await loadItemOptionGroups(tx, line.menuItemId);
        const selection = validateOptionSelection(groups, input.optionIds);
        if (!selection.ok) return selectionFailure(selection);
        await tx
          .delete(cartItemOptions)
          .where(eq(cartItemOptions.cartItemId, line.id));
        if (selection.options.length > 0)
          await tx.insert(cartItemOptions).values(
            selection.options.map((option) => ({
              cartItemId: line.id,
              optionId: option.id,
            })),
          );
      }

      const values: { quantity?: number; note?: string } = {};
      if (input.quantity !== undefined) values.quantity = input.quantity;
      if (input.note !== undefined) values.note = input.note;
      if (Object.keys(values).length > 0)
        await tx
          .update(cartItems)
          .set(values)
          .where(eq(cartItems.id, line.id));

      await bumpCart(tx, cart.id, cart.version, session.id, now);
      return { kind: "ok", cartId: cart.id };
    },
  );

  return respond(res, result);
};

export const deleteCartItem = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return itemNotFound(res);

  const context = getTableSessionContext(res);
  const { version } = res.locals.query as CartVersionQuery;
  const settings = await readShopSettings();
  const now = new Date();
  const cutoff = idleCutoff(settings, now);

  const result = await db.transaction(
    async (tx): Promise<MutationResult> => {
      const started = await beginMutation(
        tx,
        context.table.id,
        cutoff,
        version,
      );
      if (started.kind !== "locked") return started;
      const { cart, session } = started.locked;

      const [removed] = await tx
        .delete(cartItems)
        .where(and(eq(cartItems.id, id), eq(cartItems.cartId, cart.id)))
        .returning({ id: cartItems.id });
      if (!removed) return { kind: "not-found" };

      await bumpCart(tx, cart.id, cart.version, session.id, now);
      return { kind: "ok", cartId: cart.id };
    },
  );

  return respond(res, result);
};

export const clearCart = async (req: Request, res: Response) => {
  const context = getTableSessionContext(res);
  const { version } = res.locals.query as CartVersionQuery;
  const settings = await readShopSettings();
  const now = new Date();
  const cutoff = idleCutoff(settings, now);

  const result = await db.transaction(
    async (tx): Promise<MutationResult> => {
      const started = await beginMutation(
        tx,
        context.table.id,
        cutoff,
        version,
      );
      if (started.kind !== "locked") return started;
      const { cart, session } = started.locked;

      await tx.delete(cartItems).where(eq(cartItems.cartId, cart.id));
      await bumpCart(tx, cart.id, cart.version, session.id, now);
      return { kind: "ok", cartId: cart.id };
    },
  );

  return respond(res, result);
};
