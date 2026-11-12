import express from "express";
import {
  cancelCustomerOrder,
  listCustomerOrders,
  placeOrder,
} from "../../controllers/orders/public.ts";
import { requireTableSession } from "../../middlewares/tableSession.ts";
import { validatePlaceOrder } from "../../validators/orders.ts";

const router = express.Router();
router.use(requireTableSession);
router.get("/", listCustomerOrders);
router.post("/", validatePlaceOrder, placeOrder);
router.post("/:id/cancel", cancelCustomerOrder);

export default router;
