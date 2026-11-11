import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "../db/index.ts";
import { sessions, users } from "../db/schema.ts";
import type { Role } from "../db/schema.ts";
import { securityLog } from "./logger.ts";
import { countEvent } from "./metrics.ts";
import {
  ABSOLUTE_SESSION_TTL_MS,
  REFRESH_GRACE_MS,
  REFRESH_TTL_MS,
  newToken,
  sha256,
} from "./tokens.ts";

export type FingerprintInput = {
  ip?: string | null;
  userAgent?: string | null;
};

type SessionFingerprint = { ip: string | null; userAgent: string | null };

const cleanValue = (
  value: string | null | undefined,
  maxLength: number,
): string | null =>
  typeof value === "string" && value.trim() !== ""
    ? value.trim().slice(0, maxLength)
    : null;

const toFingerprint = (input: FingerprintInput): SessionFingerprint => ({
  ip: cleanValue(input.ip, 64),
  userAgent: cleanValue(input.userAgent, 512),
});

/** True when both sides have a value for a field and they differ. */
const differs = (stored: string | null, current: string | null): boolean =>
  stored !== null && current !== null && stored !== current;

const fingerprintDiffers = (
  stored: SessionFingerprint,
  current: SessionFingerprint,
): boolean =>
  differs(stored.ip, current.ip) ||
  differs(stored.userAgent, current.userAgent);

const buildSession = (
  userId: number,
  familyId: string,
  absoluteExpiresAt: Date,
  now: Date,
  fingerprint: SessionFingerprint,
) => {
  const token = newToken();
  // A token never outlives the session's absolute deadline
  const expiresAt = new Date(
    Math.min(now.getTime() + REFRESH_TTL_MS, absoluteExpiresAt.getTime()),
  );
  return {
    token,
    maxAge: expiresAt.getTime() - now.getTime(), // for the cookie
    row: {
      userId,
      familyId,
      tokenHash: sha256(token),
      expiresAt,
      absoluteExpiresAt,
      ...fingerprint,
    },
  };
};

/** Start a brand-new session family (called on login). */
export const createSession = async (
  userId: number,
  verifiedPasswordHash: string,
  input: FingerprintInput = {},
) => db.transaction(async tx => {
  // Lock users before sessions, like password/account changes. A login whose
  // bcrypt check raced with a reset or deactivation must not create a session.
  const [user] = await tx.select({ name: users.name, role: users.role,
    active: users.active, password: users.password }).from(users)
    .where(eq(users.id, userId)).for("update");
  if (!user?.active || user.password !== verifiedPasswordHash) return null;
  const now = new Date();
  const s = buildSession(
    userId,
    randomUUID(),
    new Date(now.getTime() + ABSOLUTE_SESSION_TTL_MS),
    now,
    toFingerprint(input),
  );
  await tx.insert(sessions).values(s.row);
  return { token: s.token, maxAge: s.maxAge, name: user.name, role: user.role };
});

export type RotateResult =
  | {
      ok: true;
      token: string;
      maxAge: number;
      userId: number;
      name: string;
      // The user's CURRENT role, re-read on every rotation, so a promotion,
      // demotion or deactivation reaches the next access token.
      role: Role;
    }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "inactive"; userId: number }
  | { ok: false; reason: "reuse"; userId: number; cause: "window" | "grace" };

/**
 * Exchange a refresh token for the next one, atomically.
 *
 * SELECT ... FOR UPDATE locks the session row, so two concurrent requests with
 * the same token are serialised: the first rotates, the second then sees
 * `usedAt` and is handled by the grace window or the reuse rule below.
 */
