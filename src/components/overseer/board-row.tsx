/**
 * One thread of an overseer (Overseers, v1 addition), in the subagent row's rhythm: status glyph,
 * name, model · thinking, time since its last activity and its cost on line 1; what it is doing
 * (shimmering), why it failed, or its last line on line 2. Used by the pinned board, the full
 * board, and the threads nested under an overseer on the lists.
 */

import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { plainPreview, relativeTime } from '@/lib/format';
import { formatCost, threadDetail, threadModelLabel, threadState, type BoardThread, type ThreadState } from '@/lib/overseer';
import { layout, space, useTheme } from '@/theme';
import { Icon, Text, type IconName, type Tone } from '@/ui';

import { ShimmerText } from '../shimmer-text';

/** Horizontal padding inside the pinned board (rows line up with its header). */
export const BOARD_PAD = 14;

const GLYPH: Record<ThreadState, { icon: IconName; tone: 'accent' | 'warning' | 'danger' | 'muted' | 'faint' }> = {
  working: { icon: 'circle.dashed', tone: 'accent' },
  stalled: { icon: 'exclamationmark.circle', tone: 'warning' },
  idle: { icon: 'circle', tone: 'muted' },
  error: { icon: 'xmark.circle', tone: 'danger' },
  exited: { icon: 'minus.circle', tone: 'faint' },
  closed: { icon: 'checkmark.circle', tone: 'faint' },
};

export const STATE_WORD: Record<ThreadState, string> = {
  working: 'Working',
  stalled: 'Quiet for a while',
  idle: 'Idle',
  error: 'Error',
  exited: 'Exited',
  closed: 'Closed',
};

const WORD_TONE: Record<ThreadState, Tone> = {
  working: 'accent',
  stalled: 'warning',
  idle: 'tertiary',
  error: 'danger',
  exited: 'tertiary',
  closed: 'tertiary',
};

export function ThreadGlyph({ state, size = 14 }: { state: ThreadState; size?: number }) {
  const { colors } = useTheme();
  const g = GLYPH[state];
  const color =
    g.tone === 'accent' ? colors.accent : g.tone === 'warning' ? colors.warning : g.tone === 'danger' ? colors.danger : colors.iconMuted;
  return <Icon name={g.icon} size={size} weight="semibold" color={color} style={g.tone === 'faint' ? styles.faint : undefined} />;
}

export type BoardRowVariant = 'tray' | 'card' | 'nested';

export const BoardRow = memo(function BoardRow({
  thread,
  now,
  active,
  first,
  onOpen,
  variant = 'card',
  current = false,
  offline = false,
}: {
  thread: BoardThread;
  now: number;
  /** On screen and the app active (the shimmer runs). */
  active: boolean;
  /** No divider above the first row. */
  first: boolean;
  onOpen?: (sessionId: string) => void;
  variant?: BoardRowVariant;
  /** The thread you are in (the siblings sheet). */
  current?: boolean;
  /** Its computer is unreachable: the last known state, nothing moving. */
  offline?: boolean;
}) {
  const { colors } = useTheme();
  const state = offline && thread.state === 'running' ? (thread.lastError ? 'error' : 'idle') : threadState(thread, now);
  const meta = threadModelLabel(thread);
  const time = thread.lastActivityAt ? relativeTime(thread.lastActivityAt, now) : '';
  const cost = formatCost(thread.costUsd);
  const detail = threadDetail(thread, state);
  const canOpen = !!onOpen && !current;
  const moving = state === 'working' && !offline;
  const a11y = [thread.name, current ? 'this thread' : STATE_WORD[state], meta, time && time !== 'now' ? `${time} ago` : time, cost, detail?.text]
    .filter(Boolean)
    .join(', ');
  const pad = variant === 'tray' ? styles.trayRow : variant === 'nested' ? styles.nestedRow : styles.row;
  const quietLine = !detail ? (state === 'idle' || state === 'exited' || state === 'closed' ? STATE_WORD[state] : null) : null;
  return (
    <Pressable
      accessibilityRole={canOpen ? 'button' : undefined}
      accessibilityLabel={a11y}
      accessibilityHint={canOpen ? 'Opens the thread' : undefined}
      accessible
      disabled={!canOpen}
      onPress={() => onOpen?.(thread.sessionId)}
      style={({ pressed }) => [pad, pressed && { backgroundColor: variant === 'tray' ? colors.pressedOverlay : colors.rowPressed }]}
    >
      {!first ? (
        <View
          style={[styles.divider, variant === 'tray' ? styles.trayDivider : variant === 'nested' ? styles.nestedDivider : null, { backgroundColor: colors.separator }]}
        />
      ) : null}
      <View style={styles.line1}>
        <View style={styles.glyph}>
          <ThreadGlyph state={state} />
        </View>
        <Text variant="footnote" weight="medium" numberOfLines={1} style={styles.name}>
          {thread.name}
        </Text>
        <Text variant="label" tone="tertiary" numberOfLines={1} style={styles.meta}>
          {meta}
        </Text>
        {current ? (
          <Text variant="label" weight="medium" tone="secondary" numberOfLines={1}>
            You are here
          </Text>
        ) : (
          <>
            {time ? (
              <Text variant="label" tone="tertiary" numeric numberOfLines={1}>
                {time}
              </Text>
            ) : null}
            {cost ? (
              <Text variant="label" tone="tertiary" numeric numberOfLines={1}>
                {cost}
              </Text>
            ) : null}
          </>
        )}
        {canOpen ? <Icon name="chevron.right" size={11} weight="semibold" color={colors.chevron} /> : null}
      </View>
      {detail || quietLine ? (
        <View style={styles.indent}>
          {detail?.tone === 'activity' && moving ? (
            <ShimmerText variant="label" active={active}>
              {detail.text}
            </ShimmerText>
          ) : detail ? (
            <Text variant="label" tone={detail.tone === 'danger' ? 'danger' : detail.tone === 'activity' ? 'secondary' : 'tertiary'} numberOfLines={1}>
              {detail.tone === 'plain' ? plainPreview(detail.text) : detail.text}
            </Text>
          ) : (
            <Text variant="label" tone={WORD_TONE[state]} numberOfLines={1}>
              {quietLine}
            </Text>
          )}
        </View>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { paddingHorizontal: space.md, paddingVertical: 10, gap: 2 },
  trayRow: { paddingHorizontal: BOARD_PAD, paddingVertical: 7, gap: 1 },
  nestedRow: { paddingRight: layout.rowPaddingH, paddingVertical: 8, gap: 2 },
  divider: { position: 'absolute', top: 0, left: space.md + layout.workIconSlot, right: 0, height: StyleSheet.hairlineWidth },
  trayDivider: { left: BOARD_PAD + layout.workIconSlot },
  nestedDivider: { left: layout.workIconSlot },
  line1: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 20 },
  glyph: { width: layout.workIconSlot - 6, alignItems: 'flex-start', justifyContent: 'center' },
  name: { flexShrink: 1, maxWidth: '50%' },
  meta: { flex: 1, minWidth: 0 },
  indent: { paddingLeft: layout.workIconSlot },
  faint: { opacity: 0.5 },
});
