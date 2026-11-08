/**
 * Feed rows, after T3's ThreadFeed: user bubble, unboxed assistant reply with a meta row
 * (read aloud, copy, time), work-log tool rows, the "Worked for …" fold, note dividers and
 * the working tail row.
 */

import * as Haptics from 'expo-haptics';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text as RNText, View, type StyleProp, type ViewStyle } from 'react-native';
import { GestureDetector, useLongPressGesture } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeInUp,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { splitLeadingCommand } from '@/lib/commands';
import { argsBeyondSummary, clockTime, splitToolSummary, toolSymbol } from '@/lib/format';
import type { AssistantItem, NoteItem, ToolItem, TranscriptItem, UserItem } from '@/lib/protocol';
import { overseerEvents, threadReport } from '@/lib/overseer';
import { parentMessageText, subagentLaunch, TASK_ITEM_ID } from '@/lib/subagents';
import { itemCopyText } from '@/lib/transcript';
import { toggleSpeak, useSpeakingId } from '@/services/speech';
import { fonts, layout, motion, radii, space, useReduceMotion, useTheme } from '@/theme';
import { Icon, IconButton, Notice, Text } from '@/ui';

import { copyWithFeedback } from '../copy';
import { Markdown } from '../markdown';
import { OverseerCallCard, OverseerEventBlock, ThreadReportCard } from '../overseer/transcript';
import { ShimmerText } from '../shimmer-text';
import { SubagentCard } from '../subagents/subagent-card';

const isFresh = (ts: number) => ts > 0 && Date.now() - ts < motion.freshWindow;

