import { z } from "zod";

// Shared limit/offset pagination for list endpoints: ?limit=50&offset=0
export const paginationFields = (defaultLimit = 50) => ({
  limit: z.coerce
    .number()
    .int("limit must be an integer.")
    .min(1, "limit must be at least 1.")
    .max(100, "limit must be at most 100.")
    .default(defaultLimit),
  offset: z.coerce
    .number()
    .int("offset must be an integer.")
    .min(0, "offset must be at least 0.")
    .default(0),
});

// Query-string booleans: ?active=true / ?active=false
export const booleanQueryField = (label: string) =>
  z
    .enum(["true", "false"], { error: `${label} must be true or false.` })
    .transform((value) => value === "true");
