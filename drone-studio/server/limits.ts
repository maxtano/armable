import { statfs } from 'node:fs/promises';
import { ToolError } from './services';
import type { PutOptions, Row, Store } from './store';
import type { Tracker } from './tracker';

/**
 * Limits that keep one small server healthy when anyone on the internet can use it. Per-address limits on sign-in
 * and sign-up live in app.ts; these are the ones that hold however many addresses someone uses.
 */
export const LIMITS = {
  /** Room for documents, builds and backups, history included. Saving a guest bench gives it more. */
  guestBytes: 20_000_000,
  accountBytes: 200_000_000,
  /** Undo history kept per document, beyond its latest version. At least one step is always kept. */
  historyBytes: 5_000_000,
  /** Assistant activity entries kept per account. */
  activityKept: 1000,
  /** Across everyone, per hour. */
  guestsPerHour: 300,
  signupsPerHour: 300,
  feedbackPerHour: 120,
  /** Below this much free disk, Armable stops saving anything new (and says so) rather than fill the disk. */
  minFreeBytes: 2_000_000_000,
};

export const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '');
export const megabytes = (bytes: number) => `${Math.round(bytes / 1e5) / 10} MB`;

/** A count of events across everyone in a sliding window. */
export class Allowance {
  private times: number[] = [];
  constructor(readonly limit: number, readonly windowMs = 3600_000, private now: () => number = Date.now) {}
  take(): boolean {
    const now = this.now();
    while (this.times.length && this.times[0] <= now - this.windowMs) this.times.shift();
    if (this.times.length >= this.limit) return false;
    this.times.push(now);
    return true;
  }
}

export const busy = (what: string) => new ToolError('busy', `Lots of people are ${what} right now.`, 'Try again in a few minutes.');
export const storageFull = () => new ToolError('storage_full', 'Armable is nearly out of space, so it isn’t saving anything new right now.', 'Everything already saved is safe. Try again later.');

/** Watches free space on the disk that holds the database. */
export class Disk {
  low = false;
  private timer?: NodeJS.Timeout;
  constructor(private readonly path = '/', private readonly minFree = LIMITS.minFreeBytes, private readonly free = async (p: string) => { const s = await statfs(p); return s.bavail * s.bsize; }) {}
  async check() {
    try {
      const free = await this.free(this.path), low = free < this.minFree;
      if (low !== this.low) console[low ? 'error' : 'log'](`[armable] ${low ? 'DISK NEARLY FULL: not saving anything new' : 'disk space back to normal'} (${megabytes(free)} free)`);
      this.low = low;
    } catch { /* Unknown is not low. */ }
    return this.low;
  }
  start(everyMs = 60_000) { void this.check(); this.timer = setInterval(() => void this.check(), everyMs); this.timer.unref(); return this; }
  stop() { clearInterval(this.timer); }
}

/** Collections that grow with use. Everything else (sessions, tokens, proposals, settings) stays small and keeps working. */
const GROWS = new Set(['docs', 'feedback', 'ratings', 'shares']);
/** Written as a side effect: when the disk is low they are skipped, not refused, so the main action still works. */
const SKIPPED = new Set(['activity']);

/** A Store that stops growing when the disk is nearly full: people can still sign in and use their drone. */
export class GuardedStore implements Store {
  constructor(private readonly inner: Store, private readonly isLow: () => boolean) {}
  get<T>(c: string, a: string, i: string) { return this.inner.get<T>(c, a, i); }
  list<T>(c: string, a: string, limit?: number) { return this.inner.list<T>(c, a, limit); }
  lookup<T>(c: string, key: string) { return this.inner.lookup<T>(c, key); }
  delete(c: string, a: string, i: string) { return this.inner.delete(c, a, i); }
  deleteAccount(a: string) { return this.inner.deleteAccount(a); }
  close() { return this.inner.close(); }
  put<T>(c: string, a: string, i: string, data: T, options?: PutOptions) {
    // New accounts are refused too; existing ones can still be updated.
    if (this.isLow() && (GROWS.has(c) || (c === 'accounts' && options?.expectedRev === 0))) return Promise.reject(storageFull());
    return this.inner.put<T>(c, a, i, data, options);
  }
  append<T>(c: string, a: string, data: T): Promise<Row<T>> {
    if (this.isLow() && SKIPPED.has(c)) return Promise.resolve({ collection: c, account: a, id: `unsaved_${Date.now().toString(36)}`, rev: 0, data, updatedAt: Date.now() });
    if (this.isLow() && GROWS.has(c)) return Promise.reject(storageFull());
    return this.inner.append<T>(c, a, data);
  }
}

/** A Tracker that stops recording history when the disk is nearly full. Lookups keep working. */
export function guardTracker(inner: Tracker, isLow: () => boolean): Tracker {
  const skip = <A extends unknown[]>(fn: (...args: A) => Promise<void>) => (...args: A) => isLow() ? Promise.resolve() : fn(...args);
  return {
    aircraft: (...a) => inner.aircraft(...a),
    connection: skip((...a: Parameters<Tracker['connection']>) => inner.connection(...a)),
    telemetry: skip((...a: Parameters<Tracker['telemetry']>) => inner.telemetry(...a)),
    toolCall: skip((...a: Parameters<Tracker['toolCall']>) => inner.toolCall(...a)),
    proposal: skip((...a: Parameters<Tracker['proposal']>) => inner.proposal(...a)),
    settingChange: skip((...a: Parameters<Tracker['settingChange']>) => inner.settingChange(...a)),
    testRun: skip((...a: Parameters<Tracker['testRun']>) => inner.testRun(...a)),
    list: (...a) => inner.list(...a),
    summary: (...a) => inner.summary(...a),
    deleteAccount: (...a) => inner.deleteAccount(...a),
  };
}
