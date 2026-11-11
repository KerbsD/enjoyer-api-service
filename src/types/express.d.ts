import type { AccessTokenUser } from "../lib/tokens.ts";

declare global {
  namespace Express {
    interface Request {
      // Set by verifyJwt. `id` comes from the token's `sub` claim and is the
      // only thing you should use for ownership checks (WHERE user_id = $1).
      // `role` is what requirePermission / can() decide on.
      user?: AccessTokenUser;
    }
  }
}
