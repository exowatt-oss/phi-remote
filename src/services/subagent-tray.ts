/**
 * Per-thread state of the pinned subagent tray, kept in memory for the app session: whether the
 * user collapsed it, and its life-cycle memory (src/lib/subagent-tray.ts), so leaving a thread
 * (into a subagent, or home) and coming back finds the tray as it was. Not persisted.
 */

import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { ackTray, EMPTY_TRAY, type TrayMemory } from '@/lib/subagent-tray';

export type TrayEntry = { collapsed: boolean; memory: TrayMemory };

const EMPTY_ENTRY: TrayEntry = { collapsed: false, memory: EMPTY_TRAY };

const trayStore = createStore<Record<string, TrayEntry>>()(() => ({}));

export function useTrayEntry(threadKey: string): TrayEntry {
  return useStore(trayStore, (s) => s[threadKey] ?? EMPTY_ENTRY);
}

function update(threadKey: string, fn: (entry: TrayEntry) => TrayEntry): void {
  trayStore.setState((s) => {
    const prev = s[threadKey] ?? EMPTY_ENTRY;
    const next = fn(prev);
    return next === prev ? s : { ...s, [threadKey]: next };
  }, true);
}

export function setTrayCollapsed(threadKey: string, collapsed: boolean): void {
  update(threadKey, (e) => (e.collapsed === collapsed ? e : { ...e, collapsed }));
}

/** Applies `fn` to the thread's current tray memory (a no-op when it returns the same object). */
export function updateTrayMemory(threadKey: string, fn: (memory: TrayMemory) => TrayMemory): void {
  update(threadKey, (e) => {
    const memory = fn(e.memory);
    return memory === e.memory ? e : { ...e, memory };
  });
}

/** A failed run's thread was opened: it no longer holds its parent's tray up. */
export function ackTrayRun(parentThreadKey: string, runId: string): void {
  updateTrayMemory(parentThreadKey, (m) => (m.episode.length ? ackTray(m, [runId]) : m));
}
