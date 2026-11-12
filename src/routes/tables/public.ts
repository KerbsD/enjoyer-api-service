import express from "express";
import { resolveTable, openTable } from "../../controllers/tables/public.ts";
import {
  validateOpenTable,
  validateResolveTable,
} from "../../validators/tables.ts";

const router = express.Router();
router.post("/resolve", validateResolveTable, resolveTable);
router.post("/open", validateOpenTable, openTable);
export default router;
