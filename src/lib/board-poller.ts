/**
 * Keeps one overseer's board fresh (Overseers, v1 addition): `overseer.board` every ~5 s while the
 * board is on screen, and soon after the overseer's own session.upsert (the hub sends one when its
 * registry changes). Hubs without the feature, or that answer `bad_request`, are not asked again:
 * the board is then derived from live summaries (src/lib/overseer.ts mergeBoard). Pure apart from
 * the injected timers, so tests drive it with fake ones.
 */

import type { OverseerBoard } from './overseer';
import { HubError } from './protocol';

/** `hub`: the hub's board. `live`: derived from live summaries (older hub, or no registry yet). */
export type BoardSource = 'pending' | 'hub' | 'live';

export type BoardEntry = {
  board: OverseerBoard | null;
  source: BoardSource;
  /** Last failure (the previous board stays). */
  error: string | null;
  updatedAt: number;
};

export const EMPTY_BOARD_ENTRY: BoardEntry = Object.freeze({ board: null, source: 'pending', error: null, updatedAt: 0 }) as BoardEntry;

export const BOARD_POLL_MS = 5_000;
/** An upsert asks again this soon (several upserts in a burst ask once). */
export const BOARD_POKE_MS = 400;

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export class BoardPoller {
  private timer: unknown = null;
  private running = false;
  private inflight = false;
  /** A poke arrived while a request was in flight: ask once more when it lands. */
  private again = false;
  private unsupported = false;
  private readonly timers: Timers;

  constructor(
    private readonly opts: {
      fetch: () => Promise<OverseerBoard>;
      /** The hub lists the feature (checked on every start). */
      supported: () => boolean;
      onUpdate: (patch: Partial<BoardEntry>) => void;
      intervalMs?: number;
      pokeMs?: number;
      timers?: Timers;
      now?: () => number;
    },
  ) {
    this.timers = opts.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  }

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.unsupported || !this.opts.supported()) {
      this.unsupported = true;
      this.opts.onUpdate({ source: 'live', error: null });
      return;
    }
    void this.tick();
  }

  stop(): void {
    this.running = false;
    this.again = false;
    this.clear();
  }

  /** Something changed (the overseer's upsert): refresh soon instead of at the next tick. */
  poke(): void {
    if (!this.running || this.unsupported) return;
    if (this.inflight) {
      this.again = true;
      return;
    }
    this.schedule(this.opts.pokeMs ?? BOARD_POKE_MS);
  }

  private clear(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.clear();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inflight) return;
    this.inflight = true;
    this.clear();
    const now = this.opts.now ?? Date.now;
    try {
      const board = await this.opts.fetch();
      if (!this.running) return;
      this.opts.onUpdate({ board, source: 'hub', error: null, updatedAt: now() });
    } catch (err) {
      if (!this.running) return;
      if (err instanceof HubError && err.code === 'bad_request') {
        // A hub that does not know the request: derive from live summaries from now on.
        this.unsupported = true;
        this.opts.onUpdate({ board: null, source: 'live', error: null, updatedAt: now() });
        return;
      }
      if (err instanceof HubError && err.code === 'not_found') {
        // No registry file yet (an overseer that has not started a thread): live threads only.
        this.opts.onUpdate({ board: null, source: 'live', error: null, updatedAt: now() });
      } else {
        this.opts.onUpdate({ error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      this.inflight = false;
    }
    if (!this.running || this.unsupported) return;
    if (this.again) {
      this.again = false;
      this.schedule(this.opts.pokeMs ?? BOARD_POKE_MS);
    } else this.schedule(this.opts.intervalMs ?? BOARD_POLL_MS);
  }
}
