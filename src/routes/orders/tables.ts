import express from "express";
import {
  closeTable,
  getTableOrders,
  listTableOverview,
} from "../../controllers/orders/staff.ts";
import { requirePermission } from "../../middlewares/requirePermission.ts";
import { validateCloseTable } from "../../validators/orders.ts";

const router = express.Router();
router.use(requirePermission("table:view"));
router.get("/overview", listTableOverview);
router.get("/:tableId/orders", getTableOrders);
router.post("/:tableId/close", requirePermission("table:close"), validateCloseTable, closeTable);

export default router;
