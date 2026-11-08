/**
 * The natural voice's streaming reader (pure; the native calls are injected so it is unit-tested).
 *
 * Synthesize piece 1, schedule it, synthesize piece 2 while piece 1 plays, schedule it right after,
 * and so on, with at most `maxScheduled` pieces handed to the player at once, so the first words
 * start after one short synthesis and stop() has little to throw away. Every synthesis is timed
 * for the perf guard. When the voice cannot go on (too slow, an error), the pieces already
 * scheduled play out and the result says where the system voice should take over.
 */

import type { SpeechPiece } from './spoken';

export type SynthesizedPiece = {
  id: number;
  /** Seconds of speech the model produced. */
  audioSeconds: number;
  synthMs: number;
};

export type ReaderDeps = {
  synthesize(piece: SpeechPiece): Promise<SynthesizedPiece>;
  /** Resolves true once the piece has been heard, false when stop() or an interruption ended it first. */
  play(id: number): Promise<boolean>;
  /** stop() was called (or another reply replaced this one). */
  cancelled(): boolean;
  /** Each synthesis timing; return true to stop using the natural voice (the perf guard said "too slow"). */
  timing?(synthMs: number, audioSeconds: number): boolean;
};

export type ReadOutcome =
  /** Everything was heard. */
  | 'done'
  /** stop() / replaced. */
  | 'stopped'
  /** Playback ended without stop() (a call, Siri, a route change). */
  | 'interrupted'
  /** The perf guard tripped: pieces from `next` on should be read by the system voice. */
  | 'slow'
  /** Synthesis failed: pieces from `next` on should be read by the system voice. */
  | 'error';

export type ReadResult = { outcome: ReadOutcome; next: number; error?: unknown };

/**
 * One playing and two queued: the next synthesis has the rest of the current piece plus the one
 * after it to finish in, so a slower iPhone does not leave gaps; stop() drops them at once.
 */
export const MAX_SCHEDULED = 3;

export async function readPieces(pieces: readonly SpeechPiece[], deps: ReaderDeps, maxScheduled = MAX_SCHEDULED): Promise<ReadResult> {
  const scheduled: Promise<boolean>[] = [];
  const ended = (next: number): ReadResult => ({ outcome: deps.cancelled() ? 'stopped' : 'interrupted', next });

  /** Waits until at most `keep` pieces are still scheduled; false when one was not heard. */
  const settle = async (keep: number): Promise<boolean> => {
    while (scheduled.length > keep) {
      const heard = await scheduled.shift()!;
      if (!heard || deps.cancelled()) return false;
    }
    return true;
  };

  for (let i = 0; i < pieces.length; i++) {
    if (deps.cancelled()) return { outcome: 'stopped', next: i };
    let piece: SynthesizedPiece;
    try {
      piece = await deps.synthesize(pieces[i]);
    } catch (error) {
      if (deps.cancelled()) return { outcome: 'stopped', next: i };
      // Let what is already scheduled finish, then hand over.
      if (!(await settle(0))) return ended(i);
      return { outcome: 'error', next: i, error };
    }
    if (deps.cancelled()) return { outcome: 'stopped', next: i };
    scheduled.push(deps.play(piece.id));
    if (deps.timing?.(piece.synthMs, piece.audioSeconds)) {
      if (!(await settle(0))) return ended(i + 1);
      return { outcome: 'slow', next: i + 1 };
    }
    if (!(await settle(maxScheduled - 1))) return ended(i + 1);
  }
  if (!(await settle(0))) return ended(pieces.length);
  return { outcome: 'done', next: pieces.length };
}

/** What the system voice should still read after the natural voice stopped (empty unless it gave up: slow or error). */
export function handoverText(pieces: readonly SpeechPiece[], result: ReadResult): string {
  if (result.outcome !== 'slow' && result.outcome !== 'error') return '';
  return pieces
    .slice(result.next)
    .map((p) => p.text)
    .join(' ');
}
