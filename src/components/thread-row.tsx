/**
 * Home list row (T3 thread-list-v2): model · kind and status on line 1, the title on
 * line 2, the latest words (or the running tool) on line 3.
 *
 * Overseers (v1 addition): an overseer carries a quiet stack mark on line 1 and its thread
 * summary ("4 threads · 2 working · 1 error") with the fold toggle on line 3; its threads sit
 * under it. A thread whose overseer is not listed says whose thread it is on line 1.
 */

import { memo } from 'react';
import { Pressable, StyleSheet, Text as RNText, View } from 'react-native';

import { modelLabel, plainPreview, relativeTime, threadTitle } from '@/lib/format';
import type { CountSegment } from '@/lib/overseer';
import type { SessionSummary, SubagentCounts } from '@/lib/protocol';
import { subagentsMeta } from '@/lib/subagents';
import { fonts, layout, logType, useTheme } from '@/theme';
import { Icon, StatusDot, Text } from '@/ui';

import { OverseerMark, OverseerSummaryLine } from './overseer/nesting';

function Status({ working, offline, label }: { working: boolean; offline: boolean; label: string }) {
  const { colors } = useTheme();
  if (offline) {
    return (
      <View style={styles.status}>
        <Icon name="wifi.slash" size={13} weight="semibold" color={colors.textTertiary} />
        <Text variant="label" weight="bold" tone="tertiary">
          Offline
        </Text>
      </View>
    );
  }
  if (working) {
    return (
      <View style={styles.status}>
        <Icon name="circle.dashed" size={13} weight="semibold" color={colors.accent} />
        <Text variant="label" weight="bold" tone="accent">
          Working
        </Text>
      </View>
    );
  }
  return (
    <Text variant="label" tone="tertiary" numeric>
      {label}
    </Text>
  );
}

/** "● 2 subagents running" (accent dot) or "4 subagents" once they are all done. */
function Subagents({ counts, offline }: { counts: SubagentCounts | undefined; offline: boolean }) {
  const meta = subagentsMeta(counts);
  if (!meta) return null;
  const running = meta.running && !offline;
  return (
    <View style={styles.status}>
      <StatusDot state={running ? 'working' : 'idle'} size={6} />
      <Text variant="label" weight="medium" tone={running ? 'secondary' : 'tertiary'} numeric numberOfLines={1}>
        {meta.label}
      </Text>
    </View>
  );
}

export const ThreadRow = memo(function ThreadRow({
  session,
  subagents,
  now,
  offline,
  connecting = false,
  first,
  overseer,
  caption,
  onPress,
  onLongPress,
}: {
  session: SessionSummary;
  /** Overseers (v1 addition): this session is an overseer; its thread summary and fold state. */
  overseer?: { segments: CountSegment[]; folded: boolean; onToggle?: () => void } | null;
  /** Overseers (v1 addition): "Thread of …" when its overseer is not on the list. */
  caption?: string | null;
  /** Subagents (v1 addition): this thread's subagents, when it has any. */
  subagents?: SubagentCounts;
  now: number;
  /** The computer is not reachable; the row shows the last known state. */
  offline: boolean;
  /** The computer is reconnecting (not offline yet): the row reads as usual, without "Working". */
  connecting?: boolean;
  /** First row of its section (no divider above). */
  first: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { colors } = useTheme();
  const working = session.status === 'working' && !offline && !connecting;
  const title = threadTitle(session.name, session.lastText);
  const meta = [caption, modelLabel(session.model), session.kind === 'headless' ? 'headless' : '', session.tmux ? 'tmux' : '']
    .filter(Boolean)
    .join(' · ');
  const agents = subagentsMeta(subagents);
  const preview = plainPreview(session.lastText);
  const time = relativeTime(session.lastActivityAt, now);
  const activity = working ? session.activity : undefined;
  const a11y = [
    title,
    overseer ? 'Overseer' : '',
    offline ? 'offline' : working ? `working${activity ? `, ${activity.tool}` : ''}` : time,
    meta,
    agents?.label,
    overseer ? overseer.segments.map((x) => x.text).join(', ') : !activity ? preview : activity.summary,
  ]
    .filter(Boolean)
    .join('. ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityHint="Opens the thread. Long-press for more."
      accessibilityActions={overseer?.onToggle ? [{ name: 'toggleThreads', label: overseer.folded ? 'Show threads' : 'Hide threads' }] : undefined}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'toggleThreads') overseer?.onToggle?.();
      }}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.rowPressed }]}
    >
      {!first ? <View style={[styles.divider, { backgroundColor: colors.separator }]} /> : null}
      <View style={styles.line1}>
        <View style={styles.metaBox}>
          {overseer ? <OverseerMark dim={offline} /> : null}
          <Text variant="label" weight="medium" tone="secondary" numberOfLines={1} style={styles.meta}>
            {meta}
          </Text>
        </View>
        <Subagents counts={subagents} offline={offline} />
        <Status working={working} offline={offline} label={time} />
      </View>
      <Text variant="body" weight={offline ? 'regular' : 'medium'} numberOfLines={2} style={styles.title}>
        {title}
      </Text>
      {overseer ? (
        <OverseerSummaryLine segments={overseer.segments} folded={overseer.folded} onToggle={overseer.onToggle} dim={offline} />
      ) : activity ? (
        <Text variant="label" tone="secondary" numberOfLines={1} style={styles.line3}>
          <RNText style={[logType, { fontFamily: fonts.mono }]}>{activity.tool}</RNText>
          {activity.summary ? `  ${activity.summary}` : ''}
        </Text>
      ) : preview ? (
        <Text variant="label" tone="secondary" numberOfLines={1} style={styles.line3}>
          {preview}
        </Text>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { paddingHorizontal: layout.rowPaddingH, paddingVertical: layout.rowPaddingV },
  divider: { position: 'absolute', top: 0, left: layout.rowPaddingH, right: 0, height: StyleSheet.hairlineWidth },
  line1: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  metaBox: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5 },
  meta: { flexShrink: 1, minWidth: 0 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  title: { marginTop: 4 },
  line3: { marginTop: 4 },
});
