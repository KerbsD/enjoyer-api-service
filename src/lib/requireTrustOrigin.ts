import type { NextFunction, Request, Response } from "express";
import whitelist from "../configs/whiteList.ts";

/**
 * CSRF defence for cookie-authenticated endpoints (/auth/refresh, /auth/logout).
 * Browsers always attach an Origin header to cross-origin and POST requests and
 * JavaScript cannot forge it, so we only accept requests from whitelisted origins.
 *
 * Note: non-browser clients (curl, mobile apps) that send no Origin header are
 * rejected here. Add their header explicitly if you need them.
 */
export const requireTrustedOrigin = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const origin = req.get("origin");

  if (!origin || !whitelist.includes(origin)) return res.sendStatus(403);

  next();
};