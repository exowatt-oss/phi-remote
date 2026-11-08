/**
 * Where a subagent card lives: the parent thread provides its host + session so the cards in
 * its feed can read their child sessions from the store without threading props through the
 * transcript rows.
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { childrenOf } from '@/lib/subagents';
import type { SessionSummary } from '@/lib/protocol';
import { useRemote } from '@/services/remote';

export type SubagentScopeValue = {
  hubId: string;
  parentSessionId: string;
  /** The thread is on screen and the app is active (timers tick, shimmers run). */
  active: boolean;
  /** The pinned tray above the composer shows the running subagents (it carries the motion). */
  pinned?: boolean;
};

export const SubagentScope = createContext<SubagentScopeValue | null>(null);

export function useSubagentScope(): SubagentScopeValue | null {
  return useContext(SubagentScope);
}

const NONE: SessionSummary[] = [];

/** A parent's subagent sessions on a host, oldest first (empty on hubs without the feature). */
export function useSubagentChildren(hubId: string | undefined, parentSessionId: string | undefined): SessionSummary[] {
  const forHost = useRemote((s) => (hubId ? s.sessions[hubId] : undefined));
  return useMemo(() => (forHost && parentSessionId ? childrenOf(forHost, parentSessionId) : NONE), [forHost, parentSessionId]);
}

/** Wall-clock time refreshed every `ms` while `on` (for elapsed timers). */
export function useTicker(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}
