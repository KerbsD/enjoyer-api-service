import { asc, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db/index.ts";
import { categories, menuItems } from "../../db/schema.ts";
import { CURRENCY } from "../../configs/currency.ts";
import { getItemOptionGroups } from "../../lib/menuOptions.ts";
import type { OptionGroupView } from "../../lib/menuOptions.ts";

export const handlePublicMenu = async (_req: Request, res: Response) => {
  const rows = await db
    .select({
      categoryId: categories.id,
      categoryName: categories.name,
      categorySortOrder: categories.sortOrder,
      id: menuItems.id,
      name: menuItems.name,
      description: menuItems.description,
      price: menuItems.price,
      isSpicy: menuItems.isSpicy,
      isAvailable: menuItems.isAvailable,
      sortOrder: menuItems.sortOrder,
    })
    .from(categories)
    .innerJoin(menuItems, eq(menuItems.categoryId, categories.id))
    // Sold-out items stay visible. Only hidden items are excluded.
    .where(eq(menuItems.isHidden, false))
    .orderBy(
      asc(categories.sortOrder),
      asc(categories.id),
      asc(menuItems.sortOrder),
      asc(menuItems.id),
    );
  const itemOptions = await getItemOptionGroups(rows.map((row) => row.id));
  type PublicItem = Omit<
    (typeof rows)[number],
    "categoryName" | "categorySortOrder" | "categoryId"
  > & { optionGroups: OptionGroupView[] };
  const groups = new Map<
    number,
    { id: number; name: string; sortOrder: number; items: PublicItem[] }
  >();
  for (const { categoryId, categoryName, categorySortOrder, ...item } of rows) {
    let category = groups.get(categoryId);
    if (!category) {
      category = {
        id: categoryId,
        name: categoryName,
        sortOrder: categorySortOrder,
        items: [],
      };
      groups.set(categoryId, category);
    }
    category.items.push({
      ...item,
      optionGroups: itemOptions.get(item.id) ?? [],
    });
  }
  return res.json({
    success: true,
    currency: CURRENCY,
    data: [...groups.values()],
  });
};
