import bcrypt from "bcrypt";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Request, Response } from "express";

import COOKIE_OPTIONS, {
  REFRESH_COOKIE_NAME,
} from "../../configs/cookieOptions.ts";
import { db } from "../../db/index.ts";
import { users } from "../../db/schema.ts";
import { securityLog } from "../../lib/logger.ts";
import { createSession } from "../../lib/sessions.ts";
import { BCRYPT_ROUNDS, signAccessToken } from "../../lib/tokens.ts";

const DUMMY_HASH = await bcrypt.hash(
  randomBytes(16).toString("hex"),
  BCRYPT_ROUNDS,
);

// req.body is already validated and trimmed by validateLogin
const handleLogin = async (req: Request, res: Response) => {
  const { email, pwd } = req.body as { email: string; pwd: string };

  // Case-insensitive, matching the unique index on lower(email)
  const [foundUser] = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      active: users.active,
      password: users.password,
    })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email.toLowerCase()))
    .limit(1);

  // Always run bcrypt.compare to prevent timing attacks. A pending invite has
  // no password yet (NULL), so it compares against the dummy hash and can
  // never match: the person must finish the invite link first.
  const match = await bcrypt.compare(pwd, foundUser?.password ?? DUMMY_HASH);

  if (!foundUser || !match) {
    // Never log the attempted email: people paste passwords into that field
    securityLog(
      "login_failed",
      { userId: foundUser?.id ?? null, ip: req.ip },
      "warn",
    );
    return res.sendStatus(401);
  }

  // Only reachable with the correct password, so this does not let a stranger
  // find out which addresses have (deactivated) accounts.
  if (!foundUser.active) {
    securityLog(
      "login_denied_inactive",
      { userId: foundUser.id, ip: req.ip },
      "warn",
    );
    return res.status(403).json({
      success: false,
      message: "This account has been deactivated. Please contact the owner.",
    });
  }

  // Each login starts its own session family (one per device)
  const session = await createSession(foundUser.id, foundUser.password!, {
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });
  if (!session) return res.status(401).json({ success: false, message: "Account changed. Please log in again." });

  securityLog("login_success", { userId: foundUser.id, ip: req.ip });

  res.cookie(REFRESH_COOKIE_NAME, session.token, {
    ...COOKIE_OPTIONS,
    maxAge: session.maxAge,
  });
  res.json({
    accessToken: signAccessToken(foundUser.id, session.role),
    user: { id: foundUser.id, name: session.name, role: session.role },
  });
};

export { handleLogin };
