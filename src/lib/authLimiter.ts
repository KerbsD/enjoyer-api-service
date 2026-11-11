import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import type { Options } from "express-rate-limit";
import type { NextFunction, Request, Response } from "express";
import { setTimeout as sleep } from "node:timers/promises";
import { getRefreshToken } from "../configs/cookieOptions.ts";
import { createStore, redis, withRedisBreaker } from "./rateLimitStore.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const createLimiter = (
  name: string,
  limit: number,
  message: string,
  extra: Partial<Options> = {},
) => {
  const store = createStore(name);

  return rateLimit({
    windowMs: 15 * MINUTE,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message },
    // If Redis hiccups, let the request through instead of taking auth down
    passOnStoreError: true,
    ...(store ? { store } : {}),
    ...extra,
  });
};

// ---------- Key helpers ----------

// ipKeyGenerator groups IPv6 addresses by /64, so one user can't dodge a limit
// by rotating through addresses in their own range.
const clientKey = (req: Request): string => ipKeyGenerator(req.ip ?? "");

const bodyString = (req: Request, field: string): string => {
  const value = req.body?.[field];
  return typeof value === "string"
    ? value.trim().toLowerCase().slice(0, 254)
    : "";
};

// "Ana", "ana " and "ANA" share one counter
const loginKey = (req: Request): string =>
  `${clientKey(req)}|${bodyString(req, "email")}`;

const emailKey = (req: Request): string =>
  bodyString(req, "email") || `ip:${clientKey(req)}`;

// Per-email limits answer with the SAME 200 body as a normal request, so an
// attacker can't tell from the response whether the address exists or was capped.
const silentOk =
  (message: string, status = 200) =>
  (_req: Request, res: Response) => {
    res.status(status).json({ success: true, message });
  };

// ---------- Global baseline ----------

export const globalLimiter = createLimiter(
  "global",
  600,
  "Too many requests. Please slow down.",
);

// ---------- Login ----------

// Per IP + username. Only failed attempts count (responses with status >= 400)
export const loginLimiter = createLimiter(
  "login",
  5,
  "Too many login attempts. Please try again after 15 minutes.",
  { skipSuccessfulRequests: true, keyGenerator: loginKey },
);

// Per IP, across all usernames
export const loginIpLimiter = createLimiter(
  "loginIp",
  20,
  "Too many login attempts. Please try again after 15 minutes.",
  { skipSuccessfulRequests: true },
);

// Per username across ALL IPs: a botnet must not be able to hammer one account.
// A hard lock is a denial-of-service gift, though — anyone can lock a known
// account out by failing on purpose. Instead, failures buy a progressive delay
// on further attempts: brute force becomes too slow to be useful while the
// correct password still gets through, just later. Redis-backed when
// configured, per-process otherwise (like the limiters).
const BACKOFF_AFTER = 5; // failures before any delay
const BACKOFF_BASE_MS = 250; // first delay, doubling per failure
const BACKOFF_MAX_MS = 5000; // cap, so legitimate logins still complete
const BACKOFF_WINDOW_MS = 15 * MINUTE; // sliding, resets on successful login

type BackoffState = { failures: number; resetAt: number };
const memoryBackoff = new Map<string, BackoffState>();

const backoffKey = (key: string): string => `backoff:login:${key}`;

const readFailures = async (key: string): Promise<number> => {
  if (redis) {
    const client = redis; // narrowed alias; safe to capture in the closure
    try {
      const raw = await withRedisBreaker(() => client.get(backoffKey(key)));
      return raw ? Math.max(Number.parseInt(raw, 10) || 0, 0) : 0;
    } catch {
      return 0; // fail open, like passOnStoreError on the limiters
    }
  }

  const state = memoryBackoff.get(key);
  if (!state || state.resetAt <= Date.now()) {
    memoryBackoff.delete(key);
    return 0;
  }
  return state.failures;
};

const bumpFailures = async (key: string): Promise<void> => {
  if (redis) {
    const client = redis; // narrowed alias; safe to capture in the closure
    try {
      await withRedisBreaker(() =>
        client
          .multi()
          .incr(backoffKey(key))
          .pexpire(backoffKey(key), BACKOFF_WINDOW_MS)
          .exec(),
      );
    } catch {
      // fail open
    }
    return;
  }

  const now = Date.now();
  const state = memoryBackoff.get(key);
  if (state && state.resetAt > now) {
    state.failures += 1;
    state.resetAt = now + BACKOFF_WINDOW_MS;
  } else {
    memoryBackoff.set(key, { failures: 1, resetAt: now + BACKOFF_WINDOW_MS });
  }
};

const clearFailures = async (key: string): Promise<void> => {
  if (redis) {
    const client = redis; // narrowed alias; safe to capture in the closure
    try {
      await withRedisBreaker(() => client.del(backoffKey(key)));
    } catch {
      // fail open
    }
    return;
  }
  memoryBackoff.delete(key);
};

// Only 401 (bad credentials) counts as a failure; 200 clears the counter.
export const loginUserBackoff = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const key = emailKey(req);
  const failures = await readFailures(key);

  res.on("finish", () => {
    if (res.statusCode === 401) void bumpFailures(key);
    else if (res.statusCode === 200) void clearFailures(key);
  });

  if (failures >= BACKOFF_AFTER) {
    const delay = Math.min(
      BACKOFF_BASE_MS * 2 ** (failures - BACKOFF_AFTER),
      BACKOFF_MAX_MS,
    );
    await sleep(delay);
  }

  next();
};

export const forgotPasswordLimiter = createLimiter(
  "forgot",
  5,
  "Too many reset requests. Please try again later.",
  { windowMs: HOUR },
);

// Daily cap per target address (the 2-minute cooldown alone still lets a third
// party mail a victim every 2 minutes forever). Mount AFTER validateEmail.
export const forgotPasswordEmailLimiter = createLimiter(
  "forgotEmail",
  5,
  "If that email is registered, a reset link has been sent.",
  {
    windowMs: 24 * HOUR,
    keyGenerator: emailKey,
    standardHeaders: false,
    handler: silentOk(
      "If that email is registered, a reset link has been sent.",
    ),
  },
);

export const resetPasswordLimiter = createLimiter(
  "reset",
  10,
  "Too many attempts. Please try again later.",
);

// ---------- Refresh & logout ----------

// Generous ceiling on all refresh calls. Access tokens live 1 minute in
// production, so a legitimate client refreshes often (and per tab).
export const refreshLimiter = createLimiter(
  "refresh",
  300,
  "Too many refresh requests. Please try again later.",
);

// Strict limit on *failed* refreshes that carried a cookie: the junk-cookie
// spam pattern. Requests with no cookie at all are skipped here because they
// cost nothing and a logged-out SPA hits them on every page load.
export const refreshFailLimiter = createLimiter(
  "refreshFail",
  20,
  "Too many failed refresh attempts. Please try again later.",
  {
    skipSuccessfulRequests: true,
    skip: (req: Request) => !getRefreshToken(req),
  },
);

// Logout always answers 204, so count every request
export const logoutLimiter = createLimiter(
  "logout",
  30,
  "Too many logout requests. Please try again later.",
);
