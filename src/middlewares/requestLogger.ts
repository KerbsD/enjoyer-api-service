import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger.ts";

/**
 * One structured line per request, written to stdout (let your platform ship
 * and rotate it). Logs the path only, never the query string, because query
 * strings can carry tokens. Headers and bodies are never logged.
 */
export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const reqId = randomUUID();
  res.locals.reqId = reqId;
  res.setHeader("X-Request-Id", reqId);

  if (req.path === "/health") return next();

  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const status = res.statusCode;
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;

    logger[level](
      {
        reqId,
        method: req.method,
        // originalUrl is never rewritten by nested routers, unlike req.url
        path: (req.originalUrl.split("?")[0] ?? "").slice(0, 200),
        status,
        ms,
        ip: req.ip,
      },
      "request",
    );
  });

  next();
};
