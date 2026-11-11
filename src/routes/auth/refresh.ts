import express from "express";
import { handleRefreshToken } from "../../controllers/auth/refreshToken.ts";
import { requireTrustedOrigin } from "../../lib/requireTrustOrigin.ts";
import { refreshFailLimiter, refreshLimiter } from "../../lib/authLimiter.ts";

const router = express.Router();

// Origin check first, so forged cross-site requests never burn the victim's quota
router.post(
  "/",
  requireTrustedOrigin,
  refreshLimiter,
  refreshFailLimiter,
  handleRefreshToken,
);

export default router;
