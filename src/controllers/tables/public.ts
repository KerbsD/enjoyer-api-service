import { and, eq, ne } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db/index.ts";
import { carts, shopTables, tableSessions } from "../../db/schema.ts";
import type { TableSession } from "../../db/schema.ts";
import { CURRENCY } from "../../configs/currency.ts";
import { loadCartView } from "../../lib/cart.ts";
import { readShopSettings } from "../../lib/settings.ts";
import { idleCutoff } from "../../lib/tableSessions.ts";
import { isWellFormedToken } from "../../lib/tokens.ts";

const invalidTable = (res: Response) =>
  res.status(404).json({
    success: false,
    code: "INVALID_TABLE_QR",
    message:
      "This table QR code is invalid or no longer active. Please ask staff for help.",
  });

export const resolveTable = async (req: Request, res: Response) => {
  const { token } = req.body as { token: string };

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
  // Resolving a scan does not open a session; /tables/open does that.
  return res.json({
    success: true,
    data: { id: table.id, name: table.name, orderLimit: table.orderLimit },
  });
};

// Creates (or reuses) the provisional session and shared cart for a scan. The
// table row lock serializes simultaneous scans, so the partial unique index is
// never hit by normal traffic. A session idle longer than the configured
// timeout is closed first so the next customers get a fresh cart.
export const openTable = async (req: Request, res: Response) => {
  const { token } = req.body as { token: string };
  if (!isWellFormedToken(token)) return invalidTable(res);

  const settings = await readShopSettings();
  const now = new Date();
  const cutoff = idleCutoff(settings, now);

  const result = await db.transaction(async (tx) => {
    const [table] = await tx
      .select({
        id: shopTables.id,
        name: shopTables.name,
        orderLimit: shopTables.orderLimit,
        active: shopTables.active,
      })
      .from(shopTables)
      .where(eq(shopTables.qrToken, token))
      .limit(1)
      .for("update");
    if (!table?.active) return { kind: "invalid" as const };

    let session: TableSession | undefined;
    [session] = await tx
      .select()
      .from(tableSessions)
      .where(
        and(
          eq(tableSessions.tableId, table.id),
          ne(tableSessions.status, "closed"),
        ),
      )
      .limit(1)
      .for("update");

    let created = false;
    if (session && session.lastActivityAt.getTime() < cutoff.getTime()) {
      await tx
        .update(tableSessions)
        .set({
          status: "closed",
          closedAt: now,
          closedBy: "timeout",
          closedByUserId: null,
        })
        .where(eq(tableSessions.id, session.id));
      await tx.delete(carts).where(eq(carts.tableSessionId, session.id));
      session = undefined;
    }

    if (!session) {
      [session] = await tx
        .insert(tableSessions)
        .values({ tableId: table.id, lastActivityAt: now })
        .returning();
      await tx.insert(carts).values({ tableSessionId: session.id });
      created = true;
    } else {
      [session] = await tx
        .update(tableSessions)
        .set({ lastActivityAt: now })
        .where(eq(tableSessions.id, session.id))
        .returning();
    }

    let [cart] = await tx
      .select()
      .from(carts)
      .where(eq(carts.tableSessionId, session.id))
      .limit(1);
    if (!cart)
      [cart] = await tx
        .insert(carts)
        .values({ tableSessionId: session.id })
        .returning();

    return {
      kind: "ok" as const,
      table,
      session,
      cart,
      created,
    };
  });

  if (result.kind === "invalid") return invalidTable(res);
  return res.json({
    success: true,
    currency: CURRENCY,
    data: {
      table: {
        id: result.table.id,
        name: result.table.name,
        orderLimit: result.table.orderLimit,
      },
      session: {
        id: result.session.id,
        status: result.session.status,
        createdAt: result.session.createdAt,
        startedAt: result.session.startedAt,
        lastActivityAt: result.session.lastActivityAt,
      },
      cart: await loadCartView(result.cart.id),
      created: result.created,
    },
  });
};
