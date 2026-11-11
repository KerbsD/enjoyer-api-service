import { createRequire } from "node:module";
import pino from "pino";
import { env } from "../configs/env.ts";

// pino-pretty is a dev-only nicety. If it isn't installed, fall back to plain JSON
// instead of crashing at startup.
const hasPrettyPrinter = (): boolean => {
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
};

const firstLine = (value: unknown): string =>
  typeof value === "string" ? (value.split("\n")[0] ?? "").slice(0, 300) : "";

type SafeError = {
  type: string;
  message: string;
  code?: string;
  constraint?: string;
  table?: string;
  stack?: string;
  cause?: SafeError;
};

/**
 * Drizzle puts the bound parameters (password hashes, tokens, emails) in the
 * error MESSAGE ("Failed query: ...\nparams: ..."), and pg's `detail` can
 * contain row values. So we keep only the first line of the message (the SQL
 * with $1, $2 placeholders), strip the same text out of the stack, and drop
 * `params`, `query` and `detail` entirely.
 */
export const serializeError = (err: unknown, depth = 0): SafeError => {
  if (!(err instanceof Error)) {
    return { type: typeof err, message: "non-Error value was thrown" };
  }

  const e = err as Error & {
    code?: unknown;
    constraint?: unknown;
    table?: unknown;
    cause?: unknown;
  };

  const message = firstLine(e.message);
  const out: SafeError = { type: e.name, message };

  if (typeof e.code === "string") out.code = e.code;
  if (typeof e.constraint === "string") out.constraint = e.constraint;
  if (typeof e.table === "string") out.table = e.table;
  if (e.stack) out.stack = e.stack.replace(e.message, () => message);
  if (e.cause !== undefined && depth < 3)
    out.cause = serializeError(e.cause, depth + 1);

  return out;
};

export const logger = pino({
  level: env.LOG_LEVEL,
  // Applied exactly once. Without this, pino's default `err` serializer would re-process
  // our already-sanitised object (mislabelling it "Object" and flattening its cause).
  serializers: {
    err: (value: unknown) =>
      value instanceof Error ? serializeError(value) : value,
  },
  // Safety net in case an object containing secrets is ever logged by accident
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
      "password",
      "pwd",
      "newPwd",
      "currentPwd",
      "token",
      "*.password",
      "*.pwd",
      "*.newPwd",
      "*.currentPwd",
      "*.token",
      "*.refreshToken",
      "*.accessToken",
      "*.authorization",
      "*.cookie",
    ],
    censor: "[REDACTED]",
  },
  // Human-readable output locally; plain JSON lines everywhere else
  ...(env.NODE_ENV === "development" && hasPrettyPrinter()
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
        },
      }
    : {}),
});

/**
 * Audit trail for security-relevant events. Never pass secrets, passwords,
 * tokens, or attempted usernames in `fields`.
 */
export const securityLog = (
  event: string,
  fields: Record<string, unknown> = {},
  level: "info" | "warn" = "info",
): void => {
  logger[level]({ security: true, event, ...fields }, `security: ${event}`);
};
