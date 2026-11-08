/**
 * Settings › Voice › Live dictation: the toggle (off by default), the model status line, the size
 * note, "Download on cellular", "Remove model", and the details screen for real-iPhone tests.
 */

import { router } from 'expo-router';
import { Alert, Switch } from 'react-native';

import { SIZE_NOTE, statusLine } from '@/lib/live-dictation/status';
import {
  removeLiveDictationModel,
  setLiveDictationCellular,
  setLiveDictationEnabled,
  setLiveDictationForceEnglish,
  useLiveDictation,
} from '@/services/live-dictation';
import { useTheme } from '@/theme';
import { ListRow, ListSection } from '@/ui';

export function LiveDictationSection() {
  const { colors } = useTheme();
  const s = useLiveDictation((x) => x);
  const status = statusLine(s);
  const switchColors = { true: colors.accent, false: colors.surfacePressed };
  const hasFiles = s.model === 'downloaded' || s.bytesOnDisk > 0;

  const confirmRemove = () =>
    Alert.alert('Remove the live dictation model?', 'Live dictation turns off and ~330 MB are freed. Turning it on downloads the model again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void removeLiveDictationModel() },
    ]);

  return (
    <ListSection
      title="Live dictation"
      footer={`Words appear as you speak, recognized on this iPhone by Phonon-2 on the Neural Engine. ${SIZE_NOTE}. Until it is ready, dictation works as before.`}
    >
      <ListRow
        label="Live dictation"
        description={status.label}
        accessory={
          <Switch
            value={s.enabled && !s.slow}
            disabled={!s.supported}
            onValueChange={(v) => setLiveDictationEnabled(v)}
            trackColor={switchColors}
            accessibilityLabel="Live dictation"
          />
        }
      />
      <ListRow
        label="Download on cellular"
        description="Off: the model downloads only on Wi-Fi."
        accessory={
          <Switch
            value={s.cellular}
            disabled={!s.supported}
            onValueChange={(v) => setLiveDictationCellular(v)}
            trackColor={switchColors}
            accessibilityLabel="Download on cellular"
          />
        }
      />
      {!s.deviceEnglish ? (
        <ListRow
          label="Use for English dictation"
          description="Live dictation is English only; this iPhone's language is not."
          accessory={
            <Switch
              value={s.forceEnglish}
              onValueChange={(v) => setLiveDictationForceEnglish(v)}
              trackColor={switchColors}
              accessibilityLabel="Use live dictation for English"
            />
          }
        />
      ) : null}
      <ListRow label="Live dictation details" chevron onPress={() => router.push('/settings/live-dictation')} />
      {hasFiles ? <ListRow label="Remove model" destructive onPress={confirmRemove} /> : null}
    </ListSection>
  );
}
