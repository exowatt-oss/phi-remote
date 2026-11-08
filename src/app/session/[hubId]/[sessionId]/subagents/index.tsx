/**
 * Subagents sheet (from the pinned tray's "+N more"): every subagent of this thread, one group
 * per launch (newest first), each row opening the subagent's thread.
 */

import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useSubagentChildren, useTicker } from '@/components/subagents/scope';
import { SubagentRowView } from '@/components/subagents/subagent-row';
import { useAppActive } from '@/hooks/use-app-active';
import { clockTime, sessionHref } from '@/lib/format';
import { selectTranscript } from '@/lib/store';
import { countRows, countsLabel, subagentGroups } from '@/lib/subagents';
import { orderedItems } from '@/lib/transcript';
import { useRemote } from '@/services/remote';
import { radii, space, useTheme } from '@/theme';
import { EmptyState, Text } from '@/ui';

export default function SubagentsSheet() {
  const params = useLocalSearchParams<{ hubId: string; sessionId: string }>();
  const hubId = String(params.hubId ?? '');
  const sessionId = String(params.sessionId ?? '');
  const { colors } = useTheme();
  const appActive = useAppActive();
  const transcript = useRemote((s) => selectTranscript(s, hubId, sessionId));
  const children = useSubagentChildren(hubId, sessionId);
  const groups = useMemo(() => subagentGroups(orderedItems(transcript), children), [transcript, children]);
  const now = useTicker(appActive && groups.some((g) => g.rows.some((r) => r.status === 'running')));

  const open = (child: string) => {
    void Haptics.selectionAsync();
    // Close the sheet first: the thread belongs on the main stack, not inside the sheet.
    router.back();
    router.push(sessionHref(hubId, child));
  };

  if (groups.length === 0) {
    return <EmptyState title="No subagents" detail="Subagents this thread starts show up here." />;
  }
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      {groups.map((g) => {
        const label = countsLabel(countRows(g.rows));
        return (
          <View key={g.key} style={styles.group}>
            <View style={styles.groupHeader}>
              <Text variant="label" weight="medium" tone="tertiary" numberOfLines={1} style={styles.when}>
                {g.ts ? `Started ${clockTime(g.ts)}` : 'Earlier'}
              </Text>
              {label ? (
                <Text variant="label" tone="tertiary" numeric numberOfLines={1}>
                  {label}
                </Text>
              ) : null}
            </View>
            <View style={[styles.card, { backgroundColor: colors.bgElevated, borderColor: colors.border }]}>
              {g.rows.map((row, i) => (
                <SubagentRowView key={row.key} row={row} now={now} active={appActive} first={i === 0} onOpen={open} />
              ))}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg },
  group: { gap: space.sm },
  groupHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.xs },
  when: { flex: 1 },
  card: { borderRadius: radii.md, borderCurve: 'continuous', borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
});
