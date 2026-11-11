import { eq } from "drizzle-orm";
import type { RequestHandler } from "express";

import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { securityLog } from "../lib/logger.ts";
import { can } from "../lib/permissions.ts";
import type { Permission } from "../lib/permissions.ts";

/**
 * Like requirePermission, but decides on the user's role AS IT IS NOW, read
 * from the database, instead of the role baked into the access token. Use it
 * for routes where a minute of stale power is too much (account management):
 * a demoted or deactivated Owner is locked out immediately instead of when
 * their token expires.
 *
 * verifyJwt already refreshes account state for all protected requests. This
 * extra lookup is reserved for sensitive account routes and rechecks state at
 * the permission boundary. Mutations still recheck the Owner under a lock.
 * Mount it AFTER verifyJwt; it replaces requirePermission on this router.
 */
export const requireFreshPermission =
  (permission: Permission): RequestHandler =>
  async (req, res, next) => {
    const user = req.user;

    if (!user) {
      res.set("WWW-Authenticate", "Bearer");
      return res.sendStatus(401);
    }

    const [current] = await db
      .select({ role: users.role, active: users.active })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    // Deactivated (or removed): the token is still cryptographically valid,
    // but the person is not. 401 sends the client to /auth/refresh, which
    // refuses them and ends their session.
    if (!current || !current.active) {
      res.set("WWW-Authenticate", 'Bearer error="invalid_token"');
      return res.sendStatus(401);
    }

    if (!can(current.role, permission)) {
      securityLog(
        "permission_denied",
        {
          userId: user.id,
          role: current.role,
          permission,
          ip: req.ip,
          // true when the token claimed more than they have now
          staleToken: current.role !== user.role,
        },
        "warn",
      );
      return res.status(403).json({
        success: false,
        message: "You do not have permission to do that.",
      });
    }

    req.user = { id: user.id, role: current.role };
    next();
  };
