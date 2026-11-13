import { z } from "zod";
import { validateBody } from "../lib/validate.ts";

// Operational bounds, not product rules: a table should not stay open for more
// than a day, and a first order should not wait around for hours.
export const updateSettingsSchema = z
  .strictObject({
    idleTimeoutMinutes: z.number().int().min(1).max(1_440).optional(),
    confirmationExpiryMinutes: z.number().int().min(1).max(120).optional(),
  })
  .refine(
    (value) =>
      value.idleTimeoutMinutes !== undefined ||
      value.confirmationExpiryMinutes !== undefined,
    { message: "Provide a setting to update." },
  );

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
export const validateUpdateSettings = validateBody(updateSettingsSchema);
