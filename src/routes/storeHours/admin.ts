import express from "express";
import { requirePermission } from "../../middlewares/requirePermission.ts";
import {
  getStoreHours,
  upsertStoreHours,
} from "../../controllers/storeHours/admin.ts";
import { validateOpeningHours } from "../../validators/storeHours.ts";

const router = express.Router();
router.use(requirePermission("store-hours:manage"));
router.get("/", getStoreHours);
router.put("/:dayOfWeek", validateOpeningHours, upsertStoreHours);
export default router;
