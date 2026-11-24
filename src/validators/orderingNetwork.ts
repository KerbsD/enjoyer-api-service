import { z } from "zod";
import { validateBody } from "../lib/validate.ts";

const ip = z.string().trim().min(1).max(45);
export const validateEnrollTerminal = validateBody(
  z.strictObject({ expectedAddress: ip }),
);
export const validateOrderingNetwork = validateBody(
  z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("override"), address: ip }),
    z.strictObject({ action: z.literal("disable") }),
  ]),
);
