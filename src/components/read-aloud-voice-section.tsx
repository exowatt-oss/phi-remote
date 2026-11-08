/**
 * Settings › Voice › Read-aloud voice: the natural voices (tap one to choose it and hear its
 * sample), "System voice", and the natural voice's model: its true state (Downloading / Preparing
 * the files / Preparing the voice N s / Ready / Loaded / Failed: reason), Download / Cancel /
 * Remove, "Try again" after a failure or a guard turned it off, and Diagnostics (copyable).
 */

import { router } from 'expo-router';
import { Alert } from 'react-native';

import { useNow } from '@/hooks/use-now';
import { DOWNLOAD_BYTES, formatMB, SIZE_NOTE, statusLine, type NaturalState } from '@/lib/tts/engine';
import { NATURAL_VOICES, resolveTtsVoice, SYSTEM_VOICE } from '@/lib/tts/voices';
import {
  cancelNaturalDownload,
  removeNaturalVoiceModel,
  requestNaturalDownload,
  retryNaturalVoice,
  useNaturalVoice,
} from '@/services/natural-voice';
import { remote, useRemote } from '@/services/remote';
import { previewNaturalVoice, previewVoice } from '@/services/speech';
import { ListRow, ListSection } from '@/ui';

export function ReadAloudVoiceSection({ systemLabel }: { systemLabel: string }) {
  const s = useNaturalVoice((x) => x);
  const pref = useRemote((x) => resolveTtsVoice(x.prefs.ttsVoice));
  const voice = s.supported ? pref : SYSTEM_VOICE;

  const choose = (id: string) => {
    void remote.updatePrefs({ ttsVoice: id });
    void previewNaturalVoice(id);
  };

  const confirmRemove = () =>
    Alert.alert('Remove the natural voice?', `About ${formatMB(s.bytesOnDisk)} are freed. Replies are read with the system voice until you download it again.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void removeNaturalVoiceModel() },
    ]);

  const off = s.slow || s.crashed || s.broken || !!s.loadFailure;
  const failedRead = s.model === 'ready' && !!s.error && !s.loaded && !s.loading;
  const downloading = s.model === 'downloading' || s.model === 'compiling';
  const footer =
    s.model === 'ready' && s.loading
      ? 'The first time on this iPhone the voice is prepared for its Neural Engine, which can take a minute. Replies use the system voice until it is loaded.'
      : s.model === 'ready'
        ? `${SIZE_NOTE}.`
        : `${SIZE_NOTE}. Until it is ready, replies are read with the system voice.`;

  return (
    <>
      <ListSection
        title="Read-aloud voice"
        footer={
          s.supported
            ? 'Natural voices run on this iPhone and work offline. Tap one to hear it.'
            : 'Natural voices need iOS 18 or later.'
        }
      >
        {NATURAL_VOICES.map((v) => (
          <ListRow
            key={v.id}
            label={v.name}
            detail={v.detail}
            selected={voice === v.id}
            disabled={!s.supported}
            onPress={s.supported ? () => choose(v.id) : undefined}
          />
        ))}
        <ListRow
          label="System voice"
          detail={systemLabel}
          selected={voice === SYSTEM_VOICE}
          onPress={() => {
            void remote.updatePrefs({ ttsVoice: SYSTEM_VOICE });
            previewVoice();
          }}
        />
      </ListSection>
      {s.supported ? (
        <ListSection title="Natural voice model" footer={footer}>
          <ModelStatusRow s={s} />
          {off || failedRead ? <ListRow label="Try again" onPress={retryNaturalVoice} /> : null}
          {s.model === 'absent' ? (
            <ListRow
              label={s.damaged ? 'Repair' : s.bytesOnDisk > 0 ? 'Resume download' : 'Download'}
              detail={s.damaged ? undefined : formatMB(DOWNLOAD_BYTES)}
              onPress={requestNaturalDownload}
            />
          ) : null}
          {downloading ? <ListRow label="Cancel download" onPress={cancelNaturalDownload} /> : null}
          <ListRow label="Diagnostics" chevron onPress={() => router.push('/settings/voice-diagnostics')} />
          {s.model === 'ready' || (s.model === 'absent' && s.bytesOnDisk > 0) ? (
            <ListRow label="Remove model" destructive onPress={confirmRemove} />
          ) : null}
        </ListSection>
      ) : null}
    </>
  );
}

/** The model's state; ticks every second while the voice is being prepared ("… 34 s"). */
function ModelStatusRow({ s }: { s: NaturalState }) {
  const now = useNow(s.loading ? 1_000 : 60_000);
  const status = statusLine(s, Math.max(now, s.loadStartedAt ?? 0));
  return <ListRow label="Natural voice" description={status.label} accessibilityLabel={`Natural voice: ${status.label}`} />;
}
