import { inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { settings } from "../db/schema.ts";

// Product defaults from specs.md section 6. The migration seeds these rows, but
// reads fall back to the same values so a manually deleted row cannot take the
// API down or silently change behavior.
export const SETTING_KEYS = [
  "idle_timeout_minutes",
  "confirmation_expiry_minutes",
  "shop_timezone",
] as const;

export const DEFAULT_SHOP_SETTINGS = {
  idleTimeoutMinutes: 180,
  confirmationExpiryMinutes: 10,
  shopTimezone: "Asia/Manila",
} as const;

export type ShopSettings = {
  idleTimeoutMinutes: number;
  confirmationExpiryMinutes: number;
  shopTimezone: string;
};

const positiveInteger = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
};

export const isValidTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};

export const readShopSettings = async (): Promise<ShopSettings> => {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [...SETTING_KEYS]));
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const timezone =
    values.get("shop_timezone") ?? DEFAULT_SHOP_SETTINGS.shopTimezone;

  return {
    idleTimeoutMinutes: positiveInteger(
      values.get("idle_timeout_minutes"),
      DEFAULT_SHOP_SETTINGS.idleTimeoutMinutes,
    ),
    confirmationExpiryMinutes: positiveInteger(
      values.get("confirmation_expiry_minutes"),
      DEFAULT_SHOP_SETTINGS.confirmationExpiryMinutes,
    ),
    shopTimezone: isValidTimeZone(timezone)
      ? timezone
      : DEFAULT_SHOP_SETTINGS.shopTimezone,
  };
};
