import type { Request, Response } from "express";

import { db } from "../../db/index.ts";
import { users } from "../../db/schema.ts";
import { accountColumns, deliverInvite } from "../../lib/accounts.ts";
import { pgConstraint } from "../../lib/helpers.ts";
import { securityLog } from "../../lib/logger.ts";
import { INVITE_TTL_MS, newToken, sha256 } from "../../lib/tokens.ts";
import { currentUser } from "../../middlewares/requirePermission.ts";
import type { CreateAccountInput } from "../../validators/accounts.ts";

// req.body is already validated and trimmed by validateCreateAccount
const handleCreateAccount = async (req: Request, res: Response) => {
  const { name, email, role } = req.body as CreateAccountInput;

  const token = newToken();
  const now = new Date();

  // The account starts with no password: the invite link is how the person
  // sets one (PATCH /auth/password/reset), and until then they cannot log in.
  let created;
  try {
    [created] = await db
      .insert(users)
      .values({
        name,
        email,
        role,
        password: null,
        active: true,
        resetPasswordTokenHash: sha256(token),
        resetPasswordExpiresAt: new Date(now.getTime() + INVITE_TTL_MS),
        resetPasswordSentAt: now,
      })
      .returning(accountColumns);
  } catch (err) {
    // The case-insensitive unique index on lower(email) decides
    if (pgConstraint(err) === "users_email_lower_idx")
      return res.status(409).json({
        success: false,
        message: "An account with that email already exists.",
      });
    throw err;
  }

  if (!created) throw new Error("account insert returned no row");

  securityLog("account_created", {
    actorId: currentUser(req).id,
    userId: created.id,
    role: created.role,
  });

  // Awaited on purpose: the Owner needs to know whether the person got it
  const inviteEmailSent = await deliverInvite(created, token);

  res.status(201).json({
    success: true,
    message: inviteEmailSent
      ? `Account created. An invite was emailed to ${created.email}.`
      : "Account created, but the invite email could not be sent. Use resend invite to try again.",
    data: created,
    inviteEmailSent,
  });
};

export { handleCreateAccount };
