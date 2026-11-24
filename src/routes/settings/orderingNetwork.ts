import express from "express";
import {
  enrollOrderingTerminal,
  getOrderingNetwork,
  revokeOrderingTerminal,
  setOrderingNetwork,
  syncOrderingTerminal,
} from "../../controllers/settings/orderingNetwork.ts";
import { requirePermission } from "../../middlewares/requirePermission.ts";
import {
  validateEnrollTerminal,
  validateOrderingNetwork,
} from "../../validators/orderingNetwork.ts";

const router = express.Router();
router.post(
  "/sync",
  requirePermission("settings:manage"),
  syncOrderingTerminal,
);
router.use(requirePermission("ordering-network:manage"));
router.get("/", getOrderingNetwork);
router.post("/terminal", validateEnrollTerminal, enrollOrderingTerminal);
router.delete("/terminal", revokeOrderingTerminal);
router.patch("/", validateOrderingNetwork, setOrderingNetwork);
export default router;
