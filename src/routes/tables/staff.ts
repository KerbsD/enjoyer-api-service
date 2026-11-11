import express from "express";
import { requirePermission } from "../../middlewares/requirePermission.ts";
import { listTables } from "../../controllers/tables/admin.ts";
import { validateListTables } from "../../validators/tables.ts";
const router = express.Router();
router.get("/", requirePermission("table:view"), validateListTables, listTables(false));
export default router;
