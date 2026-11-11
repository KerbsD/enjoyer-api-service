import { and, eq, isNull, sql } from "drizzle-orm";
import type { db } from "../db/index.ts";

import { sessions, users } from "../db/schema.ts";
import type { Role } from "../db/schema.ts";
import { logger, serializeError } from "./logger.ts";
import { sendInviteEmail } from "../services/email.ts";

// What the API ever returns about an account. The password hash and token
// hashes are never selected, so they cannot leak through a spread or a typo:
// "is the invite still pending" is computed by the database instead.
export const accountColumns = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
  active: users.active,
  // No password yet = the person has not accepted their invite
  invitePending: sql<boolean>`${users.password} is null`,
  // Only meaningful while pending (the same column also serves password resets)
  inviteExpiresAt: sql<Date | null>`case when ${users.password} is null then ${users.resetPasswordExpiresAt} end`,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

export type Account = Pick<typeof users.$inferSelect,
  "id" | "name" | "email" | "role" | "active" | "createdAt" | "updatedAt"
> & { invitePending: boolean; inviteExpiresAt: Date | null };

type AccountTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// All role/active changes take this transaction-scoped lock before any user
// row locks. Rechecking the actor afterwards prevents two Owners from removing
// each other's access concurrently. Keep this key shared across all handlers.
export const lockOwnerChanges = async (tx: AccountTransaction): Promise<void> => {
  await tx.execute(sql`select pg_advisory_xact_lock(153092, 1)`);
};

export const actorIsOwner = async (tx: AccountTransaction, actorId: number): Promise<boolean> => {
  const [actor] = await tx.select({ role: users.role, active: users.active })
    .from(users).where(eq(users.id, actorId)).for("update");
  // With self-demotion/deactivation forbidden, this actor remains an active
  // Owner after the change, preserving at least one Owner without a count race.
  return actor?.active === true && actor.role === "owner";
};

export const revokeAccountSessions = async (tx: AccountTransaction, userId: number): Promise<void> => {
  await tx.update(sessions).set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
};

/**
 * Sends the invite and reports whether it went out. Never throws: the account
 * (or the rotated link) is already saved, so a mail outage must not turn into
 * a failed request. The caller tells the Owner and they can resend.
 */
export const deliverInvite = async (
  invitee: { id: number; name: string; email: string; role: Role },
  token: string,
): Promise<boolean> => {
  try {
    await sendInviteEmail(invitee, token);
    return true;
  } catch (err) {
    logger.error(
      {
        event: "invite_email_failed",
        userId: invitee.id,
        err: serializeError(err),
      },
      "invite email failed",
    );
    return false;
  }
};
