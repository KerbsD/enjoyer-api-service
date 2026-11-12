import { and, eq, ne } from "drizzle-orm";
import type { Request, RequestHandler, Response } from "express";
import { db } from "../db/index.ts";
import { carts, shopTables, tableSessions } from "../db/schema.ts";
import type { Cart, TableSession } from "../db/schema.ts";
import { isWellFormedToken } from "../lib/tokens.ts";

export type TableSessionContext = {
  table: { id: number; name: string; orderLimit: number };
  session: TableSession;
  cart: Cart;
};

export const getTableSessionContext = (
  res: Response,
): TableSessionContext => res.locals.tableSession as TableSessionContext;

const invalidTable = (res: Response) =>
  res.status(404).json({
    success: false,
    code: "INVALID_TABLE_QR",
    message:
      "This table QR code is invalid or no longer active. Please ask staff for help.",
  });

const sessionRequired = (res: Response) =>
  res.status(409).json({
    success: false,
    code: "TABLE_SESSION_REQUIRED",
    message: "Scan the table QR code again to start or join this table.",
  });

// Public cart authentication: the printed QR token is the only credential.
// It is sent in X-Table-Token, never in a URL, so it stays out of request logs.
export const requireTableSession: RequestHandler = async (
  req: Request,
  res: Response,
  next,
) => {
  const token = req.get("x-table-token");
  if (!isWellFormedToken(token)) return invalidTable(res);

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
  if (!table?.active) return invalidTable(res);

  const [session] = await db
    .select()
    .from(tableSessions)
    .where(
      and(
        eq(tableSessions.tableId, table.id),
        ne(tableSessions.status, "closed"),
      ),
    )
    .limit(1);
  if (!session) return sessionRequired(res);

  const [cart] = await db
    .select()
    .from(carts)
    .where(eq(carts.tableSessionId, session.id))
    .limit(1);
  if (!cart) return sessionRequired(res);

  res.locals.tableSession = {
    table: { id: table.id, name: table.name, orderLimit: table.orderLimit },
    session,
    cart,
  } satisfies TableSessionContext;
  next();
};
