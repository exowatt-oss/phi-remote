/**
 * The pinned subagent tray of one parent thread: its rows, life cycle and collapsed state, wired
 * to the per-thread store. The pure rules are in src/lib/subagent-tray.ts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { TranscriptItem } from '@/lib/protocol';
import type { SubagentChild } from '@/lib/subagents';
import { ackTrayFailures, advanceTray, threadSubagentRows, trayView, type TrayView } from '@/lib/subagent-tray';
import { setTrayCollapsed, updateTrayMemory, useTrayEntry } from '@/services/subagent-tray';

const NONE: never[] = [];

export type SubagentTrayState = {
  view: TrayView | null;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** A new prompt went to the thread: failures so far no longer hold the tray up. */
  ackFailures: () => void;
};

export function useSubagentTray({
  threadKey,
  items,
  children,
  working,
  enabled,
  cap,
}: {
  threadKey: string;
  items: readonly TranscriptItem[];
  children: readonly SubagentChild[];
  working: boolean;
  /** Only a live parent thread has a tray (an offline host's statuses are stale). */
  enabled: boolean;
  cap: number;
}): SubagentTrayState {
  const rows = useMemo(() => (enabled ? threadSubagentRows(items, children, working) : NONE), [enabled, items, children, working]);
  const { collapsed, memory } = useTrayEntry(threadKey);
  // Bumped when the finish moment ends, to let the tray go.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (enabled) updateTrayMemory(threadKey, (m) => advanceTray(m, rows, Date.now()));
  }, [enabled, rows, memory, threadKey, tick]);
  const view = useMemo(() => (enabled ? trayView(memory, rows, cap) : null), [enabled, memory, rows, cap]);
  const expiresAt = view?.expiresAt ?? null;
  useEffect(() => {
    if (expiresAt === null) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, expiresAt - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [expiresAt]);
  const setCollapsed = useCallback((v: boolean) => setTrayCollapsed(threadKey, v), [threadKey]);
  const ackFailures = useCallback(() => updateTrayMemory(threadKey, (m) => ackTrayFailures(m, rows)), [rows, threadKey]);
  return { view, collapsed, setCollapsed, ackFailures };
}
