import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  cartItemOptions,
  cartItems,
  carts,
  menuItemOptionGroups,
  menuItems,
  menuOptionGroups,
  menuOptions,
  tableSessions,
} from "../db/schema.ts";
import type { Cart, TableSession } from "../db/schema.ts";
import { fromCents, toCents } from "./money.ts";

export type CartOption = {
  id: number;
  name: string;
  priceDelta: string;
  isAvailable: boolean;
  groupId: number;
  groupName: string;
  groupSortOrder: number;
  optionSortOrder: number;
};

export type CartMenuItem = {
  id: number;
  name: string;
  price: string;
  isAvailable: boolean;
  isHidden: boolean;
};

export type CartLine = {
  id: number;
  menuItem: CartMenuItem;
  quantity: number;
  note: string;
  options: CartOption[];
};

export type CartItemView = CartLine & {
  unitPrice: string;
  lineTotal: string;
};

export type CartView = {
  id: string;
  version: number;
  updatedAt: string;
  items: CartItemView[];
  totals: {
    itemCount: number;
    subtotal: string;
    total: string;
  };
};

export type OptionGroupForValidation = {
  id: number;
  name: string;
  minSelections: number;
  maxSelections: number;
  options: CartOption[];
};

export type SelectionResult =
  | { ok: true; options: CartOption[] }
  | {
      ok: false;
      code:
        | "OPTION_INVALID"
        | "OPTION_UNAVAILABLE"
        | "OPTION_SELECTION_INVALID";
      message: string;
      groupId?: number;
      minSelections?: number;
      maxSelections?: number;
      selected?: number;
    };

const selectionMessage = (group: OptionGroupForValidation): string => {
  if (group.minSelections === group.maxSelections && group.minSelections === 1)
    return `Choose exactly one option for ${group.name}.`;
  if (group.minSelections === group.maxSelections)
    return `Choose exactly ${group.minSelections} options for ${group.name}.`;
  return `Choose between ${group.minSelections} and ${group.maxSelections} options for ${group.name}.`;
};

export const validateOptionSelection = (
  groups: OptionGroupForValidation[],
  optionIds: number[],
): SelectionResult => {
  const byId = new Map<number, CartOption>();
  for (const group of groups)
    for (const option of group.options) byId.set(option.id, option);

  const selected: CartOption[] = [];
  const seen = new Set<number>();
  for (const optionId of optionIds) {
    if (seen.has(optionId)) continue;
    seen.add(optionId);
    const option = byId.get(optionId);
    if (!option)
      return {
        ok: false,
        code: "OPTION_INVALID",
        message: "An option does not belong to this menu item.",
      };
    if (!option.isAvailable)
      return {
        ok: false,
        code: "OPTION_UNAVAILABLE",
        message: `${option.name} is sold out.`,
      };
    selected.push(option);
  }

  for (const group of groups) {
    const count = selected.filter(
      (option) => option.groupId === group.id,
    ).length;
    if (count < group.minSelections || count > group.maxSelections)
      return {
        ok: false,
        code: "OPTION_SELECTION_INVALID",
        message: selectionMessage(group),
        groupId: group.id,
        minSelections: group.minSelections,
        maxSelections: group.maxSelections,
        selected: count,
      };
  }

  return { ok: true, options: selected };
};

export const summarizeCart = (
  lines: Pick<CartLine, "quantity" | "menuItem" | "options">[],
): { itemCount: number; subtotal: string; total: string } => {
  let itemCount = 0;
  let subtotal = 0;
  for (const line of lines) {
    const unit =
      toCents(line.menuItem.price) +
      line.options.reduce((sum, option) => sum + toCents(option.priceDelta), 0);
    itemCount += line.quantity;
    subtotal += unit * line.quantity;
  }
  const total = fromCents(subtotal);
  return { itemCount, subtotal: total, total };
};

const itemView = (line: CartLine): CartItemView => {
  const unit =
    toCents(line.menuItem.price) +
    line.options.reduce((sum, option) => sum + toCents(option.priceDelta), 0);
  return {
    ...line,
    unitPrice: fromCents(unit),
    lineTotal: fromCents(unit * line.quantity),
  };
};

