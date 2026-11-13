import express from "express";
import {
  advanceOrder,
  cancelStaffOrder,
  confirmOrder,
  getStaffOrder,
  listStaffOrders,
  markOrderPaid,
  rejectOrder,
  revertOrder,
} from "../../controllers/orders/staff.ts";
import { requirePermission } from "../../middlewares/requirePermission.ts";
import {
  validateCancelOrder,
  validateListStaffOrders,
  validateMarkOrderPaid,
  validateRejectOrder,
} from "../../validators/orders.ts";

const router = express.Router();
router.use(requirePermission("board:view"));
router.get("/", validateListStaffOrders, listStaffOrders);
router.get("/:id", getStaffOrder);
router.post("/:id/confirm", requirePermission("order:confirm"), confirmOrder);
router.post("/:id/reject", requirePermission("order:confirm"), validateRejectOrder, rejectOrder);
router.post("/:id/advance", requirePermission("order:advance"), advanceOrder);
router.post("/:id/revert", requirePermission("order:revert-status"), revertOrder);
router.post("/:id/cancel", requirePermission("order:cancel"), validateCancelOrder, cancelStaffOrder);
router.post("/:id/paid", requirePermission("order:mark-paid"), validateMarkOrderPaid, markOrderPaid);

export default router;
