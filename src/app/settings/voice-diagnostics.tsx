/**
 * Settings › Voice › Natural voice model › Diagnostics: everything about the natural voice on this
 * iPhone (iOS version, device, model files with sizes and paths, the compute units tried with each
 * attempt's time and error, the last load, the guards, the newest 50 read-aloud events and the
 * native log), refreshed every two seconds. Copy puts it on the clipboard to paste into a message.
 */

import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { copyWithFeedback } from '@/components/copy';
import { naturalVoiceReport } from '@/services/natural-voice';
import { radii, space, useTheme } from '@/theme';
import { Button, Text } from '@/ui';

export default function VoiceDiagnosticsScreen() {
  const { colors } = useTheme();
  const [report, setReport] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const refresh = () =>
      void naturalVoiceReport().then((r) => {
        if (live) setReport(r);
      });
    refresh();
    const t = setInterval(refresh, 2_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <Stack.Screen
        options={{
          headerRight: () => (
            <Button
              compact
              variant="plain"
              title="Copy"
              onPress={() => {
                if (report) copyWithFeedback(report, 'Diagnostics copied');
              }}
            />
          ),
        }}
      />
      <Text variant="footnote" tone="secondary">
        What the natural voice did on this iPhone: the model files, each load attempt and the newest events. Copy puts all of it on
        the clipboard to paste into a message.
      </Text>
      <View style={[styles.card, { backgroundColor: colors.surface }]} accessibilityLabel="Natural voice diagnostics">
        {report === null ? (
          <Text variant="footnote" tone="tertiary">
            Reading…
          </Text>
        ) : (
          report.split('\n').map((line, i) => (
            <Text key={i} mono variant="footnote" selectable tone={line.startsWith('  ') || !line ? 'primary' : 'secondary'}>
              {line || ' '}
            </Text>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.md, paddingBottom: space.xxxl * 2 },
  card: { borderRadius: radii.group, borderCurve: 'continuous', paddingVertical: space.md, paddingHorizontal: space.lg, gap: 1 },
});
