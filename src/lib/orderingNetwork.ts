import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { eq } from "drizzle-orm";
import type { Request } from "express";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import { env } from "../configs/env.ts";
import { db } from "../db/index.ts";
import { settings } from "../db/schema.ts";
import type { DbReader } from "./cart.ts";
import { isWellFormedToken, sha256 } from "./tokens.ts";

const KEY = "ordering_network";
const networkSchema = z.strictObject({
  enabled: z.boolean(),
  address: z.string().nullable(),
  terminalHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  updatedAt: z.iso.datetime().nullable(),
});
type OrderingNetwork = z.infer<typeof networkSchema>;
const disabled: OrderingNetwork = {
  enabled: false,
  address: null,
  terminalHash: null,
  updatedAt: null,
};

export function orderingAddress(value: string | undefined) {
  if (!value || value.includes("%") || isIP(value) === 0) return null;
  const address = ipaddr.process(value);
  const range = address.range();
  if (
    range === "unicast" ||
    (env.NODE_ENV !== "production" &&
      ["private", "uniqueLocal", "loopback"].includes(range))
  )
    return address.toString();
  return null;
}

export function requestOrderingAddress(req: Request) {
  const peer = req.socket.remoteAddress;
  const mode = env.ORDERING_NETWORK_IP_SOURCE;
  if (!mode && env.NODE_ENV !== "production") return orderingAddress(peer);
  if (mode === "direct") {
    if (req.get("x-forwarded-for") || req.get("forwarded")) return null;
    return orderingAddress(peer);
  }
  if (
    mode !== "trusted-proxy" ||
    !env.TRUST_PROXY_CIDRS ||
    !peer ||
    !req.ip ||
    !req.ips.length
  )
    return null;
  // The Express chain is resolved against explicit CIDRs, not the number of
  // hops. Do not accept the edge's own address or any other trusted proxy.
  const trust = req.app.get("trust proxy fn") as (
    ip: string,
    hop: number,
  ) => boolean;
  if (!trust(peer, 0) || trust(req.ip, req.ips.length)) return null;
  return orderingAddress(req.ip);
}

function parseNetwork(value?: string) {
  return value === undefined
    ? disabled
    : networkSchema.parse(JSON.parse(value));
}

export async function readOrderingNetwork(executor: DbReader = db) {
  const [row] = await executor
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, KEY))
    .limit(1);
  return parseNetwork(row?.value);
}

const REALTIME_NETWORK_TTL_MS = 1_000;
let realtimePolicy: { until: number; value: OrderingNetwork } | undefined;
let realtimeRead: Promise<OrderingNetwork> | undefined;

export function invalidateRealtimeOrderingNetwork() {
  realtimePolicy = undefined;
  realtimeRead = undefined;
}

export async function readRealtimeOrderingNetwork(): Promise<OrderingNetwork> {
  if (realtimePolicy && realtimePolicy.until > Date.now())
    return realtimePolicy.value;
  if (realtimeRead) return realtimeRead;
  const startedAt = Date.now();
  const pending = readOrderingNetwork()
    .then((value) => {
      if (realtimeRead !== pending) return readRealtimeOrderingNetwork();
      // Bound staleness from the start of the read, not from a slow response.
      realtimePolicy = { value, until: startedAt + REALTIME_NETWORK_TTL_MS };
      return value;
    })
    .finally(() => {
      if (realtimeRead === pending) realtimeRead = undefined;
    });
  realtimeRead = pending;
  return pending;
}

export function terminalMatches(network: OrderingNetwork, token: unknown) {
  if (!network.terminalHash || !isWellFormedToken(token)) return false;
  return timingSafeEqual(
    Buffer.from(network.terminalHash, "hex"),
    Buffer.from(sha256(token), "hex"),
  );
}

export async function updateOrderingNetwork(
  change: (current: OrderingNetwork) => OrderingNetwork | null,
  initialize = true,
) {
  const result = await db.transaction(async (tx) => {
    if (initialize) {
      await tx
        .insert(settings)
        .values({ key: KEY, value: JSON.stringify(disabled) })
        .onConflictDoNothing({ target: settings.key });
    }
    const [row] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, KEY))
      .limit(1)
      .for("update");
    const current = parseNetwork(row?.value);
    const next = change(current);
    if (!row || !next) return { current, changed: false };
    const updated = { ...next, updatedAt: new Date().toISOString() };
    await tx
      .update(settings)
      .set({ value: JSON.stringify(updated), updatedAt: new Date() })
      .where(eq(settings.key, KEY));
    return { current: updated, changed: true };
  });
  if (result.changed) invalidateRealtimeOrderingNetwork();
  return result;
}

export async function orderingNetworkFailure(
  address: string | null,
  read = readOrderingNetwork,
) {
  const network = await read();
  if (!network.enabled || (network.address && network.address === address))
    return null;
  return {
    status: 403,
    code: "ORDERING_NETWORK_REQUIRED",
    message:
      "Connect to the café’s guest Wi-Fi to order. You can still browse the menu.",
  };
}
