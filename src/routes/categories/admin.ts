import express from "express";
import { requirePermission } from "../../middlewares/requirePermission.ts";
import { handleCreateCategory } from "../../controllers/categories/createCategory.ts";
import { handleListCategories } from "../../controllers/categories/listCategories.ts";
import { handleUpdateCategory } from "../../controllers/categories/updateCategory.ts";
import {
  validateCreateCategory,
  validateListCategoriesQuery,
  validateUpdateCategory,
} from "../../validators/categories.ts";

const router = express.Router();
// Mounted after verifyJwt. Both Manager and Owner have menu:manage.
router.use(requirePermission("menu:manage"));
router.get("/", validateListCategoriesQuery, handleListCategories);
router.post("/", validateCreateCategory, handleCreateCategory);
router.patch("/:id", validateUpdateCategory, handleUpdateCategory);
export default router;
