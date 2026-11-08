/**
 * Where an overseer's transcript cards live: its screen provides the computer, the overseer and
 * its board, so a card naming a thread can open it without threading props through every row.
 */

import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { createContext, useContext } from 'react';

import { sessionHref } from '@/lib/format';
import { threadIdByName, type BoardThread } from '@/lib/overseer';

export type OverseerScopeValue = {
  hubId: string;
  overseerId: string;
  threads: readonly BoardThread[];
};

export const OverseerScope = createContext<OverseerScopeValue | null>(null);

export function useOverseerScope(): OverseerScopeValue | null {
  return useContext(OverseerScope);
}

/** A thread's session id from an id the card knows, else its name on the board. */
export function resolveThread(scope: OverseerScopeValue | null, sessionId: string | undefined, name: string | undefined): string | undefined {
  if (sessionId) return sessionId;
  if (!scope || !name) return undefined;
  return threadIdByName(scope.threads, name);
}

export function openThread(hubId: string, sessionId: string): void {
  void Haptics.selectionAsync();
  router.push(sessionHref(hubId, sessionId));
}
