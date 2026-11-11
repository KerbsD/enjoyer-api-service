import { Redis } from "ioredis";
import { RedisStore } from "rate-limit-redis";
import type { RedisReply } from "rate-limit-redis";
import type { Store } from "express-rate-limit";
import { env } from "../configs/env.ts";
import { logger, serializeError } from "./logger.ts";

// Optional: without REDIS_URL, express-rate-limit falls back to its in-memory
// store (per-process, reset on every deploy, not shared across instances).
export const redis = env.REDIS_URL
  ? new Redis(env.REDIS_URL, {
      // If Redis is down, fail each command FAST so passOnStoreError can let the
      // request through, instead of every login hanging on reconnect attempts.
      commandTimeout: 250,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
    })
  : null;

redis?.on("error", (err) =>
  logger.error({ err: serializeError(err) }, "redis error"),
);

if (!redis && env.NODE_ENV === "production") {
  logger.warn(
    "REDIS_URL is not set: rate limits are per-process and reset on deploy. Set it before running more than one instance.",
  );
}

// Even with commandTimeout: 250, a brownout costs every request up to 250ms
// per Redis call (a failed login makes three). After a few consecutive
// failures, stop paying that cost: fail instantly for a cooldown. The errors
// still land on the same fail-open paths (passOnStoreError / try-catch).
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 15_000;

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

/** Runs one Redis operation through the latency circuit breaker. */
export const withRedisBreaker = async <T>(
  exec: () => Promise<T>,
): Promise<T> => {
  if (Date.now() < circuitOpenUntil) throw new Error("redis circuit is open");

  try {
    const result = await exec();
    consecutiveFailures = 0;
    return result;
  } catch (err) {
    consecutiveFailures += 1;
    if (consecutiveFailures >= BREAKER_THRESHOLD) {
      consecutiveFailures = 0;
      circuitOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      logger.warn(
        { cooldownMs: BREAKER_COOLDOWN_MS },
        "redis unhealthy: failing rate-limit Redis calls instantly during cooldown",
      );
    }
    throw err;
  }
};

/** Each limiter needs its own store with a unique prefix. */
export const createStore = (name: string): Store | undefined => {
  if (!redis) return undefined;

  return new RedisStore({
    prefix: `rl:${name}:`,
    sendCommand: (command: string, ...args: string[]) =>
      withRedisBreaker(
        () => redis.call(command, ...args) as Promise<RedisReply>,
      ),
  });
};

export const closeRedis = async (): Promise<void> => {
  if (!redis) return;
  await redis.quit().catch(() => undefined);
};
