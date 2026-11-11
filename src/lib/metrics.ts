// Minimal dependency-free counters for security-relevant events. They are
// in-process (per instance, reset on deploy). The hourly maintenance job writes
// a snapshot to the log, so the numbers are observable until a real metrics
// backend (Prometheus, StatsD, ...) consumes `snapshotCounters()`.
const counters = new Map<string, number>();

export const countEvent = (name: string): void => {
  counters.set(name, (counters.get(name) ?? 0) + 1);
};

export const snapshotCounters = (): Record<string, number> =>
  Object.fromEntries(counters);
