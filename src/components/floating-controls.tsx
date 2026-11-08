/**
 * Floating row above the composer (T3 floating-working-control): a "Working 1m 04s · bash"
 * capsule while phi works, and a scroll-to-bottom circle when the reader has scrolled up.
 * Running subagents are not here: they have the pinned tray under this row.
 * Liquid Glass merges the two on iOS 26; elsewhere they are opaque capsules.
 */

import { GlassContainer } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

import { formatDuration } from '@/lib/format';
import { layout, motion, radii, space, useGlass, useTheme } from '@/theme';
import { Icon, Surface, Text } from '@/ui';

function WorkingTimer({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Text variant="label" weight="medium" numeric maxFontSizeMultiplier={1.3}>
      {`Working ${formatDuration(now - since)}`}
    </Text>
  );
}

export function FloatingControls({
  working,
  since,
  tool,
  showArrow,
  onScrollToEnd,
}: {
  working: boolean;
  since: number | null;
  tool?: string;
  showArrow: boolean;
  onScrollToEnd: () => void;
}) {
  const { colors } = useTheme();
  const glass = useGlass();
  if (!working && !showArrow) return null;
  // Liquid Glass does not render under an ancestor whose opacity animates (it comes up
  // blank or half-drawn), so on glass the capsules appear without the fade, as T3 does.
  const enter = glass ? undefined : FadeIn.duration(motion.floatingIn).reduceMotion(ReduceMotion.System);
  const exit = glass ? undefined : FadeOut.duration(motion.floatingOut).reduceMotion(ReduceMotion.System);
  const content = (
    <View style={styles.row} pointerEvents="box-none">
      {working ? (
        <Animated.View entering={enter} exiting={exit}>
          <Surface radius={radii.pill} interactive shadow="pill" style={styles.capsule}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Working${tool ? `, ${tool}` : ''}`}
              accessibilityHint="Scrolls to the latest"
              accessibilityLiveRegion="polite"
              onPress={onScrollToEnd}
              style={styles.segment}
            >
              {since ? (
                <WorkingTimer since={since} />
              ) : (
                <Text variant="label" weight="medium">
                  Working
                </Text>
              )}
              {tool ? (
                <>
                  <View style={[styles.divider, { backgroundColor: colors.border }]} />
                  <Text variant="label" weight="medium" tone="secondary" numberOfLines={1} style={styles.tool}>
                    {tool}
                  </Text>
                </>
              ) : null}
            </Pressable>
          </Surface>
        </Animated.View>
      ) : null}
      {showArrow ? (
        <Animated.View entering={enter} exiting={exit}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Scroll to latest"
            onPress={() => {
              void Haptics.selectionAsync();
              onScrollToEnd();
            }}
          >
            <Surface radius={layout.floatingHeight / 2} interactive shadow="pill" style={styles.arrow}>
              <Icon name="chevron.down" size={20} color={colors.icon} />
            </Surface>
          </Pressable>
        </Animated.View>
      ) : null}
    </View>
  );
  return glass ? (
    <GlassContainer spacing={12} style={styles.container} pointerEvents="box-none">
      {content}
    </GlassContainer>
  ) : (
    <View style={styles.container} pointerEvents="box-none">
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.lg },
  capsule: {
    height: layout.floatingHeight,
    paddingHorizontal: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  segment: { flexDirection: 'row', alignItems: 'center', gap: space.sm, alignSelf: 'stretch' },
  divider: { width: 1, height: 16 },
  tool: { maxWidth: 160 },
  arrow: {
    width: layout.floatingHeight,
    height: layout.floatingHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
