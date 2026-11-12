import { and, asc, inArray, lt, ne } from "drizzle-orm";
import { db } from "../db/index.ts";
import { carts, tableSessions } from "../db/schema.ts";
import { readShopSettings } from "./settings.ts";
import type { ShopSettings } from "./settings.ts";

export const idleCutoff = (settings: ShopSettings, now: Date): Date =>
  new Date(now.getTime() - settings.idleTimeoutMinutes * 60_000);

// Closes every non-closed session whose last activity is older than the
// configured idle timeout. The cart is discarded with the session; the session
// row is kept for history. Orders (a later phase) are not touched here: the
// product decision is that auto-close proceeds even with unpaid orders.
export const closeIdleTableSessions = async (
  now = new Date(),
): Promise<number> => {
  const settings = await readShopSettings();
  const cutoff = idleCutoff(settings, now);

  return db.transaction(async (tx) => {
    const stale = await tx
      .select({ id: tableSessions.id })
      .from(tableSessions)
      .where(
        and(
          ne(tableSessions.status, "closed"),
          lt(tableSessions.lastActivityAt, cutoff),
        ),
      )
      // Deterministic lock order keeps two app instances from deadlocking.
      .orderBy(asc(tableSessions.id))
      .for("update");
    if (stale.length === 0) return 0;

    const ids = stale.map((session) => session.id);
    await tx
      .update(tableSessions)
      .set({
        status: "closed",
        closedAt: now,
        closedBy: "timeout",
        closedByUserId: null,
      })
      .where(inArray(tableSessions.id, ids));
    await tx.delete(carts).where(inArray(carts.tableSessionId, ids));
    return ids.length;
  });
};
