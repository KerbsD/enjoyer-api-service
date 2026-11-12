// Money is stored as numeric(10,2) and returned by Drizzle as a canonical
// decimal string. All arithmetic happens in integer centavos so no floating
// point rounding can change a total.
const MONEY_PATTERN = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/;

export const toCents = (value: string): number => {
  if (!MONEY_PATTERN.test(value))
    throw new Error(`Invalid money value: ${value.slice(0, 32)}`);
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
};

export const fromCents = (cents: number): string => {
  if (!Number.isSafeInteger(cents) || cents < 0)
    throw new Error("Invalid cent amount");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
};
