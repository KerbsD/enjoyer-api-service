import type { Response } from "express";
import { RealtimeHub } from "./hub.ts";
import { changedResources, readRevisions } from "./revisions.ts";
import type { RevisionState } from "./revisions.ts";
import type { RealtimeAccess } from "./access.ts";
import { logger, serializeError } from "../logger.ts";

export const POLL_INTERVAL_MS = 5_000;
export const HEARTBEAT_MS = 15_000;
const MAX_STREAMS = 500;
const MAX_PER_PRINCIPAL = 20;
const MAX_LIFETIME_MS = 30 * 60_000;
const hub = new RealtimeHub(readRevisions);
const connections = new Set<() => void>();
const counts = new Map<string, number>();

export const eventFrame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// Exported dependency is used by HTTP tests to exercise real streaming with a
// deterministic source. Production uses the shared hub above.
export const openRealtimeStream = (
  res: Response,
  access: RealtimeAccess,
  source = hub,
): void => {
  if (connections.size >= MAX_STREAMS || (counts.get(access.key) ?? 0) >= MAX_PER_PRINCIPAL) {
    res.set("Retry-After", "15").status(429).json({
      success: false, code: "STREAM_LIMIT", message: "Too many active streams. Use polling or close another tab.",
    });
    return;
  }
  let closed = false;
  let checking = false;
  let previous: RevisionState | undefined;
  let unsubscribe = () => {};
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(lifetime);
    clearInterval(heartbeat);
    unsubscribe();
    connections.delete(shutdown);
    const count = (counts.get(access.key) ?? 1) - 1;
    if (count === 0) counts.delete(access.key);
    else counts.set(access.key, count);
  };
  const write = (frame: string): boolean => {
    if (closed || res.destroyed || res.writableEnded) return false;
    // Slow receivers must reconnect/refetch rather than accumulate an
    // unbounded response buffer. Revision frames are small and replaceable.
    if (!res.write(frame)) {
      cleanup();
      res.destroy();
      return false;
    }
    return true;
  };
  const finish = (event: string, data: unknown) => {
    write(eventFrame(event, data));
    cleanup();
    res.end();
  };
  const shutdown = () => finish("reconnect", { reason: "shutdown", retryMs: POLL_INTERVAL_MS });
  counts.set(access.key, (counts.get(access.key) ?? 0) + 1);
  connections.add(shutdown);
  res.on("close", cleanup);
  res.on("error", cleanup);
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
  });
  res.socket?.setTimeout(0);
  res.flushHeaders();
  if (!write(`retry: ${POLL_INTERVAL_MS}\n\n`)) return;

  heartbeat = setInterval(() => write(": heartbeat\n\n"), HEARTBEAT_MS);
  heartbeat.unref();
  lifetime = setTimeout(() => finish("reconnect", { reason: "rotation", retryMs: POLL_INTERVAL_MS }), MAX_LIFETIME_MS);
  lifetime.unref();

  const onState = async (state: RevisionState | Error) => {
    if (closed || checking) return;
    checking = true;
    try {
      if (state instanceof Error) throw state;
      // Check token expiry/account removal and table closure even when the
      // state is unchanged. A stream is pinned to its original session.
      const failure = await access.check();
      if (closed) return;
      if (failure) return finish("access-ended", failure);
      if (!previous || previous.revision !== state.revision) {
        const changed = previous
          ? changedResources(previous.resources, state.resources)
          : Object.keys(state.resources);
        if (write(eventFrame(previous ? "change" : "sync", {
          ...state, changed, scope: access.scope, pollIntervalMs: POLL_INTERVAL_MS,
        }))) previous = state;
      }
    } catch (error) {
      if (!closed) {
        logger.error({ err: serializeError(error) }, "realtime stream failed");
        finish("unavailable", { code: "REALTIME_UNAVAILABLE", retryMs: POLL_INTERVAL_MS });
      }
    } finally { checking = false; }
  };
  unsubscribe = source.subscribe(access.scope, (state) => { void onState(state); });
  if (closed) unsubscribe();
};

export const closeRealtimeStreams = (): void => {
  for (const close of [...connections]) close();
  hub.close();
};