/** Rotating disclosure chevron (180 ms). */
function Chevron({ open, from = 'right' }: { open: boolean; from?: 'right' | 'down' }) {
  const { colors } = useTheme();
  const angle = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    angle.value = withTiming(open ? 1 : 0, { duration: motion.disclosure, reduceMotion: ReduceMotion.System });
  }, [open, angle]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${angle.value * (from === 'right' ? 90 : 180)}deg` }] }));
  return (
    <Animated.View style={[styles.chevron, style]}>
      <Icon name={from === 'right' ? 'chevron.right' : 'chevron.down'} size={11} color={colors.iconMuted} />
    </Animated.View>
  );
}

/**
 * Long-press anywhere on a message to copy it. A native gesture rather than a Pressable: a
 * Pressable becomes the JS responder on touch-down, and RN's ScrollView will not start a drag
 * while an ancestor is the JS responder (`touchesShouldCancelInContentView`), so tables and
 * code blocks inside the message could not be swiped sideways.
 */
function LongPressCopy({
  copyText,
  delay,
  style,
  children,
}: {
  copyText: () => string;
  delay: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const gesture = useLongPressGesture({ minDuration: delay, runOnJS: true, onActivate: () => copyWithFeedback(copyText()) });
  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible
        accessibilityHint="Long-press to copy"
        accessibilityActions={COPY_ACTIONS}
        onAccessibilityAction={(e) => e.nativeEvent.actionName === 'copy' && copyWithFeedback(copyText())}
        style={style}
      >
        {children}
      </View>
    </GestureDetector>
  );
}
const COPY_ACTIONS = [{ name: 'copy', label: 'Copy' }];

/** Copy control that flips to a green "Copied" for 1.5 s. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? 'Copied' : label}
      hitSlop={8}
      onPress={() => {
        copyWithFeedback(text, null);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), motion.copied);
      }}
      style={({ pressed }) => [styles.metaButton, pressed && { opacity: 0.7 }]}
    >
      <Icon name={copied ? 'checkmark' : 'doc.on.doc'} size={13} color={copied ? colors.success : colors.iconMuted} />
      {copied ? (
        <Text variant="micro" weight="medium" tone="success">
          Copied
        </Text>
      ) : null}
    </Pressable>
  );
}

/** The slash command a message starts with, as an accent pill (`/use-subs`). */
function CommandPill({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.commandPill, { backgroundColor: colors.accentSoft }]} accessible accessibilityLabel={`Command /${label}`}>
      <RNText maxFontSizeMultiplier={1.4} numberOfLines={1} style={[styles.commandPillText, { color: colors.accent }]}>
        {`/${label}`}
      </RNText>
    </View>
  );
}

function UserMessage({ item }: { item: UserItem }) {
  const { colors } = useTheme();
  // A leading `/command` (or phi's expanded skill block) becomes a pill above its arguments.
  const lead = useMemo(() => splitLeadingCommand(item.text), [item.text]);
  const copyText = lead ? `/${lead.name}${lead.rest ? ` ${lead.rest}` : ''}` : item.text;
  const body = lead ? lead.rest : item.text;
  return (
    <Animated.View
      entering={isFresh(item.ts) ? FadeInUp.duration(motion.fresh).reduceMotion(ReduceMotion.System) : undefined}
      style={styles.userRow}
    >
      <LongPressCopy copyText={() => copyText} delay={350} style={[styles.userBubble, { backgroundColor: colors.userBubble }]}>
        {lead ? <CommandPill label={lead.label} /> : null}
        {body ? <Markdown text={body} tone="user" /> : null}
        {item.images ? (
          <View style={styles.imagesNote}>
            <Icon name="photo" size={12} color={colors.textSecondary} />
            <Text variant="caption" tone="secondary">
              {item.images === 1 ? '1 image' : `${item.images} images`}
            </Text>
          </View>
        ) : null}
      </LongPressCopy>
      <View style={[styles.meta, styles.userMeta]}>
        {item.text ? <CopyButton text={copyText} label="Copy message" /> : null}
        <Text variant="label" weight="medium" tone="secondary" numeric>
          {clockTime(item.ts)}
        </Text>
      </View>
    </Animated.View>
  );
}

/** A subagent's task (its transcript's first item): a quiet card, not a chat bubble. */
function TaskHeader({ item }: { item: UserItem }) {
  const { colors } = useTheme();
  const long = item.text.length > 280 || item.text.split('\n').length > 5;
  const [open, setOpen] = useState(false);
  return (
    <Pressable
      accessibilityRole={long ? 'button' : 'text'}
      accessibilityLabel={`Task: ${item.text}`}
      accessibilityState={long ? { expanded: open } : undefined}
      accessibilityHint="Long-press to copy"
      disabled={!long}
      onPress={() => setOpen((v) => !v)}
      onLongPress={() => copyWithFeedback(item.text)}
      delayLongPress={350}
      style={[styles.task, { backgroundColor: colors.bgElevated, borderColor: colors.border }]}
    >
      <View style={styles.taskHead}>
        <Icon name="list.bullet.rectangle" size={13} color={colors.iconMuted} />
        <Text variant="caption" weight="medium" tone="tertiary">
          Task
        </Text>
      </View>
      <Text variant="footnote" numberOfLines={long && !open ? 6 : undefined} selectable={!long}>
        {item.text}
      </Text>
      {long ? (
        <Text variant="caption" weight="medium" tone="tertiary">
          {open ? 'Show less' : 'Show all'}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** A message the parent agent sent the subagent: a quiet note, not the user's bubble. */
function ParentMessage({ item, text }: { item: UserItem; text: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={`From parent agent: ${text}`}
      accessibilityHint="Long-press to copy"
      onLongPress={() => copyWithFeedback(text)}
      delayLongPress={350}
      style={[styles.parentMsg, { borderLeftColor: colors.borderStrong }]}
    >
      <View style={styles.taskHead}>
        <Icon name="arrow.turn.down.right" size={12} color={colors.iconMuted} />
        <Text variant="caption" weight="medium" tone="tertiary">
          From parent agent
        </Text>
        <Text variant="caption" tone="tertiary" numeric>
          {clockTime(item.ts)}
        </Text>
      </View>
      <Text variant="footnote" tone="secondary">
        {text}
      </Text>
    </Pressable>
  );
}

function ThinkingDisclosure({ text, live }: { text: string; live: boolean }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={live ? 'Thinking' : 'Thought for a moment'}
        accessibilityHint={open ? 'Hides the thinking' : 'Shows the thinking'}
        hitSlop={4}
        onPress={() => {
          void Haptics.selectionAsync();
          setOpen((v) => !v);
        }}
        style={({ pressed }) => [styles.workRow, pressed && { backgroundColor: colors.subtle }]}
      >
        <View style={styles.iconSlot}>
          <Icon name="brain" size={14} color={colors.iconMuted} />
        </View>
        {live ? (
          <ShimmerText>Thinking</ShimmerText>
        ) : (
          <Text variant="footnote" tone="secondary" style={styles.flex}>
            Thought for a moment
          </Text>
        )}
        <Chevron open={open} />
      </Pressable>
      {open ? (
        <Animated.View
          entering={FadeIn.duration(motion.detailIn).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(motion.detailOut).reduceMotion(ReduceMotion.System)}
          style={styles.thinkingBody}
        >
          <Text variant="footnote" tone="secondary" selectable>
            {text}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

function SpeakButton({ item }: { item: AssistantItem }) {
  const { colors } = useTheme();
  const reduce = useReduceMotion();
  const speaking = useSpeakingId() === item.id;
  return (
    <IconButton
      icon={speaking ? 'speaker.wave.2.fill' : 'speaker.wave.2'}
      label={speaking ? 'Stop reading' : 'Read aloud'}
      box={28}
      iconSize={13}
      color={speaking ? colors.accent : colors.iconMuted}
      animationSpec={speaking && !reduce ? { variableAnimationSpec: { iterative: true }, repeating: true } : undefined}
      onPress={() => toggleSpeak(item.id, item.text)}
    />
  );
}

function ReadingBar() {
  const { colors } = useTheme();
  return (
    <Animated.View
      entering={FadeIn.duration(motion.readingBar).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(motion.readingBar).reduceMotion(ReduceMotion.System)}
      pointerEvents="none"
      style={[styles.readingBar, { backgroundColor: colors.accent }]}
    />
  );
}

function AssistantMessage({
  item,
  sessionWorking,
  hideThinking,
  sessionModel,
}: {
  item: AssistantItem;
  sessionWorking: boolean;
  hideThinking: boolean;
  sessionModel?: string;
}) {
  const { colors } = useTheme();
  const speaking = useSpeakingId() === item.id;
  const streaming = !!item.streaming && sessionWorking;
  const aborted = item.error === 'aborted';
  const showMeta = !streaming && item.text.trim().length > 0;
  return (
    <Animated.View
      entering={isFresh(item.ts) ? FadeIn.duration(motion.fresh).reduceMotion(ReduceMotion.System) : undefined}
      style={styles.assistant}
    >
      {speaking ? <ReadingBar /> : null}
      {item.thinking && !hideThinking ? <ThinkingDisclosure text={item.thinking} live={streaming && !item.text} /> : null}
      {item.text ? (
        <LongPressCopy copyText={() => itemCopyText(item)} delay={400}>
          <Markdown text={item.text} streaming={streaming} />
        </LongPressCopy>
      ) : null}
      {item.error && !aborted ? <Notice tone="danger" message={item.error} announce={isFresh(item.ts)} style={styles.error} /> : null}
      {aborted ? (
        <View style={styles.stopped}>
          <Icon name="stop.circle" size={13} weight="semibold" color={colors.textTertiary} />
          <Text variant="label" tone="tertiary">
            Stopped
          </Text>
        </View>
      ) : null}
      {showMeta ? (
        <View style={styles.meta}>
          <SpeakButton item={item} />
          <CopyButton text={item.text} label="Copy reply" />
          <Text variant="label" weight="medium" tone="secondary" numeric>
            {clockTime(item.ts)}
          </Text>
          {item.model && sessionModel && item.model !== sessionModel ? (
            <Text variant="label" tone="tertiary" numberOfLines={1} style={styles.flexShrink}>
              {item.model}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Animated.View>
  );
}

function ToolRow({ item, sessionWorking }: { item: ToolItem; sessionWorking: boolean }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const { tool, detail } = splitToolSummary(item.summary, item.name);
  const running = item.status === 'running' && sessionWorking;
  const failed = item.status === 'error';
  const args = argsBeyondSummary(item.args, item.summary);
  const label = detail ? `${tool} ${detail}` : tool;
  const output = item.output ?? '';
  const firstLine = failed && output ? output.split('\n', 1)[0] : '';
  const rest = failed && output ? output.slice(firstLine.length).replace(/^\n/, '') : output;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${label}, ${failed ? 'failed' : running ? 'running' : 'done'}`}
        accessibilityHint="Shows the details. Long-press to copy the output."
        hitSlop={4}
        onPress={() => {
          void Haptics.selectionAsync();
          setOpen((v) => !v);
        }}
        onLongPress={() => copyWithFeedback(output || itemCopyText(item))}
        style={({ pressed }) => [styles.workRow, pressed && { backgroundColor: colors.subtle }]}
      >
        <View style={styles.iconSlot}>
          <Icon name={toolSymbol(item.name || tool)} size={14} color={colors.iconMuted} />
        </View>
        {running ? (
          <ShimmerText>{label}</ShimmerText>
        ) : (
          <Text variant="footnote" tone="secondary" numberOfLines={1} style={styles.flex}>
            <RNText style={{ fontFamily: fonts.medium }}>{tool}</RNText>
            {detail ? ` ${detail}` : ''}
          </Text>
        )}
        <View style={styles.statusSlot}>
          {failed ? <Icon name="xmark" size={11} weight="semibold" color={colors.danger} style={{ opacity: 0.4 }} /> : null}
        </View>
        <Chevron open={open} from="down" />
      </Pressable>
      {open ? (
        <Animated.View
          entering={FadeIn.duration(motion.detailIn).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(motion.detailOut).reduceMotion(ReduceMotion.System)}
          style={styles.toolBody}
        >
          {args ? (
            <Text mono tone="secondary" selectable>
              {args}
            </Text>
          ) : null}
          {firstLine ? (
            <Text mono tone="danger" selectable>
              {firstLine}
            </Text>
          ) : null}
          {rest ? (
            <ScrollView style={styles.output} nestedScrollEnabled showsVerticalScrollIndicator>
              <Text mono selectable>
                {rest}
              </Text>
            </ScrollView>
          ) : !firstLine ? (
            <Text variant="caption" tone="tertiary">
              {running ? 'Running…' : 'No output.'}
            </Text>
          ) : null}
          {item.outputTruncated ? (
            <Text variant="caption" tone="tertiary">
              Output truncated
            </Text>
          ) : null}
        </Animated.View>
      ) : null}
    </View>
  );
}

