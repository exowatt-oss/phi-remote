/**
 * The composer toolbar while dictating (T3 ComposerDictationControl): ✕ cancel · status ·
 * ✓ confirm. Status: "Preparing" → waveform + clock while recording → "Transcribing…" after ✓
 * (the words land in the draft when it finishes). ✓ works only while recording.
 */

import * as Haptics from 'expo-haptics';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FlipInXDown, ReduceMotion } from 'react-native-reanimated';

import { formatClock } from '@/lib/format';
import { resolveVoiceComposerPresentation } from '@/lib/voice-input/presentation';
import type { Dictation } from '@/services/dictation';
import { motion, space, useTheme } from '@/theme';
import { IconButton, Text } from '@/ui';

import { Waveform } from './waveform';

export function DictationBar({ dictation }: { dictation: Dictation }) {
  const { colors } = useTheme();
  const presentation = resolveVoiceComposerPresentation(
    { phase: dictation.phase, error: dictation.error, errorAction: null },
    dictation.elapsedSeconds,
  );
  const clock = formatClock(dictation.elapsedSeconds * 1000);
  return (
    <Animated.View
      entering={FlipInXDown.duration(motion.composer).reduceMotion(ReduceMotion.System)}
      style={styles.row}
      accessibilityLiveRegion="polite"
    >
      <IconButton
        icon="xmark"
        label={dictation.phase === 'transcribing' ? 'Cancel transcription' : 'Cancel dictation'}
        hint="Discards the recording"
        onPress={dictation.cancel}
      />
      <View style={styles.middle}>
        {dictation.phase === 'recording' ? (
          <Animated.View key="recording" entering={FadeIn.duration(motion.enter)} style={styles.live}>
            <Waveform levels={dictation.levels} />
            <Text variant="label" tone="secondary" numeric accessibilityLabel={`Recording, ${clock}`}>
              {clock}
            </Text>
          </Animated.View>
        ) : dictation.phase === 'transcribing' ? (
          <Animated.View key="transcribing" entering={FadeIn.duration(motion.enter)} style={styles.center}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
            <Text variant="footnote" tone="secondary" accessibilityLabel="Transcribing">
              Transcribing…
            </Text>
          </Animated.View>
        ) : (
          <Animated.View key="preparing" entering={FadeIn.duration(motion.enter)} style={styles.center}>
            <Text variant="footnote" tone="secondary">
              {presentation.statusLabel ?? 'Preparing'}
            </Text>
          </Animated.View>
        )}
      </View>
      <IconButton
        icon="checkmark"
        label="Done dictating"
        hint="Transcribes the recording on this iPhone"
        variant="filled"
        disabled={!presentation.confirmationEnabled}
        onPress={() => {
          void Haptics.selectionAsync();
          dictation.confirm();
        }}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  middle: { flex: 1, minHeight: 32, justifyContent: 'center' },
  center: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs },
  live: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
