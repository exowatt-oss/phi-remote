/**
 * The pinned Threads board of an overseer (Overseers, v1 addition): a glass card just above the
 * composer whenever the overseer has threads, built like the pinned subagent tray. Its header
 * counts them ("4 threads · 2 working · 1 error") and folds the card; the threads that still run
 * are dense rows that step into the thread; "See all" opens the full board (exited and closed
 * too) and + asks the overseer for one more thread.
 *
 * Its height is one shared value animated on the UI thread, added by the screen to the list's
 * end inset, so the last message rides up with the card. No opacity animation: Liquid Glass does
 * not draw under a fading ancestor.
 */

import * as Haptics from 'expo-haptics';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
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

import type { BoardThread, CountSegment } from '@/lib/overseer';
import { glassShadows, layout, motion, radii, space, useReduceMotion, useTheme } from '@/theme';
import { Icon, Surface, Text } from '@/ui';

import { BOARD_PAD, BoardRow } from './board-row';

const GAP = space.sm;
const HEADER = layout.floatingHeight;
const timing = { duration: motion.composer, easing: Easing.out(Easing.cubic) };
const rowEnter = FadeIn.duration(motion.detailIn).reduceMotion(ReduceMotion.System);
const rowExit = FadeOut.duration(motion.detailOut).reduceMotion(ReduceMotion.System);
const rowLayout = LinearTransition.duration(motion.composer).easing(Easing.out(Easing.cubic)).reduceMotion(ReduceMotion.System);

/** Moves the board's height to `target`, then calls `done` once there (not when interrupted). */
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

export type ThreadsTrayView = {
  segments: CountSegment[];
  /** Threads that still run, at most the cap. */
  rows: BoardThread[];
  /** Running threads beyond the cap. */
  more: number;
  /** The clock the rows were built at (relative times). */
  now: number;
};

