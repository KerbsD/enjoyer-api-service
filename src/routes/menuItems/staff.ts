import express from "express";
import { requirePermission } from "../../middlewares/requirePermission.ts";
import { handleAvailability } from "../../controllers/menuItems/admin.ts";
import { validateAvailability } from "../../validators/menuItems.ts";

const router = express.Router();
router.patch(
  "/:id/availability",
  requirePermission("item:toggle-sold-out"),
  validateAvailability,
  handleAvailability,
);
export default router;
