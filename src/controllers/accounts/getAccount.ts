import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db/index.ts";
import { users } from "../../db/schema.ts";
import { accountColumns } from "../../lib/accounts.ts";
import { parseId } from "../../lib/helpers.ts";
import { currentUser } from "../../middlewares/requirePermission.ts";

export const handleGetAccount = async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const notFound = () =>
    res.status(404).json({ success: false, message: "Account not found." });
  if (!id) return notFound();
  const [account] = await db
    .select(accountColumns)
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return account ? res.json({ success: true, data: account }) : notFound();
};

export const handleCurrentUser = async (req: Request, res: Response) => {
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      active: users.active,
    })
    .from(users)
    .where(eq(users.id, currentUser(req).id))
    .limit(1);
  if (!user?.active) return res.sendStatus(401);
  return res.json({ success: true, data: user });
};
