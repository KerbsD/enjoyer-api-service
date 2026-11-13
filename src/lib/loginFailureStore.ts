type FailureState = { failures: number; resetAt: number };

// Used only when Redis is absent. Expiry cleanup must not depend on another
// request for the same email, and distinct addresses must not grow memory forever.
export class LoginFailureStore {
  private readonly entries = new Map<string, FailureState>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly windowMs: number;
  private readonly maxEntries: number;

  constructor(windowMs: number, maxEntries = 10_000, sweepMs = 60_000) {
    if (
      windowMs <= 0 ||
      !Number.isInteger(maxEntries) ||
      maxEntries < 1 ||
      sweepMs <= 0
    )
      throw new Error("Invalid login failure store limits");
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.timer = setInterval(() => this.prune(), sweepMs);
    this.timer.unref();
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): number {
    const state = this.entries.get(key);
    if (!state || state.resetAt <= Date.now()) {
      this.entries.delete(key);
      return 0;
    }
    return state.failures;
  }

  bump(key: string): void {
    const failures = this.get(key) + 1;
    // Map order follows the most recent failure, not reads. At capacity, evict
    // the least recently failed address after removing any expired entries.
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      this.prune();
      if (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    this.entries.set(key, { failures, resetAt: Date.now() + this.windowMs });
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, state] of this.entries) {
      if (state.resetAt <= now) this.entries.delete(key);
    }
  }

  close(): void {
    clearInterval(this.timer);
    this.entries.clear();
  }
}
