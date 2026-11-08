/**
 * Choices on the New-thread sheet, shared by its screens (computer, folder, model), plus each
 * computer's model list. The model and effort themselves are saved in Prefs.newThread.
 */

import { useEffect } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { describeError, type ModelsResult } from '@/lib/client';

import { remote, useRemote } from './remote';

/** What the New-thread sheet starts: one thread, or an overseer that starts threads. */
export type NewThreadMode = 'thread' | 'overseer';

export type NewThreadState = {
  hubId: string | null;
  mode: NewThreadMode;
  /** Folder per computer, as typed or picked (may start with ~). */
  folder: Record<string, string>;
  cwds: Record<string, string[]>;
  models: Record<string, ModelsResult>;
  /** Last models.list failure per computer (cleared on success). */
  modelsError: Record<string, string>;
};

export const newThreadStore = createStore<NewThreadState>()(() => ({ hubId: null, mode: 'thread', folder: {}, cwds: {}, models: {}, modelsError: {} }));

export function useNewThread<T>(select: (s: NewThreadState) => T): T {
  return useStore(newThreadStore, select);
}

export function setNewThread(patch: (s: NewThreadState) => Partial<NewThreadState>): void {
  newThreadStore.setState((s) => patch(s));
}

/**
 * The computer a new thread goes to: the one chosen on the sheet, else the first live one, else
 * the first paired. `preferLive` (Settings) skips a chosen computer that is offline.
 */
export function useNewThreadHubId(preferLive = false): string | null {
  const chosen = useNewThread((s) => s.hubId);
  return useRemote((s) => {
    const paired = chosen && s.hosts[chosen] ? chosen : null;
    const live = s.hostOrder.find((id) => s.hosts[id]?.conn.status === 'live') ?? null;
    if (paired && (!preferLive || s.hosts[paired].conn.status === 'live')) return paired;
    return live ?? paired ?? s.hostOrder[0] ?? null;
  });
}

const inflight = new Set<string>();

/** That computer's models (models.list without a session), fetched once while it is live. */
export function useHubModels(hubId: string | null, live: boolean): { models: ModelsResult | undefined; error: string | undefined } {
  const models = useNewThread((s) => (hubId ? s.models[hubId] : undefined));
  const error = useNewThread((s) => (hubId ? s.modelsError[hubId] : undefined));
  useEffect(() => {
    if (!hubId || !live || newThreadStore.getState().models[hubId] || inflight.has(hubId)) return;
    inflight.add(hubId);
    remote
      .listModels(hubId)
      .then((data) =>
        setNewThread((s) => {
          const modelsError = { ...s.modelsError };
          delete modelsError[hubId];
          return { models: { ...s.models, [hubId]: data }, modelsError };
        }),
      )
      .catch((err) => setNewThread((s) => ({ modelsError: { ...s.modelsError, [hubId]: describeError(err) } })))
      .finally(() => inflight.delete(hubId));
  }, [hubId, live]);
  return { models, error };
}
