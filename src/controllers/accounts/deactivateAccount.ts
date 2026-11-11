import { eq } from "drizzle-orm";
import type { Request, Response } from "express";

import { db } from "../../db/index.ts";
import { users } from "../../db/schema.ts";
import {
  accountColumns,
  actorIsOwner,
  lockOwnerChanges,
  revokeAccountSessions,
} from "../../lib/accounts.ts";
import type { Account } from "../../lib/accounts.ts";
import { parseId } from "../../lib/helpers.ts";
import { securityLog } from "../../lib/logger.ts";
import { currentUser } from "../../middlewares/requirePermission.ts";

type Outcome =
  | { notFound: true }
  | { forbidden: true }
  | { rule: string }
  | { account: Account; changed: boolean };

const notFound = (res: Response) =>
  res.status(404).json({ success: false, message: "Account not found." });

// Accounts are deactivated, never deleted, so past activity keeps pointing at
// the person who did it. Safe to repeat: deactivating twice changes nothing.
const handleDeactivateAccount = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);

  const actorId = currentUser(req).id;

  const outcome = await db.transaction(async (tx): Promise<Outcome> => {
    await lockOwnerChanges(tx);
    if (!(await actorIsOwner(tx, actorId))) return { forbidden: true };

    const [target] = await tx
      .select(accountColumns)
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
      .for("update");

    if (!target) return { notFound: true };

    // See actorIsOwner for why this also keeps an Owner in place at all times
    if (target.id === actorId)
      return {
        rule: "You cannot deactivate your own account. Ask another Owner to do it.",
      };

    if (!target.active) return { account: target, changed: false };

    // A pending invite or reset link must die with the account
    const [account] = await tx
      .update(users)
      .set({
        active: false,
        resetPasswordTokenHash: null,
        resetPasswordExpiresAt: null,
        resetPasswordSentAt: null,
      })
      .where(eq(users.id, id))
      .returning(accountColumns);

    // verifyJwt also rejects existing access tokens while the account is inactive.
    await revokeAccountSessions(tx, id);

    return account ? { account, changed: true } : { notFound: true };
  });

  if ("notFound" in outcome) return notFound(res);

  if ("forbidden" in outcome)
    return res.status(403).json({
      success: false,
      message: "You do not have permission to do that.",
    });

  if ("rule" in outcome)
    return res.status(409).json({ success: false, message: outcome.rule });

  if (outcome.changed)
    securityLog("account_deactivated", {
      actorId,
      userId: outcome.account.id,
    });

  res.json({
    success: true,
    message: "Account deactivated.",
    data: outcome.account,
  });
};

export { handleDeactivateAccount };
