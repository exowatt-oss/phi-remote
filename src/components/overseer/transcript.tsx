/**
 * An overseer's transcript, made readable (Overseers, v1 addition):
 * - its `overseer` tool calls as compact cards ("Started api-filters · Opus 5.5 high · No window",
 *   "Sent to api-filters: …", "Closed …"); reads and board checks are one-line rows that fold away
 *   with the rest of a finished turn's work;
 * - its `overseer_event` wake-ups as compact event rows, one per thread update;
 * - a thread's report (`report_to_overseer`, agent mail) as a card with the thread and the kind.
 * Every row that names a thread opens it.
 */

import * as Haptics from 'expo-haptics';
import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text as RNText, View } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';

import { clockTime, plainPreview } from '@/lib/format';
import { eventSummary, overseerCall, type OverseerEvent, type OverseerEventKind, type ThreadReport } from '@/lib/overseer';
import type { NoteItem, ToolItem } from '@/lib/protocol';
import { fonts, layout, motion, radii, space, useTheme } from '@/theme';
import { Icon, Text, type IconName, type Tone } from '@/ui';

import { copyWithFeedback } from '../copy';
import { ShimmerText } from '../shimmer-text';
import { openThread, resolveThread, useOverseerScope } from './scope';

const isFresh = (ts: number) => ts > 0 && Date.now() - ts < motion.freshWindow;

const ACTION_ICON: Record<string, IconName> = {
  spawn: 'rectangle.stack.badge.plus',
  send: 'paperplane',
  close: 'archivebox',
  read: 'eye',
  list: 'rectangle.stack',
  abort: 'stop.circle',
  model: 'cpu',
  resume: 'arrow.clockwise',
  adopt: 'link',
  watch: 'bell',
};

/** Splits "Started api-filters" into the verb and the thread name (drawn medium). */
function Title({ title, thread, tone = 'secondary' }: { title: string; thread?: string; tone?: Tone }) {
  const at = thread ? title.lastIndexOf(thread) : -1;
  if (at < 0) {
    return (
      <Text variant="footnote" tone={tone} numberOfLines={1} style={styles.flex}>
        {title}
      </Text>
    );
  }
  return (
    <Text variant="footnote" tone={tone} numberOfLines={1} style={styles.flex}>
      {title.slice(0, at)}
      <RNText style={{ fontFamily: fonts.medium }}>{thread}</RNText>
      {title.slice(at + thread!.length)}
    </Text>
  );
}

export const OverseerCallCard = memo(function OverseerCallCard({ item, sessionWorking }: { item: ToolItem; sessionWorking: boolean }) {
  const { colors } = useTheme();
  const scope = useOverseerScope();
  const call = useMemo(() => overseerCall(item), [item]);
  if (!call) return null;
  const id = resolveThread(scope, call.sessionId, call.thread);
  const hubId = scope?.hubId;
  const canOpen = !!id && !!hubId && !call.failed;
  const running = call.running && sessionWorking;
  const open = canOpen ? () => openThread(hubId!, id!) : undefined;
  const copy = () => copyWithFeedback(call.text ?? item.output ?? call.title);
  const icon = ACTION_ICON[call.action] ?? 'rectangle.stack';
  const a11y = [call.title, call.meta, call.text ? plainPreview(call.text) : '', call.error].filter(Boolean).join('. ');

  if (call.action === 'spawn') {
    return (
      <Animated.View entering={isFresh(item.ts) ? FadeIn.duration(motion.fresh).reduceMotion(ReduceMotion.System) : undefined}>
        <Pressable
          accessibilityRole={canOpen ? 'button' : undefined}
          accessibilityLabel={a11y}
          accessibilityHint={canOpen ? 'Opens the thread. Long-press to copy its task.' : 'Long-press to copy its task.'}
          onPress={open}
          onLongPress={copy}
          delayLongPress={350}
          style={({ pressed }) => [
            styles.card,
            { backgroundColor: colors.bgElevated, borderColor: colors.border },
            pressed && canOpen && { backgroundColor: colors.rowPressed },
          ]}
        >
          <View style={styles.cardHead}>
            <View style={styles.iconSlot}>
              <Icon name={icon} size={14} color={call.failed ? colors.danger : colors.iconMuted} />
            </View>
            {running ? (
              <View style={styles.flex}>
                <ShimmerText>{call.title}</ShimmerText>
              </View>
            ) : (
              <Title title={call.title} thread={call.thread} tone={call.failed ? 'danger' : 'primary'} />
            )}
            {canOpen ? <Icon name="chevron.right" size={11} weight="semibold" color={colors.chevron} /> : null}
          </View>
          {call.meta ? (
            <Text variant="label" tone="secondary" numberOfLines={1} style={styles.cardIndent}>
              {call.meta}
            </Text>
          ) : null}
          {call.error ? (
            <Text variant="label" tone="danger" numberOfLines={2} style={styles.cardIndent}>
              {call.error}
            </Text>
          ) : call.text ? (
            <Text variant="label" tone="tertiary" numberOfLines={2} style={styles.cardIndent}>
              {plainPreview(call.text)}
            </Text>
          ) : null}
        </Pressable>
      </Animated.View>
    );
  }

  return (
    <Pressable
      accessibilityRole={canOpen ? 'button' : undefined}
      accessibilityLabel={a11y}
      accessibilityHint={canOpen ? 'Opens the thread. Long-press to copy.' : 'Long-press to copy.'}
      onPress={open}
      onLongPress={copy}
      delayLongPress={350}
      hitSlop={4}
      style={({ pressed }) => [styles.row, pressed && canOpen && { backgroundColor: colors.subtle }]}
    >
      <View style={styles.workRow}>
        <View style={styles.iconSlot}>
          <Icon name={icon} size={14} color={colors.iconMuted} />
        </View>
        {running ? (
          <View style={styles.flex}>
            <ShimmerText>{call.title}</ShimmerText>
          </View>
        ) : (
          <Title title={call.title} thread={call.thread} tone={call.failed ? 'danger' : 'secondary'} />
        )}
        {call.failed ? <Icon name="xmark" size={11} weight="semibold" color={colors.danger} style={styles.failMark} /> : null}
        {canOpen ? <Icon name="chevron.right" size={11} weight="semibold" color={colors.chevron} /> : null}
      </View>
      {call.error ? (
        <Text variant="label" tone="danger" numberOfLines={2} style={styles.rowIndent}>
          {call.error}
        </Text>
      ) : call.text ? (
        <Text variant="label" tone="tertiary" numberOfLines={2} style={styles.rowIndent}>
          {plainPreview(call.text)}
        </Text>
      ) : null}
    </Pressable>
  );
});

