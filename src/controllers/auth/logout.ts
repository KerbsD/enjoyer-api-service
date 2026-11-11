import type { Request, Response } from "express";

import {
  clearRefreshCookies,
  getRefreshToken,
} from "../../configs/cookieOptions.ts";
import { revokeSessionFamily } from "../../lib/sessions.ts";
import { isWellFormedToken } from "../../lib/tokens.ts";

const handleLogout = async (req: Request, res: Response) => {
  const refreshToken = getRefreshToken(req);

  // No cookie present: nothing to revoke, nothing to clear
  if (!refreshToken) return res.sendStatus(204);

  // Revokes only this device's session family. Other devices stay logged in.
  if (isWellFormedToken(refreshToken)) await revokeSessionFamily(refreshToken);

  clearRefreshCookies(res);
  res.sendStatus(204);
};

export { handleLogout };
