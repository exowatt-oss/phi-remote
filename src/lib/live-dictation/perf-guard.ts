/**
 * Guard against a silent Core ML CPU fallback (REPORT §3c: ~0.9 s median per update on the CPU vs
 * ~30 ms on the Neural Engine, and a 3 GB footprint). If the median live-update time over the
 * first 5 updates of a session is above 500 ms, the session stops live updates and falls back to
 * SpeechAnalyzer, and live dictation stays off on this iPhone until the user turns it on again
 * or the app or iOS version changes.
 *
 * The median of 5 is above the limit exactly when at least 3 of the 5 are, so the verdict comes
 * as soon as 3 updates fall on one side (after 3 updates at best, 5 at worst).
 */

export const PERF_GUARD_LIMIT_MS = 500;
export const PERF_GUARD_WINDOW = 5;

export type PerfVerdict = 'pending' | 'ok' | 'slow';

export class PerfGuard {
  readonly limitMs: number;
  readonly window: number;
  private readonly samples: number[] = [];
  private result: PerfVerdict = 'pending';

  constructor(limitMs = PERF_GUARD_LIMIT_MS, window = PERF_GUARD_WINDOW) {
    this.limitMs = limitMs;
    this.window = window;
  }

  get verdict(): PerfVerdict {
    return this.result;
  }

  /** The first `window` update times seen (ms). */
  get observed(): readonly number[] {
    return this.samples;
  }

  observe(ms: number): PerfVerdict {
    if (this.result !== 'pending' || !Number.isFinite(ms)) return this.result;
    this.samples.push(ms);
    const need = Math.floor(this.window / 2) + 1;
    const above = this.samples.filter((v) => v > this.limitMs).length;
    const within = this.samples.length - above;
    if (above >= need) this.result = 'slow';
    else if (within >= need) this.result = 'ok';
    return this.result;
  }
}

export type VersionStamp = { appVersion: string; appBuild: string; osVersion: string };
export type SlowRecord = VersionStamp & { at: number; medianMs: number };

/** A "too slow" verdict lasts until the app or iOS version changes. */
export function slowStillApplies(rec: SlowRecord | null | undefined, now: VersionStamp): boolean {
  if (!rec) return false;
  return rec.appVersion === now.appVersion && rec.appBuild === now.appBuild && rec.osVersion === now.osVersion;
}

export function median(xs: readonly number[]): number | null {
  return percentile(xs, 50);
}

/** Nearest-rank percentile (p in 0…100); null for an empty list. */
export function percentile(xs: readonly number[], p: number): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (p === 50 && v.length % 2 === 0) return (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  const rank = Math.min(v.length, Math.max(1, Math.ceil((p / 100) * v.length)));
  return v[rank - 1];
}
