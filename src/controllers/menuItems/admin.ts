import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db/index.ts";
import { categories, menuItems } from "../../db/schema.ts";
import { CURRENCY } from "../../configs/currency.ts";
import { parseId, pgCode, pgConstraint } from "../../lib/helpers.ts";
import type {
  CreateMenuItemInput,
  UpdateMenuItemInput,
  ListMenuItemsQuery,
} from "../../validators/menuItems.ts";

const notFound = (res: Response) =>
  res.status(404).json({ success: false, message: "Menu item not found." });

const handleCategoryError = (err: unknown, res: Response) => {
  // The FK enforces category existence atomically, including concurrent writes.
  if (
    pgCode(err) === "23503" &&
    pgConstraint(err) === "menu_items_category_id_categories_id_fk"
  )
    return res
      .status(400)
      .json({ success: false, message: "Category does not exist." });
  throw err;
};

export const handleCreateMenuItem = async (req: Request, res: Response) => {
  try {
    const [item] = await db
      .insert(menuItems)
      .values(req.body as CreateMenuItemInput)
      .returning();

    if (!item) throw new Error("menu item insert returned no row");

    return res
      .status(201)
      .json({ success: true, currency: CURRENCY, data: item });
  } catch (err) {
    return handleCategoryError(err, res);
  }
};

export const handleGetMenuItem = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  const [item] = await db
    .select()
    .from(menuItems)
    .where(eq(menuItems.id, id))
    .limit(1);
  return item
    ? res.json({ success: true, currency: CURRENCY, data: item })
    : notFound(res);
};

export const handleUpdateMenuItem = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);

  if (!id) return notFound(res);

  try {
    const [item] = await db
      .update(menuItems)
      .set(req.body as UpdateMenuItemInput)
      .where(eq(menuItems.id, id))
      .returning();
    return item
      ? res.json({ success: true, currency: CURRENCY, data: item })
      : notFound(res);
  } catch (err) {
    return handleCategoryError(err, res);
  }
};

export const handleListMenuItems = async (_req: Request, res: Response) => {
  const { limit, offset, categoryId, isAvailable, isHidden } = res.locals
    .query as ListMenuItemsQuery;

  const filters: SQL[] = [];
  if (categoryId !== undefined)
    filters.push(eq(menuItems.categoryId, categoryId));
  if (isAvailable !== undefined)
    filters.push(eq(menuItems.isAvailable, isAvailable));
  if (isHidden !== undefined) filters.push(eq(menuItems.isHidden, isHidden));
  const where = filters.length ? and(...filters) : undefined;

  const [rows, [count]] = await Promise.all([
    db
      .select(getTableColumns(menuItems))
      .from(menuItems)
      .innerJoin(categories, eq(menuItems.categoryId, categories.id))
      .where(where)
      .orderBy(
        asc(categories.sortOrder),
        asc(categories.id),
        asc(menuItems.sortOrder),
        asc(menuItems.id),
      )
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(menuItems)
      .where(where),
  ]);

  const total = count?.total ?? 0;

  return res.json({
    success: true,
    currency: CURRENCY,
    data: rows,
    pagination: { limit, offset, total, hasMore: offset + rows.length < total },
  });
};

export const handleAvailability = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  // Set the requested state explicitly so a retried request cannot toggle it back.
  const [item] = await db
    .update(menuItems)
    .set({ isAvailable: req.body.isAvailable as boolean })
    .where(eq(menuItems.id, id))
    .returning();
  return item
    ? res.json({ success: true, currency: CURRENCY, data: item })
    : notFound(res);
};
