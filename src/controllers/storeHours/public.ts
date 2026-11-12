import type { Request, Response } from "express";
import { getStoreStatus } from "../../lib/storeHours.ts";

export const getPublicStoreStatus = async (_req: Request, res: Response) => {
  const data = await getStoreStatus();
  return res.json({ success: true, data });
};
