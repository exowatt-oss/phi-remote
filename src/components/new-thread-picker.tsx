/**
 * Model and effort for new threads, picked from one computer's models. Every pick is saved
 * (Prefs.newThread), so it is the default for each new thread until changed. Used by the
 * New-thread sheet's model screen and by Settings › New threads.
 */

import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';

import { ModelList, modelKey } from '@/components/model-list';
import { effortLevels, resolveNewThread, savedModelName, updateNewThreadDefault } from '@/lib/new-thread';
import type { ModelInfo } from '@/lib/protocol';
import { useHubModels } from '@/services/new-thread';
import { remote, useRemote } from '@/services/remote';

const KEPT = 'Your choice becomes the default for every new thread.';

function save(patch: { model?: ModelInfo | null; thinkingLevel?: string }): void {
  void remote.updatePrefs({ newThread: updateNewThreadDefault(remote.store.getState().prefs.newThread, patch) });
}

export function NewThreadPicker({ hubId }: { hubId: string | null }) {
  const host = useRemote((s) => (hubId ? s.hosts[hubId] : undefined));
  const live = host?.conn.status === 'live';
  const saved = useRemote((s) => s.prefs.newThread);
  const { models: data, error } = useHubModels(hubId, live);

  if (!host || !live) {
    const message = host ? `${host.name} is offline. Models come from a connected computer.` : 'Pair a computer to choose a model.';
    return <ModelList models={null} selected={null} onChoose={() => undefined} error={message} />;
  }

  const choice = resolveNewThread(saved, data);
  const hubDefault = data?.current ? data.models.find((m) => modelKey(m) === modelKey(data.current!)) : undefined;
  const footer =
    choice.unavailable && saved?.model ? `${savedModelName(saved.model)} isn't on ${host.name}, so threads there use the default. ${KEPT}` : KEPT;

  const pickModel = (m: ModelInfo | null) => {
    void Haptics.selectionAsync();
    save({ model: m });
    router.back();
  };
  const pickEffort = (level: string) => {
    if (level === saved?.thinkingLevel) return;
    void Haptics.selectionAsync();
    save({ thinkingLevel: level });
  };

  return (
    <ModelList
      models={data?.models ?? null}
      selected={saved?.model && !choice.unavailable ? modelKey(saved.model) : null}
      error={data ? null : error}
      onChoose={pickModel}
      thinking={data && choice.reasoning ? { levels: effortLevels(data) ?? [], current: choice.effort, onChoose: pickEffort } : null}
      header={{ label: 'Default', description: hubDefault?.name, selected: !saved?.model, onPress: () => pickModel(null), footer }}
    />
  );
}
