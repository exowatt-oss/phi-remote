/**
 * Slash-command popover above the composer (after T3 Code's ComposerCommandPopover, MIT): glass
 * on iOS 26 with the opaque fallback, up to 5½ rows, scrolls inside, never takes the keyboard.
 * Each row: `/label` (Menlo, semibold) · argument hint · source tag, then a one-line description.
 */

import { memo, useEffect, useState } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

import { commandLabel, menuListHeight, SOURCE_TAG } from '@/lib/commands';
import type { CommandInfo } from '@/lib/protocol';
import { fonts, motion, radii, space, useTheme } from '@/theme';
import { Surface, Text } from '@/ui';

/** Row height at the default text size (rows grow with Dynamic Type; the first one is measured). */
const ROW_HEIGHT = 54;
const LIST_PADDING = space.xs;

export function CommandMenu({
  items,
  maxHeight,
  onSelect,
}: {
  items: readonly CommandInfo[];
  /** Room above the composer (window space minus the navigation bar). */
  maxHeight: number;
  onSelect: (command: CommandInfo) => void;
}) {
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility('Commands available');
  }, []);
  const [rowHeight, setRowHeight] = useState(ROW_HEIGHT);
  const onFirstRowLayout = (e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    if (h > 0 && h !== rowHeight) setRowHeight(Math.max(ROW_HEIGHT, h));
  };
  return (
    <Animated.View
      entering={FadeIn.duration(motion.adjust).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(motion.adjust).reduceMotion(ReduceMotion.System)}
      style={styles.anchor}
      pointerEvents="box-none"
    >
      <Surface radius={radii.bubble} shadow="floating" accessibilityLabel="Commands">
        <ScrollView
          style={{ maxHeight: menuListHeight(maxHeight, items.length, rowHeight, LIST_PADDING) }}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="none"
          showsVerticalScrollIndicator
        >
          {items.map((item, i) => (
            <CommandRow key={item.name} item={item} onPress={onSelect} onLayout={i === 0 ? onFirstRowLayout : undefined} />
          ))}
        </ScrollView>
      </Surface>
    </Animated.View>
  );
}

const CommandRow = memo(function CommandRow({
  item,
  onPress,
  onLayout,
}: {
  item: CommandInfo;
  onPress: (c: CommandInfo) => void;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  const { colors } = useTheme();
  const label = commandLabel(item);
  const tag = SOURCE_TAG[item.source];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`/${label}, ${tag}`}
      accessibilityHint={item.description ?? (item.argumentHint ? `Takes ${item.argumentHint}` : 'Inserts the command')}
      onPress={() => onPress(item)}
      onLayout={onLayout}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.pressedOverlay }]}
    >
      <View style={styles.head}>
        <Text variant="body" numberOfLines={1} style={styles.label} maxFontSizeMultiplier={1.4}>
          <Text variant="body" tone="tertiary" style={styles.slash} maxFontSizeMultiplier={1.4}>
            /
          </Text>
          {label}
        </Text>
        {item.argumentHint ? (
          <Text variant="label" tone="tertiary" numberOfLines={1} style={styles.hint}>
            {item.argumentHint}
          </Text>
        ) : null}
        <View style={styles.spacer} />
        <Text variant="micro" weight="medium" tone="tertiary" style={styles.tag}>
          {tag}
        </Text>
      </View>
      {item.description ? (
        <Text variant="label" tone="secondary" numberOfLines={1} maxFontSizeMultiplier={1.4}>
          {item.description}
        </Text>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  anchor: { position: 'absolute', left: 0, right: 0, bottom: '100%', paddingBottom: space.sm },
  list: { paddingVertical: LIST_PADDING },
  row: {
    minHeight: ROW_HEIGHT,
    paddingHorizontal: space.lg,
    paddingVertical: 7,
    justifyContent: 'center',
    gap: 1,
    marginHorizontal: space.xs,
    borderRadius: radii.md,
    borderCurve: 'continuous',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  // Menlo has no semibold face; weight 600 picks Menlo-Bold.
  label: { fontFamily: fonts.mono, fontWeight: '600', fontSize: 15, lineHeight: 21, flexShrink: 1 },
  slash: { fontFamily: fonts.mono, fontWeight: '400', fontSize: 15, lineHeight: 21 },
  hint: { flexShrink: 1000 },
  spacer: { flex: 1, minWidth: 0 },
  tag: { letterSpacing: 0.2 },
});
