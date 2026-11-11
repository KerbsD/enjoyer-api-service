import type { ErrorRequestHandler } from "express";
import { logger, serializeError } from "../lib/logger.ts";

const isHttpError = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 400 &&
  value < 600;

const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Headers already sent: let Express close the connection
  if (res.headersSent) return next(err);

  const status = isHttpError(err?.status)
    ? err.status
    : isHttpError(err?.statusCode)
      ? err.statusCode
      : 500;

  // Server errors always get a generic message. Client errors (4xx) may show
  // their message, except body-parser errors, whose text can echo your input.
  let message = "Internal Server Error";
  if (err?.type === "entity.parse.failed") message = "Invalid JSON body";
  else if (err?.type === "entity.too.large") message = "Request body too large";
  else if (status < 500 && typeof err?.message === "string")
    message = err.message;

  const reqId: string | undefined = res.locals.reqId;

  // 4xx are already covered by the request log line. Only 5xx get error detail,
  // and serializeError strips query parameters, values and secrets.
  if (status >= 500) {
    logger.error(
      {
        reqId,
        method: req.method,
        path: (req.originalUrl.split("?")[0] ?? "").slice(0, 200),
        status,
        err: serializeError(err),
      },
      "request failed",
    );
  }

  // requestId lets a user quote it in a bug report so you can find the log line
  res.status(status).json({ success: false, message, requestId: reqId });
};

export default errorHandler;
