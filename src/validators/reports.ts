import { z } from "zod";
import { ORDER_STATUSES, PAYMENT_STATUSES } from "../db/schema.ts";
import { validateQuery } from "../lib/validate.ts";
import { isCalendarDate } from "./storeHours.ts";
import { paginationFields } from "./shared.ts";

const date = z
  .string()
  .refine(isCalendarDate, "Date must be a real date in YYYY-MM-DD format.");
const int4 = z.coerce.number().int().min(1).max(2_147_483_647);
const rangeFields = {
  from: date.optional(),
  to: date.optional(),
};
const datePair = <T extends z.ZodType>(schema: T) =>
  schema.superRefine((value, ctx) => {
    const fields = value as { from?: string; to?: string };
    if ((fields.from === undefined) !== (fields.to === undefined))
      ctx.addIssue({
        code: "custom",
        path: [fields.from === undefined ? "from" : "to"],
        message: "from and to must be supplied together.",
      });
    if (fields.from && fields.to && fields.from > fields.to)
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "to must be on or after from.",
      });
  });

export const dashboardQuerySchema = datePair(
  z.strictObject({
    period: z.enum(["today", "7days", "30days"]).optional(),
    ...rangeFields,
  }),
).refine((value) => !(value.period && value.from), {
  path: ["period"],
  message: "Choose a period or a custom from/to range, not both.",
});

export const historyQuerySchema = datePair(
  z.strictObject({
    ...rangeFields,
    tableId: int4.optional(),
    status: z.enum(ORDER_STATUSES).optional(),
    paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
    itemId: int4.optional(),
    q: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
);

export const exportQuerySchema = datePair(
  z.strictObject(rangeFields).superRefine((value, ctx) => {
    if (!value.from)
      ctx.addIssue({
        code: "custom",
        path: ["from"],
        message: "A date range is required for export.",
      });
  }),
);

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export type ExportQuery = z.infer<typeof exportQuerySchema>;
export const validateDashboardQuery = validateQuery(dashboardQuerySchema);
export const validateHistoryQuery = validateQuery(historyQuerySchema);
export const validateExportQuery = validateQuery(exportQuerySchema);
