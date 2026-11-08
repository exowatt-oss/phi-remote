/**
 * Overseers (v1 addition) on the phone: each overseer's board (polled while something shows it,
 * shared by the overseer screen, its full board and a thread's siblings sheet), and which
 * overseers' threads are folded on the lists. Both live in memory for the app session.
 */

import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { BoardPoller, EMPTY_BOARD_ENTRY, type BoardEntry } from '@/lib/board-poller';
import { mergeBoard, type BoardThread } from '@/lib/overseer';
import { transcriptKey } from '@/lib/store';

import { remote, useRemote } from './remote';

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

const boardStore = createStore<Record<string, BoardEntry>>()(() => ({}));
const pollers = new Map<string, { poller: BoardPoller; refs: number }>();

function patchEntry(key: string, patch: Partial<BoardEntry>): void {
  boardStore.setState((s) => ({ ...s, [key]: { ...(s[key] ?? EMPTY_BOARD_ENTRY), ...patch } }), true);
}

/** Starts (or joins) the poll of one overseer's board; returns the release. */
function retainBoard(hubId: string, overseerId: string): () => void {
  const key = transcriptKey(hubId, overseerId);
  let slot = pollers.get(key);
  if (!slot) {
    slot = {
      refs: 0,
      poller: new BoardPoller({
        fetch: () => remote.overseerBoard(hubId, overseerId),
        supported: () => remote.hasOverseer(hubId),
        onUpdate: (patch) => patchEntry(key, patch),
      }),
    };
    pollers.set(key, slot);
  }
  slot.refs += 1;
  slot.poller.start();
  const held = slot;
  return () => {
    held.refs -= 1;
    if (held.refs > 0) return;
    held.poller.stop();
    if (pollers.get(key) === held) pollers.delete(key);
  };
}

export type BoardState = {
  /** Every thread, registry order, live summaries laid over (or derived from them). */
  threads: BoardThread[];
  /** The hub's board name for the overseer, when it said. */
  name?: string;
  entry: BoardEntry;
};

/**
 * One overseer's board. While `active` (on screen, app active, computer live) it is polled every
 * ~5 s and refreshed soon after each of the overseer's upserts; otherwise the last board stays,
 * still overlaid with live summaries.
 */
export function useOverseerBoard(hubId: string, overseerId: string | null | undefined, active: boolean): BoardState {
  const key = overseerId ? transcriptKey(hubId, overseerId) : '';
  const entry = useStore(boardStore, (s) => (key ? s[key] : undefined)) ?? EMPTY_BOARD_ENTRY;
  const sessions = useRemote((s) => s.sessions[hubId]);
  const summary = overseerId ? sessions?.[overseerId] : undefined;

  useEffect(() => {
    if (!active || !overseerId) return;
    return retainBoard(hubId, overseerId);
  }, [active, hubId, overseerId]);

  // The hub upserts the overseer when its registry changes (counts move): ask for the board.
  const counts = summary?.threadCounts ? JSON.stringify(summary.threadCounts) : '';
  useEffect(() => {
    if (!active || !key) return;
    pollers.get(key)?.poller.poke();
  }, [active, key, counts]);

  const threads = useMemo(() => (overseerId ? mergeBoard(entry.board, sessions, overseerId) : []), [entry.board, sessions, overseerId]);
  return { threads, name: entry.board?.name, entry };
}

// ---------------------------------------------------------------------------
// Folded overseers (home, All sessions)
// ---------------------------------------------------------------------------

const foldStore = createStore<Record<string, boolean>>()(() => ({}));

/** Whether an overseer's threads are folded on the lists. `fallback`: until the user toggles it. */
export function useThreadsFolded(key: string, fallback: boolean): boolean {
  return useStore(foldStore, (s) => s[key]) ?? fallback;
}

/** All fold choices (the lists read them while building rows). */
export function useFolds(): Record<string, boolean> {
  return useStore(foldStore, (s) => s);
}

export function toggleThreadsFolded(key: string, fallback: boolean): void {
  foldStore.setState((s) => ({ ...s, [key]: !(s[key] ?? fallback) }), true);
}
