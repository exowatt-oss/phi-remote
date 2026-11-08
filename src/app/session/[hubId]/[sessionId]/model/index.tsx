/** Model sheet: the thread's model and thinking level. */

import * as Haptics from 'expo-haptics';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';

import { ModelList, modelKey } from '@/components/model-list';
import { describeError, type ModelsResult } from '@/lib/client';
import type { ModelInfo } from '@/lib/protocol';
import { remote } from '@/services/remote';

export default function ModelSheet() {
  const params = useLocalSearchParams<{ hubId: string; sessionId: string }>();
  const hubId = String(params.hubId ?? '');
  const sessionId = String(params.sessionId ?? '');
  const [data, setData] = useState<ModelsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    remote
      .listModels(hubId, sessionId)
      .then((d) => alive && setData(d))
      .catch((err) => alive && setError(describeError(err)));
    return () => {
      alive = false;
    };
  }, [hubId, sessionId]);

  const current = data?.current ? modelKey(data.current) : null;
  const currentModel = data?.models.find((m) => modelKey(m) === current);

  const chooseModel = async (m: ModelInfo | null) => {
    if (!m || modelKey(m) === current || pending) return;
    void Haptics.selectionAsync();
    setPending(modelKey(m));
    setError(null);
    try {
      await remote.setModel(hubId, sessionId, m);
      setData((d) => (d ? { ...d, current: { provider: m.provider, id: m.id } } : d));
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(describeError(err));
    } finally {
      setPending(null);
    }
  };

  const chooseThinking = async (level: string) => {
    if (!data || level === data.thinkingLevel) return;
    void Haptics.selectionAsync();
    const previous = data.thinkingLevel;
    setData({ ...data, thinkingLevel: level });
    setError(null);
    try {
      await remote.setThinking(hubId, sessionId, level);
    } catch (err) {
      setData((d) => (d ? { ...d, thinkingLevel: previous } : d));
      setError(describeError(err));
    }
  };

  return (
    <ModelList
      models={data?.models ?? null}
      selected={current}
      pending={pending}
      error={error}
      onChoose={(m) => void chooseModel(m)}
      thinking={
        data && (currentModel?.reasoning ?? true)
          ? { levels: data.thinkingLevels, current: data.thinkingLevel, onChoose: (l) => void chooseThinking(l) }
          : null
      }
    />
  );
}
