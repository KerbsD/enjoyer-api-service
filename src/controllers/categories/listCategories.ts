import { asc, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db/index.ts";
import { categories } from "../../db/schema.ts";
import type { ListCategoriesQuery } from "../../validators/categories.ts";

export const handleListCategories = async (_req: Request, res: Response) => {
  const { limit, offset } = res.locals.query as ListCategoriesQuery;
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(categories)
      .orderBy(asc(categories.sortOrder), asc(categories.id))
      .limit(limit)
      .offset(offset),
    db.select({ total: sql<number>`count(*)::int` }).from(categories),
  ]);
  const total = count?.total ?? 0;
  return res.json({
    success: true,
    data: rows,
    pagination: { limit, offset, total, hasMore: offset + rows.length < total },
  });
};
