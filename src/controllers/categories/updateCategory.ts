import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db/index.ts";
import { categories } from "../../db/schema.ts";
import { parseId } from "../../lib/helpers.ts";
import type { UpdateCategoryInput } from "../../validators/categories.ts";

export const handleUpdateCategory = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const notFound = () => res.status(404).json({ success: false, message: "Category not found." });
  if (!id) return notFound();
  const { name, sortOrder } = req.body as UpdateCategoryInput;
  // An atomic partial update preserves fields omitted by the caller, including
  // when another Manager is editing a different field at the same time.
  const [category] = await db.update(categories).set({
    ...(name !== undefined ? { name } : {}),
    ...(sortOrder !== undefined ? { sortOrder } : {}),
  }).where(eq(categories.id, id)).returning();
  return category ? res.json({ success: true, data: category }) : notFound();
};
