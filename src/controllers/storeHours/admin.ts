import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db/index.ts";
import { holidayOverrides, storeHours } from "../../db/schema.ts";
import { parseDayOfWeek } from "../../lib/helpers.ts";
import { readShopSettings } from "../../lib/settings.ts";
import { normalizeTime } from "../../lib/storeHours.ts";
import {
  isCalendarDate,
  type ListHolidayOverridesQuery,
  type OpeningHoursInput,
} from "../../validators/storeHours.ts";

const dayView = (
  row: typeof storeHours.$inferSelect | undefined,
  dayOfWeek: number,
) =>
  row
    ? {
        dayOfWeek,
        openTime: normalizeTime(row.openTime),
        closeTime: normalizeTime(row.closeTime),
        closed: row.closed,
        configured: true,
      }
    : {
        dayOfWeek,
        openTime: null,
        closeTime: null,
        closed: true,
        configured: false,
      };

const badDay = (res: Response) =>
  res.status(400).json({
    success: false,
    message: "dayOfWeek must be an integer from 0 (Sunday) to 6 (Saturday).",
  });

export const getStoreHours = async (_req: Request, res: Response) => {
  const [settings, rows] = await Promise.all([
    readShopSettings(),
    db.select().from(storeHours).orderBy(asc(storeHours.dayOfWeek)),
  ]);
  const byDay = new Map(rows.map((row) => [row.dayOfWeek, row]));
  return res.json({
    success: true,
    timezone: settings.shopTimezone,
    data: Array.from({ length: 7 }, (_, dayOfWeek) =>
      dayView(byDay.get(dayOfWeek), dayOfWeek),
    ),
  });
};

export const upsertStoreHours = async (req: Request, res: Response) => {
  const dayOfWeek = parseDayOfWeek(req.params.dayOfWeek);
  if (dayOfWeek === null) return badDay(res);
  const input = req.body as OpeningHoursInput;
  const values = {
    dayOfWeek,
    openTime: input.closed ? null : input.openTime!,
    closeTime: input.closed ? null : input.closeTime!,
    closed: input.closed,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(storeHours)
    .values(values)
    .onConflictDoUpdate({
      target: storeHours.dayOfWeek,
      set: values,
    })
    .returning();
  if (!row) throw new Error("store hour upsert returned no row");
  return res.json({ success: true, data: dayView(row, dayOfWeek) });
};

const holidayView = (row: typeof holidayOverrides.$inferSelect) => ({
  date: row.date,
  openTime: normalizeTime(row.openTime),
  closeTime: normalizeTime(row.closeTime),
  closed: row.closed,
});

const badDate = (res: Response) =>
  res.status(400).json({
    success: false,
    message: "Date must be a real date in YYYY-MM-DD format.",
  });

export const listHolidayOverrides = async (req: Request, res: Response) => {
  const { from, to, limit, offset } = res.locals
    .query as ListHolidayOverridesQuery;
  const where = and(
    from === undefined ? undefined : gte(holidayOverrides.date, from),
    to === undefined ? undefined : lte(holidayOverrides.date, to),
  );
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(holidayOverrides)
      .where(where)
      .orderBy(asc(holidayOverrides.date))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(holidayOverrides)
      .where(where),
  ]);
  const total = count?.total ?? 0;
  return res.json({
    success: true,
    data: rows.map(holidayView),
    pagination: {
      limit,
      offset,
      total,
      hasMore: offset + rows.length < total,
    },
  });
};

export const upsertHolidayOverride = async (req: Request, res: Response) => {
  const dateParam = req.params.date;
  const date = typeof dateParam === "string" ? dateParam : undefined;
  if (!date || !isCalendarDate(date)) return badDate(res);
  const input = req.body as OpeningHoursInput;
  const values = {
    date,
    openTime: input.closed ? null : input.openTime!,
    closeTime: input.closed ? null : input.closeTime!,
    closed: input.closed,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(holidayOverrides)
    .values(values)
    .onConflictDoUpdate({ target: holidayOverrides.date, set: values })
    .returning();
  if (!row) throw new Error("holiday override upsert returned no row");
  return res.json({ success: true, data: holidayView(row) });
};

export const deleteHolidayOverride = async (req: Request, res: Response) => {
  const dateParam = req.params.date;
  const date = typeof dateParam === "string" ? dateParam : undefined;
  if (!date || !isCalendarDate(date)) return badDate(res);
  const [row] = await db
    .delete(holidayOverrides)
    .where(eq(holidayOverrides.date, date))
    .returning({ date: holidayOverrides.date });
  return row
    ? res.sendStatus(204)
    : res
        .status(404)
        .json({ success: false, message: "Holiday override not found." });
};
