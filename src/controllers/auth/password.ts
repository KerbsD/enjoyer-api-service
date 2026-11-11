import bcrypt from "bcrypt";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Request, Response } from "express";

import { db } from "../../db/index.ts";
import { sessions, users } from "../../db/schema.ts";
import { securityLog } from "../../lib/logger.ts";
import { currentUser } from "../../middlewares/requirePermission.ts";
import { clearRefreshCookies } from "../../configs/cookieOptions.ts";
import { isPwnedPassword, pwnedPasswordResponse } from "../../lib/pwned.ts";
import {
  queueEmail,
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
} from "../../services/email.ts";
import {
  BCRYPT_ROUNDS,
  EMAIL_COOLDOWN_MS,
  RESET_TTL_MS,
  isWellFormedToken,
  newToken,
  sha256,
} from "../../lib/tokens.ts";

const forgotPassword = async (req: Request, res: Response) => {
  const { email } = req.body as { email: string };

  // Identical response in EVERY branch (unknown email, deactivated account,
  // cooldown, success)
  const sendSafeResponse = () =>
    res.status(200).json({
      success: true,
      message: "If that email is registered, a reset link has been sent.",
    });

  const token = newToken();
  const now = new Date();

  // Check-the-cooldown and claim-the-slot in ONE statement. Concurrent requests
  // can't all pass: only the first UPDATE matches the WHERE clause.
  //
  // Deactivated accounts never match, so they get no email. An active account
  // whose invite is still pending (no password yet) does match: this doubles
  // as "send me a fresh invite link" when the first one expired.
  const [claimed] = await db
    .update(users)
    .set({
      resetPasswordTokenHash: sha256(token),
      resetPasswordExpiresAt: new Date(now.getTime() + RESET_TTL_MS),
      resetPasswordSentAt: now,
    })
    .where(
      and(
        eq(sql`lower(${users.email})`, email.toLowerCase()),
        eq(users.active, true),
        or(
          isNull(users.resetPasswordSentAt),
          lt(
            users.resetPasswordSentAt,
            new Date(now.getTime() - EMAIL_COOLDOWN_MS),
          ),
        ),
      ),
    )
    .returning({ id: users.id, email: users.email });

  if (claimed) {
    securityLog("password_reset_requested", { userId: claimed.id, ip: req.ip });
    queueEmail("password-reset", () =>
      sendPasswordResetEmail(claimed.email, token),
    );
  }

  return sendSafeResponse();
};

type ResetOutcome =
  | {
      status: "ok";
      userId: number;
      email: string;
      // True when this completed an invite (the account had no password yet)
      wasInvite: boolean;
    }
  | { status: "invalid" | "expired" | "same" };

// The same endpoint serves "forgot password" and "accept invite": both end with
// a one-time token and a new password.
const completePasswordReset =
  (inviteOnly: boolean) => async (req: Request, res: Response) => {
    const { token, newPwd } = req.body as { token: string; newPwd: string };

    if (!isWellFormedToken(token))
      return res
        .status(400)
        .json({ success: false, message: "Invalid reset link." });

    // Checked before the transaction so no row lock is held during a network call
    if (await isPwnedPassword(newPwd))
      return res.status(400).json(pwnedPasswordResponse("newPwd"));

    const tokenHash = sha256(token);

    // One transaction. FOR UPDATE locks the user row, so a second parallel request
    // with the same token waits, then finds the token already cleared.
    const outcome = await db.transaction(async (tx): Promise<ResetOutcome> => {
      const [user] = await tx
        .select({
          id: users.id,
          email: users.email,
          password: users.password,
          active: users.active,
          expiresAt: users.resetPasswordExpiresAt,
        })
        .from(users)
        .where(eq(users.resetPasswordTokenHash, tokenHash))
        .limit(1)
        .for("update");

      if (!user) return { status: "invalid" };

      // A link issued before the account was deactivated must stop working
      if (!user.active) return { status: "invalid" };
      if (inviteOnly && user.password !== null) return { status: "invalid" };

      if (!user.expiresAt || user.expiresAt <= new Date())
        return { status: "expired" };

      // Prevent reusing the same password (doesn't consume the token). A pending
      // invite has no password yet (NULL), so there is nothing to reuse.
      if (
        user.password !== null &&
        (await bcrypt.compare(newPwd, user.password))
      )
        return { status: "same" };

      const hashedPwd = await bcrypt.hash(newPwd, BCRYPT_ROUNDS);

      await tx
        .update(users)
        .set({
          password: hashedPwd,
          resetPasswordTokenHash: null,
          resetPasswordExpiresAt: null,
          resetPasswordSentAt: null,
        })
        .where(eq(users.id, user.id));

      // Kick out every device
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));

      return {
        status: "ok",
        userId: user.id,
        email: user.email,
        wasInvite: user.password === null,
      };
    });

    if (outcome.status === "ok") {
      clearRefreshCookies(res);
      securityLog(
        outcome.wasInvite ? "invite_accepted" : "password_reset_completed",
        { userId: outcome.userId, ip: req.ip },
      );

      // Tell the account owner, so a hijacked reset doesn't go unnoticed. Not for
      // an invite: there was no previous password to have been taken over.
      if (!outcome.wasInvite)
        queueEmail("password-changed", () =>
          sendPasswordChangedEmail(outcome.email),
        );

      return res.status(200).json({
        success: true,
        message: outcome.wasInvite
          ? "Your password has been set. You can now log in."
          : "Password reset successfully. Please log in with your new password.",
      });
    }

    const messages = {
      invalid: "Invalid or already used reset link.",
      expired: "Reset link has expired. Please request a new one.",
      same: "New password must be different from your current password.",
    } as const;

    return res
      .status(400)
      .json({ success: false, message: messages[outcome.status] });
  };

const resetPassword = completePasswordReset(false);
const acceptInvite = completePasswordReset(true);

const changePassword = async (req: Request, res: Response) => {
  const { currentPwd, newPwd } = req.body as {
    currentPwd: string;
    newPwd: string;
  };
  const userId = currentUser(req).id;
  const [user] = await db
    .select({ password: users.password, active: users.active })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.active || !user.password) return res.sendStatus(401);
  if (!(await bcrypt.compare(currentPwd, user.password)))
    return res
      .status(400)
      .json({ success: false, message: "Current password is incorrect." });
  if (await bcrypt.compare(newPwd, user.password))
    return res.status(400).json({
      success: false,
      message: "New password must be different from your current password.",
    });
  if (await isPwnedPassword(newPwd))
    return res.status(400).json(pwnedPasswordResponse("newPwd"));
  const hashedPwd = await bcrypt.hash(newPwd, BCRYPT_ROUNDS);
  const outcome = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        password: users.password,
        active: users.active,
        email: users.email,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!current?.active || current.password !== user.password) return null;
    await tx
      .update(users)
      .set({
        password: hashedPwd,
        resetPasswordTokenHash: null,
        resetPasswordExpiresAt: null,
        resetPasswordSentAt: null,
      })
      .where(eq(users.id, userId));
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    return current;
  });
  if (!outcome)
    return res.status(409).json({
      success: false,
      message: "Account changed. Please log in again.",
    });
  clearRefreshCookies(res);
  securityLog("password_changed", { userId, ip: req.ip });
  queueEmail("password-changed", () => sendPasswordChangedEmail(outcome.email));
  return res.json({
    success: true,
    message: "Password changed. Please log in again.",
  });
};

export { forgotPassword, resetPassword, acceptInvite, changePassword };
