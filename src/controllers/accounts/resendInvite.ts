import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Request, Response } from "express";

import { db } from "../../db/index.ts";
import { users } from "../../db/schema.ts";
import { deliverInvite } from "../../lib/accounts.ts";
import { parseId } from "../../lib/helpers.ts";
import { securityLog } from "../../lib/logger.ts";
import {
  EMAIL_COOLDOWN_MS,
  INVITE_TTL_MS,
  newToken,
  sha256,
} from "../../lib/tokens.ts";
import { currentUser } from "../../middlewares/requirePermission.ts";

const notFound = (res: Response) =>
  res.status(404).json({ success: false, message: "Account not found." });

// Issues a fresh link for someone who has not accepted yet. The new hash
// replaces the old one, so the previous link stops working.
const handleResendInvite = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);

  const token = newToken();
  const now = new Date();

  // Eligibility (pending, active, cooldown elapsed) and token rotation happen
  // in ONE atomic statement, so two quick clicks cannot both send.
  const [claimed] = await db
    .update(users)
    .set({
      resetPasswordTokenHash: sha256(token),
      resetPasswordExpiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      resetPasswordSentAt: now,
    })
    .where(
      and(
        eq(users.id, id),
        isNull(users.password),
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
    .returning({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
    });

  if (!claimed) {
    // Nothing was changed: work out which rule stopped it, for the Owner
    const [existing] = await db
      .select({
        active: users.active,
        invitePending: sql<boolean>`${users.password} is null`,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    if (!existing) return notFound(res);
    if (!existing.active)
      return res.status(409).json({
        success: false,
        message:
          "This account is deactivated. Reactivate it before sending an invite.",
      });
    if (!existing.invitePending)
      return res.status(409).json({
        success: false,
        message: "This person has already set a password.",
      });
    return res.status(429).json({
      success: false,
      message:
        "An invite was sent a moment ago. Please wait a couple of minutes before sending another.",
    });
  }

  securityLog("invite_resent", {
    actorId: currentUser(req).id,
    userId: claimed.id,
  });

  if (!(await deliverInvite(claimed, token)))
    return res.status(502).json({
      success: false,
      message:
        "The invite email could not be sent. Please try again in a couple of minutes.",
    });

  res.json({
    success: true,
    message: `A new invite was emailed to ${claimed.email}.`,
  });
};

export { handleResendInvite };
