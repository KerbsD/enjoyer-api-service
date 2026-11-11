import { z } from "zod";
import { validateBody, validateQuery } from "../lib/validate.ts";
import { booleanQueryField, paginationFields } from "./shared.ts";

// Accept a JSON number or decimal string; reject extra precision rather than
// silently rounding prices. Always pass a canonical decimal string to Postgres.
export const priceSchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value))
  .refine((value) => /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(value), {
    message:
      "Price must be between 0 and 99999999.99, with at most two decimal places.",
  })
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return `${whole}.${fraction.padEnd(2, "0")}`;
  });

const idField = z.number().int().min(1).max(2_147_483_647);
const fields = {
  categoryId: idField,
  name: z.string().trim().min(1, "Name is required.").max(100),
  description: z.string().trim().max(2000),
  price: priceSchema,
  isSpicy: z.boolean(),
  isAvailable: z.boolean(),
  isHidden: z.boolean(),
  sortOrder: z.number().int().min(0).max(2_147_483_647),
};

export const createMenuItemSchema = z.strictObject({
  ...fields,
  description: fields.description.default(""),
  isSpicy: fields.isSpicy.default(false),
  isAvailable: fields.isAvailable.default(true),
  isHidden: fields.isHidden.default(false),
  sortOrder: fields.sortOrder.default(0),
});
export const updateMenuItemSchema = z
  .strictObject(fields)
  .partial()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Provide at least one field to update.",
  });
export const availabilitySchema = z.strictObject({ isAvailable: z.boolean() });
export const listMenuItemsQuerySchema = z.strictObject({
  ...paginationFields(50),
  categoryId: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .transform(Number)
    .pipe(idField)
    .optional(),
  isAvailable: booleanQueryField("isAvailable").optional(),
  isHidden: booleanQueryField("isHidden").optional(),
});
export type CreateMenuItemInput = z.infer<typeof createMenuItemSchema>;
export type UpdateMenuItemInput = z.infer<typeof updateMenuItemSchema>;
export type ListMenuItemsQuery = z.infer<typeof listMenuItemsQuerySchema>;
export const validateCreateMenuItem = validateBody(createMenuItemSchema);
export const validateUpdateMenuItem = validateBody(updateMenuItemSchema);
export const validateAvailability = validateBody(availabilitySchema);
export const validateListMenuItemsQuery = validateQuery(
  listMenuItemsQuerySchema,
);
