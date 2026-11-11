import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db/index.ts";
import { shopTables } from "../../db/schema.ts";
import { isWellFormedToken } from "../../lib/tokens.ts";

export const resolveTable = async (req: Request, res: Response) => {
  const invalid = () =>
    res
      .status(404)
      .json({
        success: false,
        code: "INVALID_TABLE_QR",
        message:
          "This table QR code is invalid or no longer active. Please ask staff for help.",
      });
  const { token } = req.body as { token: string };
  if (!isWellFormedToken(token)) return invalid();
  const [table] = await db
    .select({
      id: shopTables.id,
      name: shopTables.name,
      orderLimit: shopTables.orderLimit,
      active: shopTables.active,
    })
    .from(shopTables)
    .where(eq(shopTables.qrToken, token))
    .limit(1);
  if (!table?.active) return invalid();
  // Resolving a scan does not open a session; staff confirmation will do that.
  return res.json({
    success: true,
    data: { id: table.id, name: table.name, orderLimit: table.orderLimit },
  });
};
