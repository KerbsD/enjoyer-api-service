import express from "express";
import { requirePermission } from "../../middlewares/requirePermission.ts";
import {
  deleteHolidayOverride,
  listHolidayOverrides,
  upsertHolidayOverride,
} from "../../controllers/storeHours/admin.ts";
import {
  validateListHolidayOverrides,
  validateOpeningHours,
} from "../../validators/storeHours.ts";

const router = express.Router();
router.use(requirePermission("store-hours:manage"));
router.get("/", validateListHolidayOverrides, listHolidayOverrides);
router.put("/:date", validateOpeningHours, upsertHolidayOverride);
router.delete("/:date", deleteHolidayOverride);
export default router;
