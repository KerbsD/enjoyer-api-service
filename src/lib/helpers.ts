const INT4_MAX = 2_147_483_647;

// Strict positive int4. Rejects "1e3", "0x10", "-1", "1.5", arrays and values
// that would overflow a Postgres integer column.
export const parseId = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^\d{1,10}$/.test(value)) return null;
  const id = Number(value);
  return id > 0 && id <= INT4_MAX ? id : null;
};

// Weekday path/query value: 0 = Sunday ... 6 = Saturday.
export const parseDayOfWeek = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^[0-6]$/.test(value)) return null;
  return Number(value);
};

const readStringField = (value: unknown, field: string): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const hit = (value as Record<string, unknown>)[field];
  return typeof hit === "string" ? hit : undefined;
};

const causeOf = (err: unknown): unknown =>
  typeof err === "object" && err !== null
    ? (err as { cause?: unknown }).cause
    : undefined;

// Drizzle may wrap driver errors, so check both places
export const pgCode = (err: unknown): string | undefined =>
  readStringField(err, "code") ?? readStringField(causeOf(err), "code");

export const pgConstraint = (err: unknown): string | undefined =>
  readStringField(err, "constraint") ??
  readStringField(causeOf(err), "constraint");
