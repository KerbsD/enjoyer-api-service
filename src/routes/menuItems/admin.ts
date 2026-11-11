import express from "express";
import {
  listItemOptionGroups,
  assignOptionGroups,
} from "../../controllers/menuItems/options.ts";
import { validateAssignOptionGroups } from "../../validators/menuOptions.ts";
import { requirePermission } from "../../middlewares/requirePermission.ts";
import {
  handleCreateMenuItem,
  handleGetMenuItem,
  handleListMenuItems,
  handleUpdateMenuItem,
} from "../../controllers/menuItems/admin.ts";
import {
  validateCreateMenuItem,
  validateListMenuItemsQuery,
  validateUpdateMenuItem,
} from "../../validators/menuItems.ts";

const router = express.Router();

router.use(requirePermission("menu:manage"));

router.get("/", validateListMenuItemsQuery, handleListMenuItems);
router.get("/:id", handleGetMenuItem);
router.get("/:id/option-groups", listItemOptionGroups);
router.put(
  "/:id/option-groups",
  validateAssignOptionGroups,
  assignOptionGroups,
);
router.post("/", validateCreateMenuItem, handleCreateMenuItem);
router.patch("/:id", validateUpdateMenuItem, handleUpdateMenuItem);
export default router;
