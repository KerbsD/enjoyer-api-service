// Browser-compatible, dependency-free helper. Uses fetch so credentials stay
// in headers (native EventSource cannot send Authorization/X-Table-Token).
export type RealtimeState = {
  revision: string;
  resources: Record<string, string>;
  scope:
    | { kind: "staff" }
    | { kind: "table"; tableId: number; sessionId: string };
};
export type AccessEnded = { status: number; code?: string; message?: string };
export type WatchOptions = {
  // e.g. https://api.example.com/tables/realtime?sessionId=<opened-session>
  // or https://api.example.com/staff/realtime
  url: string;
  headers: () => HeadersInit | Promise<HeadersInit>;
  // Refetch the indicated GET resources. Resolve only when the UI has applied
  // them; failed refreshes will be retried. Initial sync includes everything.
  onChange: (state: RealtimeState, changed: string[]) => void | Promise<void>;
  onAccessEnded?: (failure: AccessEnded) => void;
  onTransport?: (transport: "sse" | "polling") => void;
  signal?: AbortSignal;
};

type SseMessage = { event: string; data: string };

// Handles arbitrary UTF-8 and CRLF chunk boundaries, multiline data, comments
// and unknown fields. Incomplete messages are discarded on disconnect.
export async function* sseMessages(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let messageSize = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      buffer += decoder.decode(result.value, { stream: true });
      if (buffer.length > 65_536) throw new Error("SSE frame too large");
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n") };
          event = "message";
          data = [];
          messageSize = 0;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value =
            colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          messageSize += line.length;
          if (messageSize > 65_536) throw new Error("SSE frame too large");
          if (field === "event") event = value;
          if (field === "data") data.push(value);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const terminalStatus = (status: number) =>
  [401, 403, 404, 409].includes(status);
const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

// Stops on expired/revoked credentials or session closure. For AUTH_REQUIRED,
// refresh/login and create a new watcher; for TABLE_SESSION_REQUIRED ask for a
// new scan. Never silently follow a new visit at the same physical table.
export const watchRealtime = (
  options: WatchOptions,
): { stop: () => void; done: Promise<void> } => {
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (options.signal?.aborted) stop();
  else options.signal?.addEventListener("abort", stop, { once: true });
  let previous: RealtimeState | undefined;
  let nextStreamAttempt = 0;
  let retryDelay = 5_000;
  let retryAt = 0;

  const endpoint = (name: string): URL => {
    const url = new URL(options.url);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${name}`;
    url.searchParams.delete("since");
    if (name === "changes" && previous)
      url.searchParams.set("since", previous.revision);
    return url;
  };
  const apply = async (state: RealtimeState, sync = false) => {
    if (controller.signal.aborted) return;
    const changed = Object.keys(state.resources).filter(
      (key) =>
        sync || !previous || previous.resources[key] !== state.resources[key],
    );
    if (changed.length) await options.onChange(state, changed);
    previous = state;
  };
  const ended = (failure: AccessEnded) => {
    stop();
    options.onAccessEnded?.(failure);
  };

  const request = async (stream: boolean): Promise<void> => {
    // Respect server rate-limit backoff across both transports; a rejected
    // SSE handshake must not immediately retry the same quota via polling.
    await wait(Math.max(0, retryAt - Date.now()), controller.signal);
    if (controller.signal.aborted) return;
    const attempt = new AbortController();
    const abort = () => attempt.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) abort();
    let timer = setTimeout(abort, 10_000);
    try {
      const response = await fetch(endpoint(stream ? "events" : "changes"), {
        headers: await options.headers(),
        signal: attempt.signal,
        cache: "no-store",
        credentials: "omit",
      });
      if (terminalStatus(response.status)) {
        const details = await response.json().catch(() => ({}));
        ended({ ...details, status: response.status });
        return;
      }
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const until = Number.isFinite(seconds)
            ? Date.now() + seconds * 1_000
            : Date.parse(retryAfter);
          if (Number.isFinite(until) && until > Date.now()) retryAt = until;
        }
        throw new Error("Realtime unavailable");
      }
      if (!stream) {
        if (response.status !== 204) await apply((await response.json()).data);
        retryDelay = 5_000;
        return;
      }
      if (
        !response.headers
          .get("content-type")
          ?.startsWith("text/event-stream") ||
        !response.body
      )
        throw new Error("Streaming unavailable");
      // Read inactivity includes comments/heartbeats, not just change events.
      // An intermediary that buffers the stream cannot leave the UI stale.
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, output) {
            clearTimeout(timer);
            timer = setTimeout(abort, 35_000);
            output.enqueue(chunk);
          },
        }),
      );
      options.onTransport?.("sse");
      for await (const message of sseMessages(body)) {
        if (controller.signal.aborted) break;
        if (message.event === "sync" || message.event === "change") {
          await apply(JSON.parse(message.data), message.event === "sync");
          retryDelay = 5_000;
        } else if (message.event === "access-ended") {
          ended(JSON.parse(message.data));
          break;
        } else if (["unavailable", "reconnect"].includes(message.event)) break;
      }
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      attempt.abort();
    }
  };

  const done = (async () => {
    try {
      while (!controller.signal.aborted) {
        if (Date.now() >= nextStreamAttempt) {
          try {
            await request(true);
          } catch {
            /* Fall back to polling. */
          }
          if (controller.signal.aborted) break;
          nextStreamAttempt = Date.now() + 30_000;
          options.onTransport?.("polling");
        }
        try {
          await request(false);
        } catch {
          retryDelay = Math.min(60_000, retryDelay * 2);
        }
        await wait(retryDelay, controller.signal);
      }
    } finally {
      options.signal?.removeEventListener("abort", stop);
    }
  })();
  return { stop, done };
};
