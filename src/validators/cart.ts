import { z } from "zod";
import { validateBody, validateQuery } from "../lib/validate.ts";

const INT4_MAX = 2_147_483_647;
const idField = z.number().int().min(1).max(INT4_MAX);
const versionField = z.number().int().min(0);
const cartIdField = z.uuid();
const quantityField = z.number().int().min(1).max(99);
const noteField = z.string().trim().max(500);
const optionIdsField = z
  .array(idField)
  .max(50)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Option IDs must be unique.",
  );

export const addCartItemSchema = z.strictObject({
  menuItemId: idField,
  quantity: quantityField.default(1),
  optionIds: optionIdsField.default([]),
  note: noteField.default(""),
  cartId: cartIdField,
  version: versionField,
});

export const updateCartItemSchema = z
  .strictObject({
    quantity: quantityField.optional(),
    optionIds: optionIdsField.optional(),
    note: noteField.optional(),
    cartId: cartIdField,
    version: versionField,
  })
  .refine(
    (value) =>
      value.quantity !== undefined ||
      value.optionIds !== undefined ||
      value.note !== undefined,
    { message: "Provide a quantity, options, or note to update." },
  );

export const cartVersionQuerySchema = z.strictObject({
  cartId: cartIdField,
  version: z.coerce.number().int().min(0),
});

export type AddCartItemInput = z.infer<typeof addCartItemSchema>;
export type UpdateCartItemInput = z.infer<typeof updateCartItemSchema>;
export type CartVersionQuery = z.infer<typeof cartVersionQuerySchema>;

export const validateAddCartItem = validateBody(addCartItemSchema);
export const validateUpdateCartItem = validateBody(updateCartItemSchema);
export const validateCartVersionQuery = validateQuery(cartVersionQuerySchema);