// Reads the shared cart exactly as the customer should see it: current menu
// prices, selected options, and server-computed totals. The caller scopes the
// cart to the requesting table token before calling this.
export const loadCartView = async (cartId: string): Promise<CartView> => {
  const [cart] = await db
    .select()
    .from(carts)
    .where(eq(carts.id, cartId))
    .limit(1);
  if (!cart) throw new Error("cart not found");

  const rows = await db
    .select({
      id: cartItems.id,
      quantity: cartItems.quantity,
      note: cartItems.note,
      menuItemId: menuItems.id,
      menuItemName: menuItems.name,
      menuItemPrice: menuItems.price,
      menuItemAvailable: menuItems.isAvailable,
      menuItemHidden: menuItems.isHidden,
    })
    .from(cartItems)
    .innerJoin(menuItems, eq(cartItems.menuItemId, menuItems.id))
    .where(eq(cartItems.cartId, cartId))
    .orderBy(asc(cartItems.id));

  const ids = rows.map((row) => row.id);
  const optionRows = ids.length
    ? await db
        .select({
          cartItemId: cartItemOptions.cartItemId,
          id: menuOptions.id,
          name: menuOptions.name,
          priceDelta: menuOptions.priceDelta,
          isAvailable: menuOptions.isAvailable,
          groupId: menuOptionGroups.id,
          groupName: menuOptionGroups.name,
          groupSortOrder: menuOptionGroups.sortOrder,
          optionSortOrder: menuOptions.sortOrder,
        })
        .from(cartItemOptions)
        .innerJoin(menuOptions, eq(cartItemOptions.optionId, menuOptions.id))
        .innerJoin(
          menuOptionGroups,
          eq(menuOptions.groupId, menuOptionGroups.id),
        )
        .where(inArray(cartItemOptions.cartItemId, ids))
        .orderBy(
          asc(menuOptionGroups.sortOrder),
          asc(menuOptions.sortOrder),
          asc(menuOptions.id),
        )
    : [];

  const optionsByItem = new Map<number, CartOption[]>();
  for (const row of optionRows) {
    const list = optionsByItem.get(row.cartItemId) ?? [];
    list.push({
      id: row.id,
      name: row.name,
      priceDelta: row.priceDelta,
      isAvailable: row.isAvailable,
      groupId: row.groupId,
      groupName: row.groupName,
      groupSortOrder: row.groupSortOrder,
      optionSortOrder: row.optionSortOrder,
    });
    optionsByItem.set(row.cartItemId, list);
  }

  const lines: CartLine[] = rows.map((row) => ({
    id: row.id,
    menuItem: {
      id: row.menuItemId,
      name: row.menuItemName,
      price: row.menuItemPrice,
      isAvailable: row.menuItemAvailable,
      isHidden: row.menuItemHidden,
    },
    quantity: row.quantity,
    note: row.note,
    options: optionsByItem.get(row.id) ?? [],
  }));

  return {
    id: cart.id,
    version: cart.version,
    updatedAt: cart.updatedAt.toISOString(),
    items: lines.map(itemView),
    totals: summarizeCart(lines),
  };
};

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const loadItemOptionGroups = async (
  tx: DbTransaction,
  menuItemId: number,
): Promise<OptionGroupForValidation[]> => {
  const rows = await tx
    .select({
      groupId: menuOptionGroups.id,
      groupName: menuOptionGroups.name,
      minSelections: menuOptionGroups.minSelections,
      maxSelections: menuOptionGroups.maxSelections,
      groupSortOrder: menuOptionGroups.sortOrder,
      optionId: menuOptions.id,
      optionName: menuOptions.name,
      priceDelta: menuOptions.priceDelta,
      isAvailable: menuOptions.isAvailable,
      optionSortOrder: menuOptions.sortOrder,
    })
    .from(menuItemOptionGroups)
    .innerJoin(
      menuOptionGroups,
      eq(menuItemOptionGroups.optionGroupId, menuOptionGroups.id),
    )
    .innerJoin(menuOptions, eq(menuOptions.groupId, menuOptionGroups.id))
    .where(eq(menuItemOptionGroups.menuItemId, menuItemId))
    .orderBy(
      asc(menuOptionGroups.sortOrder),
      asc(menuOptionGroups.id),
      asc(menuOptions.sortOrder),
      asc(menuOptions.id),
    );

  const groups = new Map<number, OptionGroupForValidation>();
  for (const row of rows) {
    let group = groups.get(row.groupId);
    if (!group) {
      group = {
        id: row.groupId,
        name: row.groupName,
        minSelections: row.minSelections,
        maxSelections: row.maxSelections,
        options: [],
      };
      groups.set(row.groupId, group);
    }
    group.options.push({
      id: row.optionId,
      name: row.optionName,
      priceDelta: row.priceDelta,
      isAvailable: row.isAvailable,
      groupId: row.groupId,
      groupName: row.groupName,
      groupSortOrder: row.groupSortOrder,
      optionSortOrder: row.optionSortOrder,
    });
  }
  return [...groups.values()];
};

export type LockedCart = { session: TableSession; cart: Cart };

// Locks the table's current session first, then its cart. Every mutation uses
// this order so two phones cannot deadlock or write from a stale cart version.
// A caller that passes the idle cutoff gets the timeout enforced here too, so
// a request that races the hourly cleanup cannot revive an expired session.
export const lockCart = async (
  tx: DbTransaction,
  tableId: number,
  cutoff?: Date,
): Promise<LockedCart | null> => {
  const [session] = await tx
    .select()
    .from(tableSessions)
    .where(
      and(
        eq(tableSessions.tableId, tableId),
        ne(tableSessions.status, "closed"),
      ),
    )
    .limit(1)
    .for("update");
  if (!session) return null;

  if (cutoff && session.lastActivityAt.getTime() < cutoff.getTime()) {
    await tx
      .update(tableSessions)
      .set({
        status: "closed",
        closedAt: new Date(),
        closedBy: "timeout",
        closedByUserId: null,
      })
      .where(eq(tableSessions.id, session.id));
    await tx.delete(carts).where(eq(carts.tableSessionId, session.id));
    return null;
  }

  const [cart] = await tx
    .select()
    .from(carts)
    .where(eq(carts.tableSessionId, session.id))
    .limit(1)
    .for("update");
  return cart ? { session, cart } : null;
};
