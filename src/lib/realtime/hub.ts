import type { RealtimeScope, RevisionState } from "./revisions.ts";

type Listener = (state: RevisionState | Error) => void;
type Group = {
  scope: RealtimeScope;
  listeners: Set<Listener>;
  timer?: ReturnType<typeof setTimeout>;
};

// One in-flight read and timer per watched scope per process, regardless of
// phone/tab count. No polling when no one is watching. setTimeout after the
// read prevents overlapping DB work during a slow query or outage.
export class RealtimeHub {
  private groups = new Map<string, Group>();
  private read: (scope: RealtimeScope) => Promise<RevisionState>;
  private intervalMs: number;

  constructor(
    read: (scope: RealtimeScope) => Promise<RevisionState>,
    intervalMs = 2_000,
  ) {
    this.read = read;
    this.intervalMs = intervalMs;
  }

  subscribe(scope: RealtimeScope, listener: Listener): () => void {
    const key =
      scope.kind === "staff"
        ? "staff"
        : `table:${scope.tableId}:${scope.sessionId}`;
    let group = this.groups.get(key);
    if (!group) {
      group = { scope, listeners: new Set() };
      this.groups.set(key, group);
    }
    group.listeners.add(listener);
    if (group.listeners.size === 1) void this.tick(key, group);
    return () => {
      group.listeners.delete(listener);
      if (group.listeners.size === 0) {
        clearTimeout(group.timer);
        if (this.groups.get(key) === group) this.groups.delete(key);
      }
    };
  }

  private async tick(key: string, group: Group): Promise<void> {
    let result: RevisionState | Error;
    try {
      result = await this.read(group.scope);
    } catch (error) {
      result =
        error instanceof Error ? error : new Error("Realtime read failed");
    }
    if (this.groups.get(key) !== group) return;
    for (const listener of [...group.listeners]) listener(result);
    if (this.groups.get(key) === group && group.listeners.size > 0) {
      group.timer = setTimeout(
        () => void this.tick(key, group),
        this.intervalMs,
      );
      group.timer.unref();
    }
  }

  close(): void {
    for (const group of this.groups.values()) clearTimeout(group.timer);
    this.groups.clear();
  }
}
