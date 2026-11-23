import express from "express";
import {
  resolveTable,
  openTable,
  resumeTable,
} from "../../controllers/tables/public.ts";
import {
  validateOpenTable,
  validateResolveTable,
  validateResumeTable,
} from "../../validators/tables.ts";

const router = express.Router();
router.post("/resolve", validateResolveTable, resolveTable);
router.post("/open", validateOpenTable, openTable);
router.post("/resume", validateResumeTable, resumeTable);
export default router;
