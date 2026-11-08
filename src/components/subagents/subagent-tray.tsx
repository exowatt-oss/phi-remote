/**
 * The pinned subagent tray: a glass card just above a parent thread's composer while its
 * subagents run, so they never scroll away with the transcript. A summary line ("3 subagents ·
 * 2 running · 1 done") that collapses the card, the running runs (and failed ones not yet
 * opened) as dense rows that open their thread, and "+N more" for the full list.
 *
 * Its height is one shared value, animated on the UI thread: the card grows up out of the
 * composer and sinks back into it, and the thread adds the same value to the list's bottom inset,
 * so the last message moves with the card instead of hiding behind it. No opacity animation:
 * Liquid Glass does not draw under a fading ancestor.
 */

import * as Haptics from 'expo-haptics';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import type { TrayView } from '@/lib/subagent-tray';
import { glassShadows, layout, motion, radii, space, useReduceMotion, useTheme } from '@/theme';
import { Icon, Surface, Text } from '@/ui';

import { useTicker } from './scope';
import { SubagentRowView, TRAY_PAD } from './subagent-row';

/** Space between the card and the composer. */
const GAP = space.sm;
const HEADER = layout.floatingHeight;
const timing = { duration: motion.composer, easing: Easing.out(Easing.cubic) };
const rowEnter = FadeIn.duration(motion.detailIn).reduceMotion(ReduceMotion.System);
const rowExit = FadeOut.duration(motion.detailOut).reduceMotion(ReduceMotion.System);
const rowLayout = LinearTransition.duration(motion.composer).easing(Easing.out(Easing.cubic)).reduceMotion(ReduceMotion.System);

/** Moves the tray's height to `target`, then calls `done` once there (not when interrupted). */
function moveHeight(height: SharedValue<number>, target: number, animated: boolean, done?: () => void) {
  if (!animated) {
    height.value = target;
    done?.();
    return;
  }
  height.value = withTiming(target, timing, (finished) => {
    if (finished && done) runOnJS(done)();
  });
}

function HeaderGlyph({ status }: { status: TrayView['status'] }) {
  const { colors } = useTheme();
  if (status === 'done') return <Icon name="checkmark.circle" size={14} weight="semibold" color={colors.success} />;
  if (status === 'failed') return <Icon name="xmark.circle" size={14} weight="semibold" color={colors.danger} />;
  return <Icon name="person.2" size={14} color={colors.accent} />;
}

