import { z } from "zod";
import { validateBody, validateQuery } from "../lib/validate.ts";
import { paginationFields } from "./shared.ts";

const timeField = z
  .string()
  .regex(
    /^([01]\d|2[0-3]):[0-5]\d$/,
    "Time must be a 24-hour value like 08:30.",
  );

export const isCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

export const calendarDateField = z
  .string()
  .refine(isCalendarDate, "Date must be a real date in YYYY-MM-DD format.");

// Shared by weekly hours and holiday overrides. Times are shop-local, and the
// business has no overnight hours, so close must be later than open.
export const openingHoursSchema = z
  .strictObject({
    closed: z.boolean(),
    openTime: timeField.optional(),
    closeTime: timeField.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.closed) {
      if (value.openTime !== undefined || value.closeTime !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "A closed day cannot have opening hours.",
        });
      return;
    }
    if (value.openTime === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["openTime"],
        message: "openTime is required when the day is open.",
      });
    if (value.closeTime === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["closeTime"],
        message: "closeTime is required when the day is open.",
      });
    if (
      value.openTime !== undefined &&
      value.closeTime !== undefined &&
      value.closeTime <= value.openTime
    )
      ctx.addIssue({
        code: "custom",
        path: ["closeTime"],
        message:
          "closeTime must be later than openTime; overnight hours are not supported.",
      });
  });

export const listHolidayOverridesQuerySchema = z
  .strictObject({
    ...paginationFields(100),
    from: calendarDateField.optional(),
    to: calendarDateField.optional(),
  })
  .refine(
    (value) => !value.from || !value.to || value.from <= value.to,
    { message: "from must not be later than to." },
  );

export type OpeningHoursInput = z.infer<typeof openingHoursSchema>;
export type ListHolidayOverridesQuery = z.infer<
  typeof listHolidayOverridesQuerySchema
>;

export const validateOpeningHours = validateBody(openingHoursSchema);
export const validateListHolidayOverrides = validateQuery(
  listHolidayOverridesQuerySchema,
);
