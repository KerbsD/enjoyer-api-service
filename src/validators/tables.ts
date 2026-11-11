import { z } from "zod";
import { validateBody, validateQuery } from "../lib/validate.ts";
import { booleanQueryField, paginationFields } from "./shared.ts";

const fields = {
  name: z.string().trim().min(1).max(100),
  orderLimit: z.number().int().min(1).max(2_147_483_647),
  active: z.boolean(),
};
export const createTableSchema = z.strictObject({
  ...fields, orderLimit: fields.orderLimit.default(5), active: fields.active.default(true),
});
export const updateTableSchema = z.strictObject(fields).partial()
  .refine(value => Object.values(value).some(v => v !== undefined), { message: "Provide a field to update." });
export const listTablesQuerySchema = z.strictObject({
  ...paginationFields(50), active: booleanQueryField("active").optional(),
});
export const qrQuerySchema = z.strictObject({ format: z.enum(["png", "svg"]).default("png") });
// Shape errors are handled as unknown QR codes by the handler, without a DB hit.
export const resolveTableSchema = z.strictObject({ token: z.string().min(1).max(256) });
export const validateCreateTable = validateBody(createTableSchema);
export const validateUpdateTable = validateBody(updateTableSchema);
export const validateListTables = validateQuery(listTablesQuerySchema);
export const validateQrQuery = validateQuery(qrQuerySchema);
export const validateResolveTable = validateBody(resolveTableSchema);
export type ListTablesQuery = z.infer<typeof listTablesQuerySchema>;
