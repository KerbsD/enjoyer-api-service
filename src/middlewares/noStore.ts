import type { NextFunction, Request, Response } from "express";

// Auth responses carry tokens: never let browsers or proxies cache them
export const noStore = (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
};
