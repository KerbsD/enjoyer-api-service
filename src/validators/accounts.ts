import { z } from "zod";
import { ROLES } from "../db/schema.ts";
import { validateBody, validateQuery } from "../lib/validate.ts";
import { emailSchema } from "./auth.ts";
import { booleanQueryField, paginationFields } from "./shared.ts";

// ---------- Shared fields ----------

const nameField = z
  .string({ error: "Name is required." })
  .trim()
  .min(1, "Name is required.")
  .max(100, "Name is too long.");

const roleField = z.enum(ROLES, {
  error: `Role must be one of: ${ROLES.join(", ")}.`,
});

// ---------- Schemas ----------

export const createAccountSchema = z.object({
  name: nameField,
  email: emailSchema.shape.email,
  role: roleField,
});

export const updateAccountSchema = z.strictObject({
  name: nameField.optional(),
  role: roleField.optional(),
}).refine((value) => value.role !== undefined || value.name !== undefined, {
  message: "Provide name or role to update.",
});
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export const validateUpdateAccount = validateBody(updateAccountSchema);

// Admin list query: ?role=staff&active=true&search=ana&limit=...&offset=...
export const listAccountsQuerySchema = z.object({
  ...paginationFields(50),
  role: roleField.optional(),
  active: booleanQueryField("active").optional(),
  search: z.string().trim().max(100, "Search is too long.").optional(),
  sort: z.enum(["createdAt", "name"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("asc"),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;

// ---------- Ready-to-use middlewares ----------

export const validateCreateAccount = validateBody(createAccountSchema);
export const validateListAccountsQuery = validateQuery(listAccountsQuerySchema);
