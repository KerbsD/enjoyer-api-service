import express from "express";
import {
  forgotPassword,
  resetPassword,
  changePassword,
} from "../../controllers/auth/password.ts";
import {
  forgotPasswordEmailLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
} from "../../lib/authLimiter.ts";
import {
  validateEmail,
  validateResetPassword,
  validateChangePassword,
} from "../../validators/auth.ts";
import { verifyJwt } from "../../middlewares/verifyJwt.ts";

const router = express.Router();
router.patch(
  "/change",
  resetPasswordLimiter,
  verifyJwt,
  validateChangePassword,
  changePassword,
);

// The per-email limiter must come AFTER validateEmail so it sees the cleaned address
router.post(
  "/forgot",
  forgotPasswordLimiter,
  validateEmail,
  forgotPasswordEmailLimiter,
  forgotPassword,
);

// Also completes an invite (the emailed link carries the same kind of token)
router.patch(
  "/reset",
  resetPasswordLimiter,
  validateResetPassword,
  resetPassword,
);

export default router;
