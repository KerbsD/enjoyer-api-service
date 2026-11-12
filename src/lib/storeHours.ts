import { and, asc, gte, lte } from "drizzle-orm";
import { db } from "../db/index.ts";
import { holidayOverrides, storeHours } from "../db/schema.ts";
import { readShopSettings } from "./settings.ts";
import type { ShopSettings } from "./settings.ts";

export type WeeklyHoursRow = {
  dayOfWeek: number;
  openTime: string | null;
  closeTime: string | null;
  closed: boolean;
};

export type HolidayRow = {
  date: string;
  openTime: string | null;
  closeTime: string | null;
  closed: boolean;
};

export type StoreDaySource = "weekly" | "holiday" | "unconfigured" | "closed";

export type StoreDay = {
  date: string;
  dayOfWeek: number;
  openTime: string | null;
  closeTime: string | null;
  closed: boolean;
  source: StoreDaySource;
};

export type StoreStatus = {
  isOpen: boolean;
  configured: boolean;
  timezone: string;
  localDate: string;
  localTime: string;
  today: StoreDay;
  closesAt: string | null;
  nextOpen: string | null;
  week: StoreDay[];
};

type LocalDate = { year: number; month: number; day: number };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_SCAN_LIMIT = 14;
const WEEK_LENGTH = 7;

const pad2 = (value: number): string => String(value).padStart(2, "0");

const dateString = ({ year, month, day }: LocalDate): string =>
  `${year}-${pad2(month)}-${pad2(day)}`;

export const normalizeTime = (value: string | null): string | null =>
  value === null ? null : value.slice(0, 5);

const timeToMinutes = (value: string): number => {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
};

type ZonedParts = LocalDate & {
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
};

export const zonedParts = (instant: Date, timeZone: string): ZonedParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(instant);
  const value = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekday = WEEKDAYS.indexOf(
    value("weekday") as (typeof WEEKDAYS)[number],
  );
  if (weekday < 0) throw new Error("Could not resolve weekday");

  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    // Some ICU versions render midnight as 24 with h23.
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
    second: Number(value("second")),
    dayOfWeek: weekday,
  };
};

const addDays = (date: LocalDate, days: number): LocalDate => {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
};

const dayOfWeekOf = (date: LocalDate): number =>
  new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();

const offsetMs = (instant: Date, timeZone: string): number => {
  const parts = zonedParts(instant, timeZone);
  const utcLike = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return utcLike - Math.floor(instant.getTime() / 1000) * 1000;
};

// Converts a wall-clock time in the shop timezone to a real UTC instant.
// Iterating twice handles the offset at the target instant (and DST zones,
// even though the shop itself has no DST and no overnight hours).
const zonedTimeToInstant = (
  localDate: LocalDate,
  time: string,
  timeZone: string,
): Date => {
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(
    localDate.year,
    localDate.month - 1,
    localDate.day,
    hour,
    minute,
  );
  let timestamp = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    timestamp = target - offsetMs(new Date(timestamp), timeZone);
  }
  return new Date(timestamp);
};

const resolveDay = (
  date: LocalDate,
  weekly: WeeklyHoursRow[],
  holidays: HolidayRow[],
  configured: boolean,
): StoreDay => {
  const dateKey = dateString(date);
  const dayOfWeek = dayOfWeekOf(date);
  const holiday = holidays.find((row) => row.date === dateKey);
  if (holiday) {
    return {
      date: dateKey,
      dayOfWeek,
      openTime: normalizeTime(holiday.openTime),
      closeTime: normalizeTime(holiday.closeTime),
      closed: holiday.closed,
      source: "holiday",
    };
  }

  const weeklyDay = weekly.find((row) => row.dayOfWeek === dayOfWeek);
  if (weeklyDay) {
    return {
      date: dateKey,
      dayOfWeek,
      openTime: normalizeTime(weeklyDay.openTime),
      closeTime: normalizeTime(weeklyDay.closeTime),
      closed: weeklyDay.closed,
      source: "weekly",
    };
  }

  return {
    date: dateKey,
    dayOfWeek,
    openTime: null,
    closeTime: null,
    // No configured schedule at all means ordering is unrestricted. Once any
    // weekday is configured, an unconfigured day is closed.
    closed: configured,
    source: configured ? "closed" : "unconfigured",
  };
};

export const resolveStoreStatus = (input: {
  now: Date;
  settings: ShopSettings;
  weekly: WeeklyHoursRow[];
  holidays: HolidayRow[];
}): StoreStatus => {
  const { now, settings, weekly, holidays } = input;
  const local = zonedParts(now, settings.shopTimezone);
  const configured = weekly.length > 0;
  const todayDate: LocalDate = {
    year: local.year,
    month: local.month,
    day: local.day,
  };
  const today = resolveDay(todayDate, weekly, holidays, configured);
  const localMinutes = local.hour * 60 + local.minute;

  const isOpen =
    !today.closed &&
    (today.openTime === null || today.closeTime === null
      ? today.source === "unconfigured"
      : localMinutes >= timeToMinutes(today.openTime) &&
        localMinutes < timeToMinutes(today.closeTime));

  let closesAt: string | null = null;
  if (isOpen && today.closeTime !== null)
    closesAt = zonedTimeToInstant(
      todayDate,
      today.closeTime,
      settings.shopTimezone,
    ).toISOString();

  let nextOpen: string | null = null;
  if (!isOpen) {
    for (let offset = 0; offset < DAY_SCAN_LIMIT; offset++) {
      const date = addDays(todayDate, offset);
      const day = resolveDay(date, weekly, holidays, configured);
      if (day.closed || day.openTime === null) continue;
      const opening = zonedTimeToInstant(
        date,
        day.openTime,
        settings.shopTimezone,
      );
      if (opening.getTime() > now.getTime()) {
        nextOpen = opening.toISOString();
        break;
      }
    }
  }

  const week: StoreDay[] = [];
  for (let offset = 0; offset < WEEK_LENGTH; offset++) {
    week.push(
      resolveDay(
        addDays(todayDate, offset),
        weekly,
        holidays,
        configured,
      ),
    );
  }

  return {
    isOpen,
    configured,
    timezone: settings.shopTimezone,
    localDate: today.date,
    localTime: `${pad2(local.hour)}:${pad2(local.minute)}`,
    today,
    closesAt,
    nextOpen,
    week,
  };
};

export const getStoreStatus = async (
  now = new Date(),
): Promise<StoreStatus> => {
  const settings = await readShopSettings();
  const local = zonedParts(now, settings.shopTimezone);
  const today: LocalDate = {
    year: local.year,
    month: local.month,
    day: local.day,
  };
  const from = dateString(today);
  const to = dateString(addDays(today, DAY_SCAN_LIMIT - 1));

  const [weekly, holidays] = await Promise.all([
    db
      .select({
        dayOfWeek: storeHours.dayOfWeek,
        openTime: storeHours.openTime,
        closeTime: storeHours.closeTime,
        closed: storeHours.closed,
      })
      .from(storeHours)
      .orderBy(asc(storeHours.dayOfWeek)),
    db
      .select({
        date: holidayOverrides.date,
        openTime: holidayOverrides.openTime,
        closeTime: holidayOverrides.closeTime,
        closed: holidayOverrides.closed,
      })
      .from(holidayOverrides)
      .where(
        and(
          gte(holidayOverrides.date, from),
          lte(holidayOverrides.date, to),
        ),
      )
      .orderBy(asc(holidayOverrides.date)),
  ]);

  return resolveStoreStatus({ now, settings, weekly, holidays });
};
