import express from "express";
import {
  pollChanges, prepareStaffRealtime, prepareTableRealtime, streamChanges,
  validateStaffRealtime, validateTableRealtime,
} from "../controllers/realtime.ts";
import { requirePermission } from "../middlewares/requirePermission.ts";
import { requireTableSession } from "../middlewares/tableSession.ts";
import { verifyJwt } from "../middlewares/verifyJwt.ts";
import { realtimeIpLimiter, realtimePrincipalLimiter } from "../lib/realtime/limiter.ts";

export const tableRealtime = express.Router();
tableRealtime.use(realtimeIpLimiter, requireTableSession, validateTableRealtime, prepareTableRealtime, realtimePrincipalLimiter);
tableRealtime.head("/events", (_req, res) => { res.set("Allow", "GET").sendStatus(405); });
tableRealtime.get("/events", streamChanges);
tableRealtime.get("/changes", pollChanges);

export const staffRealtime = express.Router();
staffRealtime.use(realtimeIpLimiter, verifyJwt, requirePermission("board:view"), requirePermission("table:view"), validateStaffRealtime, prepareStaffRealtime, realtimePrincipalLimiter);
staffRealtime.head("/events", (_req, res) => { res.set("Allow", "GET").sendStatus(405); });
staffRealtime.get("/events", streamChanges);
staffRealtime.get("/changes", pollChanges);
