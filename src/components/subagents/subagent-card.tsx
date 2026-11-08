/**
 * The `subagent` tool call in a parent thread, as a card instead of a work-log row: "Subagents"
 * with live counts, then one row per subagent that opens its thread. Built from the call's args
 * first, then filled in from the child sessions the hub reports (Subagents, v1 addition).
 */

import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';

import { sessionHref } from '@/lib/format';
import type { ToolItem } from '@/lib/protocol';
import { countRows, countsLabel, subagentRows } from '@/lib/subagents';
import { motion, radii, space, useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { useSubagentChildren, useSubagentScope, useTicker } from './scope';
import { SubagentRowView } from './subagent-row';

const isFresh = (ts: number) => ts > 0 && Date.now() - ts < motion.freshWindow;

export function SubagentCard({ item, sessionWorking }: { item: ToolItem; sessionWorking: boolean }) {
  const { colors } = useTheme();
  const scope = useSubagentScope();
  const children = useSubagentChildren(scope?.hubId, scope?.parentSessionId);
  // A launch still "running" while its thread is not (interrupted, or the computer is offline)
  // says nothing certain about tasks the hub has not reported: draw those neutral.
  const stale = item.status === 'running' && !sessionWorking;
  const rows = useMemo(() => {
    const all = subagentRows(item, children) ?? [];
    return stale ? all.map((r) => (!r.sessionId && r.status === 'running' ? { ...r, status: 'unknown' as const } : r)) : all;
  }, [item, children, stale]);
  const counts = countRows(rows);
  const active = scope?.active ?? true;
  const now = useTicker(active && rows.some((r) => r.status === 'running' && !!r.startedAt));
  // While the tray above the composer shows them live, the card stays still: one moving copy.
  const shimmer = active && !scope?.pinned;
  const hubId = scope?.hubId;
  const open = useCallback(
    (sessionId: string) => {
      if (!hubId) return;
      void Haptics.selectionAsync();
      router.push(sessionHref(hubId, sessionId));
    },
    [hubId],
  );
  const title = rows.length === 1 ? 'Subagent' : 'Subagents';
  const summary = countsLabel(counts);
  return (
    <Animated.View
      entering={isFresh(item.ts) ? FadeIn.duration(motion.fresh).reduceMotion(ReduceMotion.System) : undefined}
      style={[styles.card, { backgroundColor: colors.bgElevated, borderColor: colors.border }]}
    >
      <View style={styles.header} accessible accessibilityRole="header" accessibilityLabel={`${title}${summary ? `, ${summary}` : ''}`}>
        <Icon name="person.2" size={14} color={colors.iconMuted} />
        <Text variant="footnote" weight="medium" numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        {summary ? (
          <Text variant="label" tone="secondary" numeric numberOfLines={1} style={styles.counts}>
            {summary}
          </Text>
        ) : null}
      </View>
      <View style={[styles.rule, { backgroundColor: colors.border }]} />
      {rows.length === 0 ? (
        <Text variant="label" tone="tertiary" style={styles.empty}>
          {item.status === 'running' && !stale ? 'Starting…' : 'No subagents started.'}
        </Text>
      ) : (
        rows.map((row, i) => <SubagentRowView key={row.key} row={row} now={now} active={shimmer} first={i === 0} onOpen={hubId ? open : undefined} />)
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginVertical: space.xs,
    borderRadius: radii.md,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, paddingTop: 10, paddingBottom: 9 },
  title: { flexShrink: 0 },
  counts: { flex: 1, textAlign: 'right' },
  rule: { height: StyleSheet.hairlineWidth },
  empty: { paddingHorizontal: space.md, paddingVertical: 10 },
});