export function SubagentTray({
  view,
  height,
  collapsed,
  hidden,
  active,
  onToggle,
  onOpen,
  onMore,
}: {
  view: TrayView | null;
  /**
   * The tray's height including the gap above the composer. The thread screen owns it and adds it
   * to its list's end inset; the tray animates it.
   */
  height: SharedValue<number>;
  collapsed: boolean;
  /** Covered by the slash-command menu: kept in place, drawn invisible. */
  hidden: boolean;
  /** The thread is on screen and the app is active (timers tick, shimmers run). */
  active: boolean;
  onToggle: () => void;
  onOpen: (sessionId: string) => void;
  onMore: () => void;
}) {
  const { colors, dark } = useTheme();
  const reduce = useReduceMotion();
  // The last thing shown stays while the card sinks away, so it leaves instead of vanishing.
  const [shown, setShown] = useState(view);
  if (view && view !== shown) setShown(view);
  const [contentHeight, setContentHeight] = useState(0);
  // Null while the new content is still being measured: hold the current height until then.
  const target = view ? (contentHeight > 0 ? contentHeight + GAP : null) : 0;
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  });
  const clear = useCallback(() => {
    if (viewRef.current) return;
    setShown(null);
    setContentHeight(0);
  }, []);
  useEffect(() => {
    if (target !== null) moveHeight(height, target, !reduce, target === 0 ? clear : undefined);
  }, [target, reduce, height, clear]);

  // VoiceOver hears the finish moment once.
  const phase = view?.phase;
  const label = view?.label;
  useEffect(() => {
    if (phase === 'finished' && label) AccessibilityInfo.announceForAccessibility(`Subagents: ${label}`);
  }, [phase, label]);

  const slotStyle = useAnimatedStyle(() => ({ height: height.value }));
  const cardStyle = useAnimatedStyle(() => ({ height: Math.max(0, height.value - GAP) }));
  const rot = useSharedValue(collapsed ? 0 : 1);
  useEffect(() => {
    rot.value = reduce ? (collapsed ? 0 : 1) : withTiming(collapsed ? 0 : 1, { duration: motion.disclosure });
  }, [collapsed, reduce, rot]);
  const chevronStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.value * 180}deg` }] }));

  const rows = shown && !collapsed ? shown.rows : [];
  // Ticks while collapsed too, so a row never opens on a stale time.
  const now = useTicker(active && !!shown && shown.rows.some((r) => r.status === 'running' && !!r.startedAt));
  const onLayout = (e: LayoutChangeEvent) => {
    const h = Math.ceil(e.nativeEvent.layout.height);
    if (h > 0 && h !== contentHeight) setContentHeight(h);
  };

  return (
    <Animated.View style={[styles.slot, slotStyle]} pointerEvents={hidden ? 'none' : 'box-none'}>
      {shown ? (
        <Animated.View
          style={[styles.cardBox, { boxShadow: glassShadows.pill(dark) }, hidden && styles.hidden, cardStyle]}
          accessibilityElementsHidden={hidden}
          importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
        >
          <View style={styles.clip}>
            {/* The glass is a backdrop under the content, not its parent: the content keeps its
                own height (measured here) while the card's height animates over it. */}
            {/* Keyed by scheme: the glass keeps its first appearance when the system one changes. */}
            <Surface key={dark ? 'dark' : 'light'} radius={radii.card} shadow="none" style={StyleSheet.absoluteFill} />
            <View onLayout={onLayout} style={styles.content}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Subagents, ${shown.label}`}
                accessibilityHint={collapsed ? 'Shows the running subagents' : 'Hides the list'}
                accessibilityState={{ expanded: !collapsed }}
                onPress={() => {
                  void Haptics.selectionAsync();
                  onToggle();
                }}
                style={({ pressed }) => [styles.header, pressed && { backgroundColor: colors.pressedOverlay }]}
              >
                <View style={styles.glyph}>
                  <HeaderGlyph status={shown.status} />
                </View>
                <Text variant="label" weight="medium" numeric numberOfLines={1} style={styles.summary}>
                  {shown.segments.map((s, i) => (
                    <Fragment key={i}>
                      {i ? ' · ' : ''}
                      {s.tone === 'danger' ? (
                        <Text variant="label" weight="medium" numeric tone="danger">
                          {s.text}
                        </Text>
                      ) : (
                        s.text
                      )}
                    </Fragment>
                  ))}
                </Text>
                <Animated.View style={chevronStyle}>
                  <Icon name="chevron.up" size={11} weight="semibold" color={colors.iconMuted} />
                </Animated.View>
              </Pressable>
              {rows.map((row) => (
                <Animated.View key={row.id} entering={rowEnter} exiting={rowExit} layout={rowLayout}>
                  <SubagentRowView row={row} now={now} active={active} first={false} onOpen={onOpen} variant="tray" />
                </Animated.View>
              ))}
              {!collapsed && shown.more > 0 ? (
                <Animated.View entering={rowEnter} exiting={rowExit} layout={rowLayout}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${shown.more} more subagents`}
                    accessibilityHint="Lists all of this thread's subagents"
                    onPress={() => {
                      void Haptics.selectionAsync();
                      onMore();
                    }}
                    style={({ pressed }) => [styles.more, pressed && { backgroundColor: colors.pressedOverlay }]}
                  >
                    <View style={[styles.divider, { backgroundColor: colors.separator }]} />
                    <Text variant="label" weight="medium" tone="secondary" numberOfLines={1} style={styles.summary}>
                      {`+${shown.more} more`}
                    </Text>
                    <Icon name="chevron.right" size={11} weight="semibold" color={colors.chevron} />
                  </Pressable>
                </Animated.View>
              ) : null}
            </View>
          </View>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // The card hangs from the top of its slot; the slot's bottom edge is the composer's top.
  slot: { justifyContent: 'flex-start' },
  cardBox: { borderRadius: radii.card, borderCurve: 'continuous' },
  clip: { flex: 1, borderRadius: radii.card, borderCurve: 'continuous', overflow: 'hidden' },
  // Absolute, so it keeps its own height whatever the card's height is at the moment.
  content: { position: 'absolute', top: 0, left: 0, right: 0 },
  hidden: { opacity: 0 },
  header: { minHeight: HEADER, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: TRAY_PAD },
  glyph: { width: layout.workIconSlot - 6, alignItems: 'flex-start', justifyContent: 'center' },
  summary: { flex: 1, minWidth: 0 },
  more: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: TRAY_PAD + layout.workIconSlot,
    paddingRight: TRAY_PAD,
  },
  divider: { position: 'absolute', top: 0, left: TRAY_PAD + layout.workIconSlot, right: 0, height: StyleSheet.hairlineWidth },
});
