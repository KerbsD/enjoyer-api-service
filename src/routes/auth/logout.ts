import express from "express";
import { handleLogout } from "../../controllers/auth/logout.ts";
import { requireTrustedOrigin } from "../../lib/requireTrustOrigin.ts";
import { logoutLimiter } from "../../lib/authLimiter.ts";

const router = express.Router();

router.post("/", requireTrustedOrigin, logoutLimiter, handleLogout);

export default router;