import type { Request, RequestHandler } from "express";

import { securityLog } from "../lib/logger.ts";
import { can } from "../lib/permissions.ts";
import type { Permission } from "../lib/permissions.ts";
import type { AccessTokenUser } from "../lib/tokens.ts";

/**
 * Route-level authorization. Mount it AFTER verifyJwt (server.ts applies
 * verifyJwt to everything under the admin routes):
 *
 *   router.patch("/:id/status", requirePermission("order:advance"), handler);
 *
 * 401 means "we don't know who you are" (also what you get if this is ever
 * mounted without verifyJwt, so a wiring mistake fails closed). 403 means
 * "we know who you are, and your role may not do this".
 */
export const requirePermission =
  (permission: Permission): RequestHandler =>
  (req, res, next) => {
    const user = req.user;

    if (!user) {
      res.set("WWW-Authenticate", "Bearer");
      return res.sendStatus(401);
    }

    if (!can(user.role, permission)) {
      // Staff UIs hide actions they can't use, so a 403 is unusual: audit it.
      securityLog(
        "permission_denied",
        { userId: user.id, role: user.role, permission, ip: req.ip },
        "warn",
      );
      return res.status(403).json({
        success: false,
        message: "You do not have permission to do that.",
      });
    }

    next();
  };

/**
 * The authenticated user, for handlers that make their own `can(...)` decision
 * (an action that shares an endpoint with a lower role, such as undoing a
 * status change). Throws on a route that skipped verifyJwt, which surfaces as
 * a 500 instead of silently treating the caller as someone.
 *
 *   if (backwards && !can(currentUser(req).role, "order:revert-status"))
 *     return res.status(403).json({ success: false, message: "..." });
 */
export const currentUser = (req: Request): AccessTokenUser => {
  if (!req.user)
    throw new Error("currentUser() used on a route without verifyJwt");
  return req.user;
};
