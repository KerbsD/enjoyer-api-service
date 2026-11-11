import express from "express";
import { acceptInvite } from "../../controllers/auth/password.ts";
import { validateInvite } from "../../controllers/auth/invite.ts";
import { resetPasswordLimiter } from "../../lib/authLimiter.ts";
import {
  validateInviteToken,
  validateResetPassword,
} from "../../validators/auth.ts";

const router = express.Router();
router.post(
  "/validate",
  resetPasswordLimiter,
  validateInviteToken,
  validateInvite,
);
router.patch(
  "/accept",
  resetPasswordLimiter,
  validateResetPassword,
  acceptInvite,
);
export default router;
