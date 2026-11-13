import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { carts, shopTables, tableSessions, users } from "../../db/schema.ts";
import { can } from "../permissions.ts";
import { readShopSettings } from "../settings.ts";
import { idleCutoff } from "../tableSessions.ts";
import { verifyAccessToken } from "../tokens.ts";
import type { RealtimeScope } from "./revisions.ts";

export type AccessFailure = { status: number; code: string; message: string };
export type RealtimeAccess = {
  scope: RealtimeScope;
  key: string;
  check: () => Promise<AccessFailure | null>;
};

const invalidSession = (): AccessFailure => ({
  status: 409,
  code: "TABLE_SESSION_REQUIRED",
  message: "This table session has ended. Scan the table QR code again.",
});

export const tableAccess = (
  tableId: number,
  sessionId: string,
  token: string,
): RealtimeAccess => ({
  scope: { kind: "table", tableId, sessionId },
  key: `table:${tableId}`,
  async check() {
    const [row] = await db
      .select({
        active: shopTables.active,
        token: shopTables.qrToken,
        status: tableSessions.status,
        lastActivityAt: tableSessions.lastActivityAt,
        cartId: carts.id,
      })
      .from(tableSessions)
      .innerJoin(shopTables, eq(tableSessions.tableId, shopTables.id))
      .leftJoin(carts, eq(carts.tableSessionId, tableSessions.id))
      .where(
        and(
          eq(tableSessions.id, sessionId),
          eq(tableSessions.tableId, tableId),
        ),
      )
      .limit(1);
    if (!row) return invalidSession();
    if (!row.active || row.token !== token)
      return {
        status: 404,
        code: "INVALID_TABLE_QR",
        message: "This table QR code is no longer active.",
      };
    if (row.status === "closed" || !row.cartId) return invalidSession();
    const settings = await readShopSettings();
    if (row.lastActivityAt < idleCutoff(settings, new Date()))
      return invalidSession();
    return null;
  },
});

export const staffAccess = (userId: number, token: string): RealtimeAccess => ({
  scope: { kind: "staff" },
  key: `staff:${userId}`,
  async check() {
    try {
      if (verifyAccessToken(token).id !== userId) throw new Error("Wrong user");
    } catch {
      return {
        status: 401,
        code: "AUTH_REQUIRED",
        message: "Refresh your access token and reconnect.",
      };
    }
    const [account] = await db
      .select({ active: users.active, role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!account?.active)
      return {
        status: 401,
        code: "AUTH_REQUIRED",
        message: "Your account is no longer active.",
      };
    if (!can(account.role, "board:view") || !can(account.role, "table:view"))
      return {
        status: 403,
        code: "FORBIDDEN",
        message: "You no longer have permission to view these updates.",
      };
    return null;
  },
});
