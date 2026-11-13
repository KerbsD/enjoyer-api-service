import express from "express";
import { requirePermission } from "../../middlewares/requirePermission.ts";
import {
  getSettings,
  updateSettings,
} from "../../controllers/settings/admin.ts";
import { validateUpdateSettings } from "../../validators/settings.ts";

const router = express.Router();
router.use(requirePermission("settings:manage"));
router.get("/", getSettings);
router.patch("/", validateUpdateSettings, updateSettings);
export default router;
