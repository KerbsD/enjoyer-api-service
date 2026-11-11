import type { Request, Response } from "express";
import { db } from "../../db/index.ts";
import { categories } from "../../db/schema.ts";
import type { CreateCategoryInput } from "../../validators/categories.ts";

export const handleCreateCategory = async (req: Request, res: Response) => {
  const { name, sortOrder } = req.body as CreateCategoryInput;
  const [category] = await db
    .insert(categories)
    .values({ name, sortOrder })
    .returning();
  if (!category) throw new Error("category insert returned no row");
  return res.status(201).json({ success: true, data: category });
};