export function ThreadsTray({
  view,
  height,
  collapsed,
  hidden,
  active,
  onToggle,
  onOpen,
  onSeeAll,
  onAdd,
}: {
  view: ThreadsTrayView | null;
  /** The card's height including the gap above the composer (the screen adds it to its list inset). */
  height: SharedValue<number>;
  collapsed: boolean;
  /** Covered by the slash-command menu: kept in place, drawn invisible. */
  hidden: boolean;
  active: boolean;
  onToggle: () => void;
  onOpen: (sessionId: string) => void;
  onSeeAll: () => void;
  onAdd: (() => void) | null;
}) {
  const { colors, dark } = useTheme();
  const reduce = useReduceMotion();
  const [shown, setShown] = useState(view);
  if (view && view !== shown) setShown(view);
  const [contentHeight, setContentHeight] = useState(0);
  const target = view ? (contentHeight > 0 ? contentHeight + GAP : null) : 0;
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  });
  // Once the card has sunk away (and nothing came back meanwhile), let go of its content.
  const clear = useCallback(() => {
    if (viewRef.current) return;
    setShown(null);
    setContentHeight(0);
  }, []);
  useEffect(() => {
    if (target !== null) moveHeight(height, target, !reduce, target === 0 ? clear : undefined);
  }, [target, reduce, height, clear]);

  const slotStyle = useAnimatedStyle(() => ({ height: height.value }));
  const cardStyle = useAnimatedStyle(() => ({ height: Math.max(0, height.value - GAP) }));
  const rot = useSharedValue(collapsed ? 0 : 1);
  useEffect(() => {
    rot.value = reduce ? (collapsed ? 0 : 1) : withTiming(collapsed ? 0 : 1, { duration: motion.disclosure });
  }, [collapsed, reduce, rot]);
  const chevronStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.value * 180}deg` }] }));

  const onLayout = (e: LayoutChangeEvent) => {
    const h = Math.ceil(e.nativeEvent.layout.height);
    if (h > 0 && h !== contentHeight) setContentHeight(h);
  };
  const rows = shown && !collapsed ? shown.rows : [];
  const label = shown ? shown.segments.map((s) => s.text).join(', ') : '';

  return (
    <Animated.View style={[styles.slot, slotStyle]} pointerEvents={hidden ? 'none' : 'box-none'}>
      {shown ? (
        <Animated.View
          style={[styles.cardBox, { boxShadow: glassShadows.pill(dark) }, hidden && styles.hidden, cardStyle]}
          accessibilityElementsHidden={hidden}
          importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
        >
          <View style={styles.clip}>
            {/* Keyed by scheme: the glass keeps its first appearance when the system one changes. */}
            <Surface key={dark ? 'dark' : 'light'} radius={radii.card} shadow="none" style={StyleSheet.absoluteFill} />
            <View onLayout={onLayout} style={styles.content}>
              <View style={styles.header}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Threads, ${label}`}
                  accessibilityHint={collapsed ? 'Shows the threads' : 'Hides the list'}
                  accessibilityState={{ expanded: !collapsed }}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    onToggle();
                  }}
                  style={({ pressed }) => [styles.toggle, pressed && { backgroundColor: colors.pressedOverlay }]}
                >
                  <View style={styles.glyph}>
                    <Icon name="rectangle.stack" size={14} color={colors.accent} />
                  </View>
                  <Text variant="label" weight="medium" numeric numberOfLines={1} style={styles.summary}>
                    {shown.segments.map((s, i) => (
                      <Fragment key={i}>
                        {i ? ' · ' : ''}
                        {s.tone === 'danger' || s.tone === 'warning' ? (
                          <Text variant="label" weight="medium" numeric tone={s.tone}>
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
                {onAdd ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Add thread"
                    accessibilityHint="Asks the overseer to start one more thread"
                    hitSlop={6}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      onAdd();
                    }}
                    style={({ pressed }) => [styles.add, pressed && { backgroundColor: colors.pressedOverlay }]}
                  >
                    <Icon name="plus" size={14} weight="semibold" color={colors.icon} />
                  </Pressable>
                ) : null}
              </View>
              {rows.map((t) => (
                <Animated.View key={t.sessionId} entering={rowEnter} exiting={rowExit} layout={rowLayout}>
                  <BoardRow thread={t} now={shown!.now} active={active} first={false} onOpen={onOpen} variant="tray" />
                </Animated.View>
              ))}
              {!collapsed ? (
                <Animated.View entering={rowEnter} exiting={rowExit} layout={rowLayout}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={shown.more > 0 ? `See all threads, ${shown.more} more` : 'See all threads'}
                    accessibilityHint="The full board, ended threads included"
                    onPress={() => {
                      void Haptics.selectionAsync();
                      onSeeAll();
                    }}
                    style={({ pressed }) => [styles.more, pressed && { backgroundColor: colors.pressedOverlay }]}
                  >
                    <View style={[styles.divider, { backgroundColor: colors.separator }]} />
                    <Text variant="label" weight="medium" tone="secondary" numberOfLines={1} style={styles.summary}>
                      {shown.more > 0 ? `See all · ${shown.more} more` : 'See all'}
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
  slot: { justifyContent: 'flex-start' },
  cardBox: { borderRadius: radii.card, borderCurve: 'continuous' },
  clip: { flex: 1, borderRadius: radii.card, borderCurve: 'continuous', overflow: 'hidden' },
  content: { position: 'absolute', top: 0, left: 0, right: 0 },
  hidden: { opacity: 0 },
  header: { minHeight: HEADER, flexDirection: 'row', alignItems: 'stretch' },
  toggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: BOARD_PAD, paddingRight: space.sm },
  glyph: { width: layout.workIconSlot - 6, alignItems: 'flex-start', justifyContent: 'center' },
  summary: { flex: 1, minWidth: 0 },
  add: { width: HEADER, alignItems: 'center', justifyContent: 'center' },
  more: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: BOARD_PAD + layout.workIconSlot,
    paddingRight: BOARD_PAD,
  },
  divider: { position: 'absolute', top: 0, left: BOARD_PAD + layout.workIconSlot, right: 0, height: StyleSheet.hairlineWidth },
});
