/**
 * One subagent in a card (after T3's SubagentRow): status glyph, name + agent/model, elapsed;
 * the task on line 2; on line 3 what it is doing now (shimmering) or how it ended.
 * The `tray` variant (the pinned tray above the composer) is denser: no task line, and a failed
 * run says why it failed instead of its stats.
 */

import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { plainPreview } from '@/lib/format';
import { statusWord, subagentElapsed, subagentStats, type SubagentRow, type SubagentRowStatus } from '@/lib/subagents';
import { layout, space, useTheme } from '@/theme';
import { Icon, Text, type IconName, type Tone } from '@/ui';

import { ShimmerText } from '../shimmer-text';

/** Horizontal padding of the tray (its rows line up with its header). */
export const TRAY_PAD = 14;

const GLYPH: Record<SubagentRowStatus, { icon: IconName; tone: 'accent' | 'success' | 'danger' | 'muted' }> = {
  running: { icon: 'circle.dashed', tone: 'accent' },
  done: { icon: 'checkmark.circle', tone: 'success' },
  failed: { icon: 'xmark.circle', tone: 'danger' },
  killed: { icon: 'stop.circle', tone: 'muted' },
  unknown: { icon: 'circle', tone: 'muted' },
};

const WORD_TONE: Record<SubagentRowStatus, Tone> = {
  running: 'accent',
  done: 'success',
  failed: 'danger',
  killed: 'tertiary',
  unknown: 'tertiary',
};

export function SubagentStatusGlyph({ status, size = 14 }: { status: SubagentRowStatus; size?: number }) {
  const { colors } = useTheme();
  const g = GLYPH[status];
  const color = g.tone === 'accent' ? colors.accent : g.tone === 'success' ? colors.success : g.tone === 'danger' ? colors.danger : colors.iconMuted;
  return <Icon name={g.icon} size={size} weight="semibold" color={color} style={status === 'unknown' ? styles.faint : undefined} />;
}

/** Line 3: live activity while running, else the outcome ("Done · 6 turns · 14 tool calls"). */
function Detail({ row, active, tray }: { row: SubagentRow; active: boolean; tray: boolean }) {
  if (row.status === 'running') {
    if (!row.sessionId) return null; // args only: nothing live to say
    const label = row.activity
      ? `${row.activity.tool}${row.activity.summary ? `  ${row.activity.summary}` : ''}`
      : row.working
        ? 'Thinking'
        : plainPreview(row.lastText) || 'Working';
    return row.working ? (
      <ShimmerText variant="label" active={active}>
        {label}
      </ShimmerText>
    ) : (
      <Text variant="label" tone="tertiary" numberOfLines={1}>
        {label}
      </Text>
    );
  }
  if (row.status === 'unknown') return null;
  const stats = (tray && row.status === 'failed' ? plainPreview(row.lastText) : '') || subagentStats(row);
  return (
    <Text variant="label" tone="tertiary" numberOfLines={1}>
      <Text variant="label" weight="medium" tone={WORD_TONE[row.status]}>
        {statusWord(row.status)}
      </Text>
      {stats ? ` · ${stats}` : ''}
    </Text>
  );
}

export const SubagentRowView = memo(function SubagentRowView({
  row,
  now,
  active,
  first,
  onOpen,
  variant = 'card',
}: {
  row: SubagentRow;
  now: number;
  active: boolean;
  /** No divider above the first row. */
  first: boolean;
  onOpen?: (sessionId: string) => void;
  variant?: 'card' | 'tray';
}) {
  const { colors } = useTheme();
  const tray = variant === 'tray';
  // An unnamed task is called after its agent ("scout", "scout #2"): do not repeat it.
  const agent = row.agent && row.name !== row.agent && !row.name.startsWith(`${row.agent} #`) ? row.agent : null;
  const meta = [agent, row.model].filter(Boolean).join(' · ');
  const elapsed = subagentElapsed(row, now);
  const canOpen = !!row.sessionId && !!onOpen;
  const status = statusWord(row.status);
  const a11y = [
    row.name,
    status,
    row.status === 'running' && row.activity ? `${row.activity.tool} ${row.activity.summary ?? ''}`.trim() : '',
    elapsed,
    meta,
    row.task,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <Pressable
      accessibilityRole={canOpen ? 'button' : undefined}
      accessibilityLabel={a11y}
      accessibilityHint={canOpen ? "Opens the subagent's thread" : undefined}
      accessible
      disabled={!canOpen}
      onPress={() => row.sessionId && onOpen?.(row.sessionId)}
      style={({ pressed }) => [
        tray ? styles.trayRow : styles.row,
        // The tray sits on glass: a translucent press, as in the slash-command menu.
        pressed && { backgroundColor: tray ? colors.pressedOverlay : colors.rowPressed },
      ]}
    >
      {!first ? <View style={[styles.divider, tray && styles.trayDivider, { backgroundColor: colors.separator }]} /> : null}
      <View style={styles.line1}>
        <View style={styles.glyph}>
          <SubagentStatusGlyph status={row.status} />
        </View>
        <Text variant="footnote" weight="medium" numberOfLines={1} style={styles.name}>
          {row.name}
        </Text>
        <Text variant="label" tone="tertiary" numberOfLines={1} style={styles.meta}>
          {meta}
        </Text>
        {elapsed ? (
          <Text variant="label" tone="tertiary" numeric numberOfLines={1}>
            {elapsed}
          </Text>
        ) : null}
        {canOpen ? <Icon name="chevron.right" size={11} weight="semibold" color={colors.chevron} /> : null}
      </View>
      {row.task && !tray ? (
        <Text variant="label" tone="secondary" numberOfLines={1} style={styles.indent}>
          {row.task}
        </Text>
      ) : null}
      <View style={styles.indent}>
        <Detail row={row} active={active} tray={tray} />
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { paddingHorizontal: space.md, paddingVertical: 10, gap: 2 },
  trayRow: { paddingHorizontal: TRAY_PAD, paddingVertical: 7, gap: 1 },
  divider: { position: 'absolute', top: 0, left: space.md + layout.workIconSlot, right: 0, height: StyleSheet.hairlineWidth },
  trayDivider: { left: TRAY_PAD + layout.workIconSlot },
  line1: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 20 },
  glyph: { width: layout.workIconSlot - 6, alignItems: 'flex-start', justifyContent: 'center' },
  name: { flexShrink: 1, maxWidth: '50%' },
  meta: { flex: 1, minWidth: 0 },
  indent: { paddingLeft: layout.workIconSlot },
  faint: { opacity: 0.5 },
});