function NoteRow({ item }: { item: NoteItem }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const title = (item.label ?? item.text).split('\n', 1)[0];
  const more = !!item.label || item.text.length > title.length;
  return (
    <View style={styles.note}>
      <Pressable
        accessibilityRole={more ? 'button' : 'text'}
        accessibilityState={more ? { expanded: open } : undefined}
        accessibilityLabel={title}
        disabled={!more}
        onPress={() => setOpen((v) => !v)}
        onLongPress={() => copyWithFeedback(item.text)}
        style={styles.noteLine}
      >
        <View style={[styles.noteRule, { backgroundColor: colors.border }]} />
        <Text variant="caption" weight="medium" tone="tertiary" numberOfLines={1} style={styles.noteTitle}>
          {title}
        </Text>
        <View style={[styles.noteRule, { backgroundColor: colors.border }]} />
      </Pressable>
      {open ? (
        <Animated.View entering={FadeIn.duration(motion.detailIn).reduceMotion(ReduceMotion.System)}>
          <Text variant="label" tone="secondary" selectable style={styles.noteBody}>
            {item.text}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

/** "Worked for 2m 10s" — a finished turn's work, folded. */
export function FoldRow({ label, expanded, hidden, onToggle }: { label: string; expanded: boolean; hidden: number; onToggle: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={label}
      accessibilityHint={expanded ? 'Hides the steps' : `Shows ${hidden} step${hidden === 1 ? '' : 's'}`}
      onPress={() => {
        void Haptics.selectionAsync();
        onToggle();
      }}
      style={({ pressed }) => [styles.fold, { borderBottomColor: colors.separator }, pressed && { opacity: 0.6 }]}
    >
      <Text variant="footnote" weight="medium" tone="secondary" numeric numberOfLines={1}>
        {label}
      </Text>
      <Chevron open={expanded} from="down" />
    </Pressable>
  );
}

/** Tail row while phi works and nothing else shows progress. */
export function WorkingTail({ label, active }: { label: string; active: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={styles.workRow} accessibilityLiveRegion="polite">
      <View style={styles.iconSlot}>
        <Icon name="brain" size={14} color={colors.iconMuted} />
      </View>
      <ShimmerText active={active}>{label}</ShimmerText>
    </View>
  );
}

export const TranscriptRow = memo(function TranscriptRow({
  item,
  sessionWorking,
  hideThinking,
  sessionModel,
}: {
  item: TranscriptItem;
  sessionWorking: boolean;
  hideThinking: boolean;
  sessionModel?: string;
}) {
  switch (item.kind) {
    case 'user': {
      // Subagent transcripts: the task comes first, and the parent agent's messages are notes.
      if (item.id === TASK_ITEM_ID) return <TaskHeader item={item} />;
      const fromParent = parentMessageText(item.text);
      if (fromParent !== null) return <ParentMessage item={item} text={fromParent} />;
      return <UserMessage item={item} />;
    }
    case 'assistant':
      return <AssistantMessage item={item} sessionWorking={sessionWorking} hideThinking={hideThinking} sessionModel={sessionModel} />;
    case 'tool':
      // A `subagent` launch is a card of its subagents, not a work-log row.
      if (subagentLaunch(item)) return <SubagentCard item={item} sessionWorking={sessionWorking} />;
      // An overseer's calls on its threads are cards that open the thread.
      if (item.name === 'overseer') return <OverseerCallCard item={item} sessionWorking={sessionWorking} />;
      return <ToolRow item={item} sessionWorking={sessionWorking} />;
    case 'note': {
      // Overseers: thread updates that woke the overseer, and its threads' reports.
      const events = overseerEvents(item);
      if (events && events.length > 0) return <OverseerEventBlock item={item} events={events} />;
      const report = threadReport(item);
      if (report) return <ThreadReportCard item={item} report={report} />;
      return <NoteRow item={item} />;
    }
  }
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  chevron: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  userRow: { alignItems: 'flex-end' },
  userBubble: {
    maxWidth: layout.bubbleMaxWidth,
    borderRadius: radii.bubble,
    borderCurve: 'continuous',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: space.sm,
  },
  imagesNote: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  commandPill: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    borderRadius: radii.sm,
    borderCurve: 'continuous',
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  // Menlo has no semibold face; weight 600 picks Menlo-Bold.
  commandPillText: { fontFamily: fonts.mono, fontWeight: '600', fontSize: 14, lineHeight: 19 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
  userMeta: { justifyContent: 'flex-end', paddingRight: 2, opacity: 0.6 },
  metaButton: { minWidth: 28, height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  assistant: { paddingHorizontal: space.xs },
  readingBar: { position: 'absolute', left: -8, top: 2, bottom: 2, width: 2, borderRadius: 1, opacity: 0.6 },
  error: { marginTop: space.sm },
  stopped: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.xs },
  workRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: layout.workRowMin,
    paddingHorizontal: 2,
    borderRadius: radii.xs,
  },
  iconSlot: { width: layout.workIconSlot, height: layout.workIconSlot, alignItems: 'center', justifyContent: 'center' },
  statusSlot: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  thinkingBody: { marginLeft: 28, paddingVertical: space.xs },
  toolBody: { paddingTop: 2, paddingBottom: space.xs, paddingLeft: 32, gap: space.xs },
  output: { maxHeight: layout.toolOutputMax },
  fold: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 42,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  note: { marginVertical: space.sm },
  task: {
    borderRadius: radii.md,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    gap: 6,
  },
  taskHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  parentMsg: { borderLeftWidth: 2, paddingLeft: space.md, paddingVertical: 2, gap: 4, marginVertical: space.xs },
  noteLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  noteRule: { flex: 1, height: StyleSheet.hairlineWidth },
  noteTitle: { maxWidth: '70%' },
  noteBody: { marginTop: space.sm },
});
