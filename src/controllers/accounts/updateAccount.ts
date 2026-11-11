import { eq } from "drizzle-orm";
import type { Request, Response } from "express";

import { db } from "../../db/index.ts";
import { users } from "../../db/schema.ts";
import type { Role } from "../../db/schema.ts";
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
import type { UpdateAccountInput } from "../../validators/accounts.ts";

type Outcome =
  | { notFound: true }
  | { forbidden: true }
  | { rule: string }
  | { updated: Account; previousRole: Role };

const notFound = (res: Response) =>
  res.status(404).json({ success: false, message: "Account not found." });

// req.body is already validated and trimmed by validateUpdateAccount
const handleUpdateAccount = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);

  const { name, role } = req.body as UpdateAccountInput;
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

    // Renaming yourself is fine; changing your own role is not. See
    // actorIsOwner for why this also keeps an Owner in place at all times.
    if (role !== undefined && role !== target.role && target.id === actorId)
      return {
        rule: "You cannot change your own role. Ask another Owner to do it.",
      };

    if (
      (name === undefined || name === target.name) &&
      (role === undefined || role === target.role)
    )
      return { updated: target, previousRole: target.role };

    // Only touch the fields that were actually sent (updatedAt is bumped by
    // the column's $onUpdate)
    const patch: Partial<typeof users.$inferInsert> = {};
    if (name !== undefined) patch.name = name;
    if (role !== undefined) patch.role = role;

    const [updated] = await tx
      .update(users)
      .set(patch)
      .where(eq(users.id, id))
      .returning(accountColumns);

    if (updated && updated.role !== target.role)
      await revokeAccountSessions(tx, id);

    return updated
      ? { updated, previousRole: target.role }
      : { notFound: true };
  });

  if ("notFound" in outcome) return notFound(res);

  if ("forbidden" in outcome)
    return res.status(403).json({
      success: false,
      message: "You do not have permission to do that.",
    });

  if ("rule" in outcome)
    return res.status(409).json({ success: false, message: outcome.rule });

  if (outcome.updated.role !== outcome.previousRole)
    securityLog("account_role_changed", {
      actorId,
      userId: outcome.updated.id,
      from: outcome.previousRole,
      to: outcome.updated.role,
    });

  res.json({ success: true, data: outcome.updated });
};

export { handleUpdateAccount };
