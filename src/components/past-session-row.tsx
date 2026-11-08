/**
 * One row of All sessions (and the home "Past sessions" section), in the thread row's rhythm:
 * folder · computer and the time (or Running) on line 1, the title on line 2, the last reply on
 * line 3.
 *
 * Overseers (v1 addition): an overseer has the stack mark and "3 threads" with the fold toggle
 * instead of its last reply; its threads follow it indented (a compact two-line row); a thread
 * whose overseer is not listed says whose thread it is.
 */

import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { plainPreview, relativeTime } from '@/lib/format';
import type { HistoryRow, RowNest } from '@/lib/history';
import { basename } from '@/lib/protocol';
import { layout, useTheme } from '@/theme';
import { Icon, StatusDot, Text } from '@/ui';

import { NestedFrame, OverseerMark, OverseerSummaryLine } from './overseer/nesting';

function Status({ row, time }: { row: HistoryRow; time: string }) {
  const { colors } = useTheme();
  if (row.working) {
    return (
      <View style={styles.status}>
        <Icon name="circle.dashed" size={13} weight="semibold" color={colors.accent} />
        <Text variant="label" weight="bold" tone="accent">
          Working
        </Text>
      </View>
    );
  }
  if (row.running) {
    return (
      <View style={styles.status}>
        <StatusDot state="live" size={7} />
        <Text variant="label" weight="bold" tone="secondary">
          Running
        </Text>
      </View>
    );
  }
  return (
    <Text variant="label" tone="tertiary" numeric>
      {time}
    </Text>
  );
}

export const PastSessionRow = memo(function PastSessionRow({
  row,
  now,
  showHost,
  first,
  nest,
  onToggleFold,
  onPress,
  onLongPress,
}: {
  row: HistoryRow;
  /** Overseers (v1 addition): an overseer, one of its threads under it, or a thread elsewhere. */
  nest?: RowNest;
  /** Folds or unfolds an overseer's threads (with `nest.overseer`). */
  onToggleFold?: (foldKey: string) => void;
  now: number;
  /** More than one computer is paired: say which one. */
  showHost: boolean;
  /** First row of its section (no divider above). */
  first: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const { colors } = useTheme();
  const s = row.session;
  const folder = basename(s.cwd) || s.cwd || 'No folder';
  const meta = [nest?.caption, folder, showHost ? row.hostName : ''].filter(Boolean).join(' · ');
  const preview = plainPreview(s.preview);
  const time = relativeTime(row.at, now);
  const ov = nest?.overseer;
  const threads = ov ? (ov.threads > 0 ? [{ text: `${ov.threads} ${ov.threads === 1 ? 'thread' : 'threads'}` }] : [{ text: 'Overseer' }]) : null;

  if (nest?.nested) {
    return (
      <NestedFrame last={nest.nested.last}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[s.overseer?.thread || s.title, row.working ? 'working' : row.running ? 'running' : time, preview].filter(Boolean).join('. ')}
          accessibilityHint={row.running ? 'Opens the thread.' : 'Opens the session.'}
          onPress={onPress}
          onLongPress={onLongPress}
          style={({ pressed }) => [styles.nested, pressed && { backgroundColor: colors.rowPressed }]}
        >
          {!nest.nested.first ? <View style={[styles.nestedDivider, { backgroundColor: colors.separator }]} /> : null}
          <View style={styles.line1}>
            <Text variant="footnote" weight="medium" numberOfLines={1} style={styles.metaText}>
              {s.overseer?.thread || s.title}
            </Text>
            <View style={styles.spacer} />
            <Status row={row} time={time} />
          </View>
          {preview ? (
            <Text variant="label" tone="secondary" numberOfLines={1} style={styles.nestedLine}>
              {preview}
            </Text>
          ) : null}
        </Pressable>
      </NestedFrame>
    );
  }
  const a11y = [
    s.title,
    row.working ? 'working' : row.running ? 'running' : time,
    ov ? 'Overseer' : '',
    `${folder} on ${row.hostName}`,
    row.offline ? `${row.hostName} is offline` : '',
    preview,
  ]
    .filter(Boolean)
    .join('. ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityHint={row.running ? 'Opens the thread.' : 'Opens the session.'}
      accessibilityActions={ov && ov.threads > 0 && onToggleFold ? [{ name: 'toggleThreads', label: ov.folded ? 'Show threads' : 'Hide threads' }] : undefined}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'toggleThreads' && ov && onToggleFold) onToggleFold(ov.foldKey);
      }}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.rowPressed }]}
    >
      {!first ? <View style={[styles.divider, { backgroundColor: colors.separator }]} /> : null}
      <View style={styles.line1}>
        <View style={styles.meta}>
          {showHost && row.offline ? <Icon name="wifi.slash" size={11} color={colors.textTertiary} /> : null}
          {ov ? <OverseerMark dim={row.offline} /> : null}
          <Text variant="label" weight="medium" tone={row.offline ? 'tertiary' : 'secondary'} numberOfLines={1} style={styles.metaText}>
            {meta}
          </Text>
        </View>
        <Status row={row} time={time} />
      </View>
      <Text variant="body" weight={row.offline ? 'regular' : 'medium'} numberOfLines={2} style={styles.title}>
        {s.title}
      </Text>
      {ov && threads ? (
        <OverseerSummaryLine
          segments={threads}
          folded={ov.folded}
          onToggle={ov.threads > 0 && onToggleFold ? () => onToggleFold(ov.foldKey) : undefined}
          dim={row.offline}
        />
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
  meta: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { flexShrink: 1 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  title: { marginTop: 4 },
  line3: { marginTop: 4 },
  spacer: { flex: 1 },
  nested: { paddingRight: layout.rowPaddingH, paddingVertical: 9 },
  nestedDivider: { position: 'absolute', top: 0, left: 0, right: 0, height: StyleSheet.hairlineWidth },
  nestedLine: { marginTop: 2 },
});