export const rotateSession = async (
  rawToken: string,
  input: FingerprintInput = {},
): Promise<RotateResult> =>
  db.transaction(async (tx): Promise<RotateResult> => {
    const current = toFingerprint(input);

    const [lookup] = await tx.select({ userId: sessions.userId }).from(sessions)
      .where(eq(sessions.tokenHash, sha256(rawToken))).limit(1);
    if (!lookup) return { ok: false, reason: "invalid" };
    // Serialize with login/logout and account/password changes. Take the user
    // lock FIRST to avoid deadlocks with handlers that revoke all sessions.
    const [user] = await tx.select({ name: users.name, role: users.role, active: users.active })
      .from(users).where(eq(users.id, lookup.userId)).for("update");
    if (!user) return { ok: false, reason: "invalid" };
    const now = new Date();

    const [session] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, sha256(rawToken)))
      .limit(1)
      .for("update");

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.absoluteExpiresAt <= now
    ) {
      return { ok: false, reason: "invalid" };
    }

    const revokeFamily = async (familyId: string): Promise<void> => {
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(
          and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)),
        );
    };

    // Already rotated, and outside the grace window: someone is replaying an old
    // token (theft). Revoke the whole family so the attacker AND the victim's
    // copy both die; the real user simply logs in again.
    if (
      session.usedAt &&
      now.getTime() - session.usedAt.getTime() > REFRESH_GRACE_MS
    ) {
      await revokeFamily(session.familyId);
      countEvent("refresh_token_reuse");
      return {
        ok: false,
        reason: "reuse",
        userId: session.userId,
        cause: "window",
      };
    }

    // Normal rotations from a new device/network (VPN, mobile) are common, so
    // a fingerprint mismatch alone only warns below. But a replay INSIDE the
    // grace window from a different fingerprint is not a multi-tab race —
    // concurrent tabs share ip + user-agent — so it is treated as theft.
    const stored = { ip: session.ip, userAgent: session.userAgent };
    const mismatched = fingerprintDiffers(stored, current);

    if (session.usedAt && mismatched) {
      await revokeFamily(session.familyId);
      countEvent("refresh_token_reuse");
      return {
        ok: false,
        reason: "reuse",
        userId: session.userId,
        cause: "grace",
      };
    }

    // A deactivated account never gets another token.
    if (!user.active) {
      await revokeFamily(session.familyId);
      return { ok: false, reason: "inactive", userId: session.userId };
    }

    // Inside the grace window (two tabs racing, same fingerprint) we skip this
    // and just issue another token in the same family instead of treating it
    // as theft.
    if (!session.usedAt) {
      await tx
        .update(sessions)
        .set({ usedAt: now })
        .where(eq(sessions.id, session.id));
    }

    if (mismatched) {
      securityLog(
        "refresh_fingerprint_mismatch",
        {
          userId: session.userId,
          ip: current.ip,
          previousIp: stored.ip,
          userAgentChanged: differs(stored.userAgent, current.userAgent),
        },
        "warn",
      );
      countEvent("refresh_fingerprint_mismatch");
    }

    const next = buildSession(
      session.userId,
      session.familyId,
      session.absoluteExpiresAt,
      now,
      current,
    );
    await tx.insert(sessions).values(next.row);

    return {
      ok: true,
      token: next.token,
      maxAge: next.maxAge,
      userId: session.userId,
      name: user.name,
      role: user.role,
    };
  });

/** Logout: revoke the whole family that this token belongs to. */
export const revokeSessionFamily = async (rawToken: string): Promise<void> => {
  await db.transaction(async tx => {
    const [session] = await tx.select({ userId: sessions.userId, familyId: sessions.familyId })
      .from(sessions).where(eq(sessions.tokenHash, sha256(rawToken))).limit(1);
    if (!session) return;
    await tx.select({ id: users.id }).from(users).where(eq(users.id, session.userId)).for("update");
    await tx.update(sessions).set({ revokedAt: new Date() })
      .where(and(eq(sessions.familyId, session.familyId), isNull(sessions.revokedAt)));
  });
};

/** Housekeeping: expired rows can never be used again, so delete them. */
export const purgeExpiredSessions = async (): Promise<void> => {
  const now = new Date();
  await db
    .delete(sessions)
    .where(
      or(lt(sessions.expiresAt, now), lt(sessions.absoluteExpiresAt, now)),
    );
};
