import { rateLimit } from "express-rate-limit";
import { createStore } from "../rateLimitStore.ts";
import type { RealtimeAccess } from "./access.ts";

// A cafe's phones often share one NAT. The normal 600/15min baseline is too
// small for fallback polling. These routes use a generous IP baseline plus a
// tighter authenticated table/user quota, shared through Redis when configured.
const ipStore = createStore("realtime-ip");
export const realtimeIpLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 12_000,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  ...(ipStore ? { store: ipStore } : {}),
});
const principalStore = createStore("realtime-principal");
export const realtimePrincipalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 240,
  keyGenerator: (_req, res) => (res.locals.realtime as RealtimeAccess).key,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  ...(principalStore ? { store: principalStore } : {}),
});
