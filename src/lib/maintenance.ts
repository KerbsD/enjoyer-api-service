import { logger, serializeError } from "./logger.ts";
import { snapshotCounters } from "./metrics.ts";
import { purgeExpiredSessions } from "./sessions.ts";
import { closeIdleTableSessions } from "./tableSessions.ts";
import { expireUnconfirmedOrders } from "./orders.ts";

// Housekeeping. There is nothing else to purge: accounts are created by the
// Owner (never self-registered) and are deactivated, never deleted.
export const runMaintenance = async (): Promise<void> => {
  try {
    await purgeExpiredSessions();
  } catch (err) {
    logger.error({ err: serializeError(err) }, "maintenance job failed");
  }

  try {
    const closed = await closeIdleTableSessions();
    if (closed > 0)
      logger.info({ closedSessions: closed }, "closed idle table sessions");
  } catch (err) {
    logger.error(
      { err: serializeError(err) },
      "idle table session cleanup failed",
    );
  }

  try {
    const expired = await expireUnconfirmedOrders();
    if (expired > 0)
      logger.info({ expiredOrders: expired }, "expired unconfirmed orders");
  } catch (err) {
    logger.error(
      { err: serializeError(err) },
      "unconfirmed order expiry failed",
    );
  }

  // Security counters (token reuse, fingerprint mismatches, ...) live in the
  // process; emit them here so the numbers are observable somewhere.
  const counters = snapshotCounters();
  if (Object.keys(counters).length > 0)
    logger.info({ counters }, "security counters");
};
