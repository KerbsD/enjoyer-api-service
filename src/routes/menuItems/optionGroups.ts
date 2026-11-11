import express from "express";
import { requirePermission } from "../../middlewares/requirePermission.ts";
import { createOptionGroup, listOptionGroups, updateOptionGroup, createOption, updateOption } from "../../controllers/menuItems/options.ts";
import { validateCreateOptionGroup, validateUpdateOptionGroup, validateCreateOption, validateUpdateOption } from "../../validators/menuOptions.ts";

const router = express.Router();
router.use(requirePermission("menu:manage"));
router.get("/", listOptionGroups);
router.post("/", validateCreateOptionGroup, createOptionGroup);
router.patch("/:id", validateUpdateOptionGroup, updateOptionGroup);
router.post("/:id/options", validateCreateOption, createOption);
router.patch("/:id/options/:optionId", validateUpdateOption, updateOption);
export default router;
