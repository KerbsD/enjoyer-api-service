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
import { parseId } from "../../lib/helpers.ts";
import { securityLog } from "../../lib/logger.ts";
import { currentUser } from "../../middlewares/requirePermission.ts";

// Safe to repeat: reactivating an active account changes nothing
const handleReactivateAccount = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id)
    return res
      .status(404)
      .json({ success: false, message: "Account not found." });

  const actorId = currentUser(req).id;
  const outcome = await db.transaction(async (tx) => {
    await lockOwnerChanges(tx);
    if (!(await actorIsOwner(tx, actorId))) return { forbidden: true } as const;
    const [target] = await tx
      .select(accountColumns)
      .from(users)
      .where(eq(users.id, id))
      .for("update");
    if (!target) return { notFound: true } as const;
    if (target.active) return { account: target, changed: false } as const;
    const [account] = await tx
      .update(users)
      .set({ active: true })
      .where(eq(users.id, id))
      .returning(accountColumns);
    // Reactivation must not restore refresh sessions from before deactivation.
    await revokeAccountSessions(tx, id);
    if (!account) throw new Error("account reactivation returned no row");
    return { account, changed: true } as const;
  });

  if (outcome.forbidden)
    return res.status(403).json({
      success: false,
      message: "You do not have permission to do that.",
    });

  if (outcome.notFound)
    return res
      .status(404)
      .json({ success: false, message: "Account not found." });

  const { account } = outcome;
  if (outcome.changed)
    securityLog("account_reactivated", {
      actorId,
      userId: account.id,
    });

  res.json({
    success: true,
    // Deactivating cleared any invite link, so someone who never accepted needs
    // a new one
    message: account.invitePending
      ? "Account reactivated. They have not set a password yet: send a new invite."
      : "Account reactivated.",
    data: account,
  });
};

export { handleReactivateAccount };
