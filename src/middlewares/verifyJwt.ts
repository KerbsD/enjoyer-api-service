import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../lib/tokens.ts";
import type { AccessTokenUser } from "../lib/tokens.ts";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";

// RFC 7235 auth schemes are case-insensitive ("Bearer", "bearer", ...)
const BEARER_PREFIX = "bearer ";

// Authentication only: proves who the caller is and sets req.user (id + role).
// What they may DO is decided afterwards by requirePermission / can().
export const verifyJwt = async (req: Request, res: Response, next: NextFunction) => {
  // Node lowercases header names, so only "authorization" exists
  const authHeader = req.headers.authorization ?? "";

  if (
    authHeader.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX
  ) {
    res.set("WWW-Authenticate", "Bearer");
    return res.sendStatus(401);
  }

  const token = authHeader.slice(BEARER_PREFIX.length).trim();

  // Validate token format before verifying
  if (token.split(".").length !== 3) {
    res.set("WWW-Authenticate", 'Bearer error="invalid_token"');
    return res.sendStatus(401);
  }

  let user: AccessTokenUser;
  try {
    user = verifyAccessToken(token);
  } catch {
    // Expired, tampered, wrong issuer/audience/type, bad role: all 401, so the
    // client handles every case the same way (call /auth/refresh, else log in
    // again).
    res.set("WWW-Authenticate", 'Bearer error="invalid_token"');
    return res.sendStatus(401);
  }

  // Existing JWTs must not retain Owner privileges after a demotion, or allow
  // a disabled account to keep using protected routes until token expiry.
  const [account] = await db.select({ role: users.role, active: users.active })
    .from(users).where(eq(users.id, user.id)).limit(1);
  if (!account?.active) {
    res.set("WWW-Authenticate", 'Bearer error="invalid_token"');
    return res.sendStatus(401);
  }
  req.user = { id: user.id, role: account.role };
  next();
};
