import express from "express";
import {
  dashboard,
  exportOrdersCsv,
  historicalOrderDetail,
  orderHistory,
} from "../../controllers/reports.ts";
import { requirePermission } from "../../middlewares/requirePermission.ts";
import {
  validateDashboardQuery,
  validateExportQuery,
  validateHistoryQuery,
} from "../../validators/reports.ts";

export const dashboardRoute = express.Router();
dashboardRoute.use(requirePermission("dashboard:view"));
dashboardRoute.get("/", validateDashboardQuery, dashboard);

export const historyRoute = express.Router();
historyRoute.use(requirePermission("order-history:view"));
historyRoute.get("/", validateHistoryQuery, orderHistory);
historyRoute.get("/:id", historicalOrderDetail);

export const exportRoute = express.Router();
exportRoute.use(requirePermission("export:run"));
exportRoute.get("/orders.csv", validateExportQuery, exportOrdersCsv);