const EVENT_GLYPH: Record<OverseerEventKind, { icon: IconName; tone: 'success' | 'danger' | 'warning' | 'muted' }> = {
  idle: { icon: 'checkmark.circle', tone: 'success' },
  error: { icon: 'xmark.circle', tone: 'danger' },
  stalled: { icon: 'exclamationmark.circle', tone: 'warning' },
  exited: { icon: 'minus.circle', tone: 'muted' },
  heartbeat: { icon: 'waveform.path.ecg', tone: 'muted' },
};

const EVENT_WORD: Record<OverseerEventKind, string> = {
  idle: 'Finished a turn',
  error: 'Error',
  stalled: 'Quiet for a while',
  exited: 'Exited',
  heartbeat: 'Heartbeat',
};

function EventRow({ event, first }: { event: OverseerEvent; first: boolean }) {
  const { colors } = useTheme();
  const scope = useOverseerScope();
  const id = event.kind === 'heartbeat' ? undefined : resolveThread(scope, undefined, event.thread);
  const canOpen = !!id && !!scope;
  const g = EVENT_GLYPH[event.kind];
  const color = g.tone === 'success' ? colors.success : g.tone === 'danger' ? colors.danger : g.tone === 'warning' ? colors.warning : colors.iconMuted;
  const beat = event.kind === 'heartbeat';
  // "finished · Fast max · $0.02": the glyph says what happened, the words how it went.
  const summary = eventSummary(event);
  const text = beat ? '' : (event.text ?? '');
  return (
    <Pressable
      accessibilityRole={canOpen ? 'button' : undefined}
      accessibilityLabel={[beat ? '' : event.thread, EVENT_WORD[event.kind], summary, text ? plainPreview(text) : ''].filter(Boolean).join(', ')}
      accessibilityHint={canOpen ? 'Opens the thread' : undefined}
      disabled={!canOpen}
      onPress={() => canOpen && openThread(scope!.hubId, id!)}
      onLongPress={() => copyWithFeedback([beat ? '' : event.thread, summary, text].filter(Boolean).join('\n'))}
      delayLongPress={350}
      style={({ pressed }) => [styles.event, pressed && canOpen && { backgroundColor: colors.subtle }]}
    >
      {!first ? <View style={[styles.eventDivider, { backgroundColor: colors.separator }]} /> : null}
      <View style={styles.workRow}>
        <View style={styles.iconSlot}>
          <Icon name={g.icon} size={14} weight="semibold" color={color} />
        </View>
        {beat ? null : (
          <Text variant="footnote" weight="medium" numberOfLines={1} style={styles.eventName}>
            {event.thread}
          </Text>
        )}
        <Text
          variant="label"
          tone={event.kind === 'error' ? 'danger' : event.kind === 'stalled' ? 'warning' : beat ? 'secondary' : 'tertiary'}
          numberOfLines={1}
          style={styles.flex}
        >
          {summary}
        </Text>
        {canOpen ? <Icon name="chevron.right" size={11} weight="semibold" color={colors.chevron} /> : null}
      </View>
      {text ? (
        <Text variant="label" tone={event.kind === 'error' ? 'danger' : 'secondary'} numberOfLines={2} style={styles.rowIndent}>
          {plainPreview(text)}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** One `overseer_event` message: a quiet block of thread updates. */
export const OverseerEventBlock = memo(function OverseerEventBlock({ item, events }: { item: NoteItem; events: OverseerEvent[] }) {
  const { colors } = useTheme();
  return (
    <Animated.View
      entering={isFresh(item.ts) ? FadeIn.duration(motion.fresh).reduceMotion(ReduceMotion.System) : undefined}
      style={[styles.events, { borderLeftColor: colors.borderStrong }]}
    >
      <View style={styles.eventsHead} accessible accessibilityRole="header" accessibilityLabel={`Thread updates, ${clockTime(item.ts)}`}>
        <Text variant="caption" weight="medium" tone="tertiary">
          {events.length === 1 && events[0].kind === 'heartbeat' ? 'Heartbeat' : 'Thread updates'}
        </Text>
        <Text variant="caption" tone="tertiary" numeric>
          {clockTime(item.ts)}
        </Text>
      </View>
      {events.map((e, i) => (
        <EventRow key={`${i}:${e.thread}:${e.kind}`} event={e} first={i === 0} />
      ))}
    </Animated.View>
  );
});

const REPORT: Record<string, { icon: IconName; color: 'accent' | 'danger' | 'success' | 'muted'; word: string }> = {
  question: { icon: 'questionmark.circle', color: 'accent', word: 'Question' },
  blocker: { icon: 'exclamationmark.octagon', color: 'danger', word: 'Blocker' },
  progress: { icon: 'arrow.forward.circle', color: 'muted', word: 'Progress' },
  done: { icon: 'checkmark.circle', color: 'success', word: 'Done' },
};

/** A thread's report to its overseer. */
export const ThreadReportCard = memo(function ThreadReportCard({ item, report }: { item: NoteItem; report: ThreadReport }) {
  const { colors } = useTheme();
  const scope = useOverseerScope();
  const id = resolveThread(scope, undefined, report.thread);
  const canOpen = !!id && !!scope;
  const k = REPORT[report.kind] ?? { icon: 'text.bubble' as IconName, color: 'muted' as const, word: report.kind };
  const color = k.color === 'accent' ? colors.accent : k.color === 'danger' ? colors.danger : k.color === 'success' ? colors.success : colors.iconMuted;
  return (
    <Animated.View entering={isFresh(item.ts) ? FadeIn.duration(motion.fresh).reduceMotion(ReduceMotion.System) : undefined}>
      <Pressable
        accessibilityRole={canOpen ? 'button' : undefined}
        accessibilityLabel={`${k.word} from ${report.thread}: ${report.message}`}
        accessibilityHint={canOpen ? 'Opens the thread. Long-press to copy.' : 'Long-press to copy.'}
        onPress={() => {
          if (!canOpen) return;
          void Haptics.selectionAsync();
          openThread(scope!.hubId, id!);
        }}
        onLongPress={() => copyWithFeedback(report.message)}
        delayLongPress={350}
        style={({ pressed }) => [
          styles.card,
          { backgroundColor: colors.bgElevated, borderColor: colors.border },
          pressed && canOpen && { backgroundColor: colors.rowPressed },
        ]}
      >
        <View style={styles.cardHead}>
          <View style={styles.iconSlot}>
            <Icon name={k.icon} size={14} weight="semibold" color={color} />
          </View>
          <Text variant="footnote" weight="medium" numberOfLines={1} style={styles.reportName}>
            {report.thread}
          </Text>
          <Text variant="label" weight="medium" tone={k.color === 'danger' ? 'danger' : k.color === 'accent' ? 'accent' : 'secondary'} numberOfLines={1} style={styles.flex}>
            {k.word}
          </Text>
          <Text variant="label" tone="tertiary" numeric>
            {clockTime(item.ts)}
          </Text>
          {canOpen ? <Icon name="chevron.right" size={11} weight="semibold" color={colors.chevron} /> : null}
        </View>
        {report.message ? (
          <Text variant="footnote" tone="secondary" numberOfLines={8} style={styles.cardIndent}>
            {report.message}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  iconSlot: { width: layout.workIconSlot, height: layout.workIconSlot, alignItems: 'center', justifyContent: 'center' },
  workRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: layout.workRowMin },
  row: { paddingHorizontal: 2, borderRadius: radii.xs, paddingBottom: 2 },
  rowIndent: { paddingLeft: layout.workIconSlot + 6, paddingBottom: 2 },
  failMark: { opacity: 0.4 },
  card: {
    borderRadius: radii.md,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: space.xs,
    paddingRight: space.md,
    paddingVertical: space.sm,
    gap: 2,
    marginVertical: 3,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 22 },
  cardIndent: { paddingLeft: layout.workIconSlot + 6 },
  events: { borderLeftWidth: 2, paddingLeft: space.sm, marginVertical: space.xs, gap: 0 },
  eventsHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 2, paddingBottom: 2 },
  event: { paddingVertical: 3, borderRadius: radii.xs },
  eventDivider: { position: 'absolute', top: 0, left: layout.workIconSlot + 6, right: 0, height: StyleSheet.hairlineWidth },
  eventName: { flexShrink: 1, maxWidth: '45%' },
  reportName: { flexShrink: 1, maxWidth: '50%' },
});
