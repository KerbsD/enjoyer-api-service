import { z } from "zod";
import { validateBody, validateQuery } from "../lib/validate.ts";
import { paginationFields } from "./shared.ts";

const nameField = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .max(100, "Name is too long.");
const sortOrderField = z.number().int().min(0).max(2_147_483_647);

export const createCategorySchema = z.strictObject({
  name: nameField,
  sortOrder: sortOrderField.default(0),
});

export const updateCategorySchema = z
  .strictObject({
    name: nameField.optional(),
    sortOrder: sortOrderField.optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.sortOrder !== undefined,
    {
      message: "Provide name or sortOrder to update.",
    },
  );

export const listCategoriesQuerySchema = z.strictObject(paginationFields(50));

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;
export const validateCreateCategory = validateBody(createCategorySchema);
export const validateUpdateCategory = validateBody(updateCategorySchema);
export const validateListCategoriesQuery = validateQuery(
  listCategoriesQuerySchema,
);
