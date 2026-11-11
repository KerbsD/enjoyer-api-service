import type { Request, Response } from "express";

import COOKIE_OPTIONS, {
  clearRefreshCookies,
  getRefreshToken,
  REFRESH_COOKIE_NAME,
} from "../../configs/cookieOptions.ts";
import { securityLog } from "../../lib/logger.ts";
import { rotateSession } from "../../lib/sessions.ts";
import { isWellFormedToken, signAccessToken } from "../../lib/tokens.ts";

const handleRefreshToken = async (req: Request, res: Response) => {
  const refreshToken = getRefreshToken(req);

  if (!refreshToken) return res.sendStatus(401);

  // Junk cookies are rejected before any database work
  if (!isWellFormedToken(refreshToken)) {
    clearRefreshCookies(res);
    return res.sendStatus(403);
  }

  const result = await rotateSession(refreshToken, {
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });

  if (!result.ok) {
    if (result.reason === "reuse") {
      securityLog(
        "refresh_token_reuse",
        { userId: result.userId, ip: req.ip, cause: result.cause },
        "warn",
      );
    } else if (result.reason === "inactive") {
      securityLog(
        "refresh_denied_inactive",
        { userId: result.userId, ip: req.ip },
        "warn",
      );
    }
    // Every rejection looks the same to the client: log in again
    clearRefreshCookies(res);
    return res.sendStatus(403);
  }

  res.cookie(REFRESH_COOKIE_NAME, result.token, {
    ...COOKIE_OPTIONS,
    maxAge: result.maxAge,
  });
  res.json({
    // Signed with the role rotateSession just read, not one remembered from login
    accessToken: signAccessToken(result.userId, result.role),
    user: { id: result.userId, name: result.name, role: result.role },
  });
};

export { handleRefreshToken };
