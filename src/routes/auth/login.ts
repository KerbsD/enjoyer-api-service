import express from "express";
import { handleLogin } from "../../controllers/auth/login.ts";
import {
  loginIpLimiter,
  loginLimiter,
  loginUserBackoff,
} from "../../lib/authLimiter.ts";
import { requireTrustedOrigin } from "../../lib/requireTrustOrigin.ts";
import { validateLogin } from "../../validators/auth.ts";

const router = express.Router();

// Origin check first (like /auth/refresh and /auth/logout), then limiters
// BEFORE validation so junk requests are throttled too
router.post(
  "/",
  requireTrustedOrigin,
  loginIpLimiter,
  loginLimiter,
  loginUserBackoff,
  validateLogin,
  handleLogin,
);

export default router;
