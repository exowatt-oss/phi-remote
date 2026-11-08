/**
 * Voice: live dictation (Phonon-2, off by default) at the top, the microphone dictation uses
 * (iPhone by default, or Headset), the dictation dictionary, then the read-aloud voice: the
 * natural voices and their model (`ReadAloudVoiceSection`), and, when "System voice" is chosen,
 * the installed system voices for this iPhone's language, grouped Premium / Enhanced / Default.
 * Tapping a voice chooses it and plays a sample.
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet } from 'react-native';

import { DictionarySection } from '@/components/dictionary-section';
import { LiveDictationSection } from '@/components/live-dictation-section';
import { ReadAloudVoiceSection } from '@/components/read-aloud-voice-section';
import { DICTATION_MICS, dictationMic } from '@/lib/dictation-mic';
import { pickBestVoice, voiceLabel, voiceQuality, type VoiceLike } from '@/lib/speech';
import { resolveTtsVoice, SYSTEM_VOICE } from '@/lib/tts/voices';
import { useNaturalVoice } from '@/services/natural-voice';
import { remote, useRemote } from '@/services/remote';
import { deviceLanguage, installedVoices, previewVoice } from '@/services/speech';
import { space, useTheme } from '@/theme';
import { ListRow, ListSection, Text } from '@/ui';

const GROUPS = ['Premium', 'Enhanced', 'Default'] as const;

export default function VoiceScreen() {
  const { colors } = useTheme();
  const voiceId = useRemote((s) => s.prefs.voiceId);
  const ttsVoice = useRemote((s) => resolveTtsVoice(s.prefs.ttsVoice));
  const naturalSupported = useNaturalVoice((s) => s.supported);
  const system = ttsVoice === SYSTEM_VOICE || !naturalSupported;
  const mic = useRemote((s) => dictationMic(s.prefs));
  const [voices, setVoices] = useState<VoiceLike[] | null>(null);

  useEffect(() => {
    void installedVoices().then(setVoices);
  }, []);

  if (!voices) return <ActivityIndicator style={styles.loading} color={colors.textSecondary} />;

  const lang = deviceLanguage();
  const base = lang.split(/[-_]/)[0].toLowerCase();
  const mine = voices
    .filter((v) => v.language.toLowerCase().startsWith(base))
    .sort((a, b) => a.language.localeCompare(b.language) || a.name.localeCompare(b.name));
  const best = pickBestVoice(voices, lang);

  const choose = async (v: VoiceLike | null) => {
    await remote.updatePrefs({ voiceId: v?.identifier });
    previewVoice(v ?? best);
  };

  return (
    <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <LiveDictationSection />
      <ListSection
        title="Microphone"
        footer="Dictation listens through this microphone when headphones are connected. With Headset, the headphones switch to call audio while you dictate."
      >
        {DICTATION_MICS.map(({ value, label }) => (
          <ListRow key={value} label={label} selected={mic === value} onPress={() => void remote.updatePrefs({ dictationMic: value })} />
        ))}
      </ListSection>
      <DictionarySection />
      <ReadAloudVoiceSection systemLabel={voiceLabelFor(voiceId, mine, best)} />
      {system ? (
        <>
          <ListSection title="System voice">
            <ListRow
              label="Automatic"
              description={best ? `Best installed: ${voiceLabel(best)}` : 'System default'}
              selected={!voiceId}
              onPress={() => void choose(null)}
            />
          </ListSection>
          {GROUPS.map((group) => {
            const list = mine.filter((v) => voiceQuality(v) === group);
            if (list.length === 0) return null;
            return (
              <ListSection key={group} title={group}>
                {list.map((v) => (
                  <ListRow
                    key={v.identifier}
                    label={v.name}
                    detail={v.language}
                    selected={voiceId === v.identifier}
                    onPress={() => void choose(v)}
                  />
                ))}
              </ListSection>
            );
          })}
          <Text variant="footnote" tone="secondary" style={styles.footer}>
            {mine.length === 0 ? 'No voices are installed for this language. ' : ''}
            Download higher-quality voices in iOS Settings › Accessibility › Spoken Content › Voices.
          </Text>
        </>
      ) : null}
    </ScrollView>
  );
}

/** "Samantha (Enhanced)" for the chosen system voice, or the best installed one ("Automatic"). */
function voiceLabelFor(voiceId: string | undefined, voices: VoiceLike[], best: VoiceLike | null): string {
  const v = (voiceId && voices.find((x) => x.identifier === voiceId)) || best;
  return v ? voiceLabel(v) : 'Default';
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.xl, paddingBottom: space.xxxl * 2 },
  loading: { marginTop: space.xxxl },
  footer: { paddingHorizontal: space.lg },
});
