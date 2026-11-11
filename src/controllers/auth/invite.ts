import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db/index.ts";
import { users } from "../../db/schema.ts";
import { isWellFormedToken, sha256 } from "../../lib/tokens.ts";

// POST keeps the bearer secret out of URLs and access logs. Validation does
// not consume the link; acceptance rechecks it inside a transaction.
export const validateInvite = async (req: Request, res: Response) => {
  const invalid = () =>
    res.status(400).json({
      success: false,
      message: "Invalid, expired, or already used invite link.",
    });
  const { token } = req.body as { token: string };
  if (!isWellFormedToken(token)) return invalid();
  const [user] = await db
    .select({
      password: users.password,
      active: users.active,
      expiresAt: users.resetPasswordExpiresAt,
    })
    .from(users)
    .where(eq(users.resetPasswordTokenHash, sha256(token)))
    .limit(1);
  if (
    !user?.active ||
    user.password !== null ||
    !user.expiresAt ||
    user.expiresAt <= new Date()
  )
    return invalid();
  return res.json({ success: true, data: { expiresAt: user.expiresAt } });
};
