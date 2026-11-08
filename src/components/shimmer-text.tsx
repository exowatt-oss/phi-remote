/**
 * T3's working shimmer: a 72 pt highlight sweeps across the label every ~2.8 s. The base
 * text stays readable; the sweep is a masked copy in the primary text colour. Off with
 * Reduce Motion, while the app is inactive, or when `active` is false.
 */

import MaskedViewImpl from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState, type ComponentType, type ReactElement } from 'react';
import { StyleSheet, View, type StyleProp, type TextStyle, type ViewProps } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { useAppActive } from '@/hooks/use-app-active';
import { masks, motion, useReduceMotion, useTheme, type TypeVariant } from '@/theme';
import { Text } from '@/ui';

// The package's class typing (NativeMethods mixin) does not satisfy React 19's JSX types.
const MaskedView = MaskedViewImpl as unknown as ComponentType<ViewProps & { maskElement: ReactElement }>;

const WINDOW = 72;

export function ShimmerText({
  children,
  active = true,
  variant = 'footnote',
  weight = 'regular',
  style,
  accessibilityLabel,
}: {
  children: string;
  active?: boolean;
  variant?: TypeVariant;
  weight?: 'regular' | 'medium' | 'bold';
  style?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const reduce = useReduceMotion();
  const appActive = useAppActive();
  const [textWidth, setTextWidth] = useState(0);
  const [boxWidth, setBoxWidth] = useState(0);
  const x = useSharedValue(-WINDOW);
  const running = active && appActive && !reduce && textWidth > 0;

  useEffect(() => {
    if (!running) {
      cancelAnimation(x);
      x.value = -WINDOW;
      return;
    }
    x.value = -WINDOW;
    x.value = withRepeat(
      withSequence(
        withTiming(textWidth, { duration: motion.shimmerSweep, easing: Easing.linear }),
        withDelay(motion.shimmerPause, withTiming(-WINDOW, { duration: 0 })),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(x);
  }, [running, textWidth, x]);

  const windowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const counterStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -x.value }] }));

  return (
    <View
      style={styles.root}
      onLayout={(e) => setBoxWidth(e.nativeEvent.layout.width)}
      accessibilityLabel={accessibilityLabel ?? children}
      accessible
    >
      <Text
        variant={variant}
        weight={weight}
        tone="secondary"
        numberOfLines={1}
        style={style}
        onTextLayout={(e) => setTextWidth(Math.min(e.nativeEvent.lines[0]?.width ?? 0, boxWidth || Infinity))}
      >
        {children}
      </Text>
      {running ? (
        <Animated.View pointerEvents="none" style={[styles.window, windowStyle]}>
          <MaskedView
            style={StyleSheet.absoluteFill}
            maskElement={<LinearGradient colors={masks.shimmer.colors} locations={masks.shimmer.stops} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />}
          >
            <Animated.View style={[{ width: boxWidth }, counterStyle]}>
              <Text variant={variant} weight={weight} numberOfLines={1} style={[style, { color: colors.text }]}>
                {children}
              </Text>
            </Animated.View>
          </MaskedView>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flexShrink: 1, flexGrow: 1, overflow: 'hidden' },
  window: { position: 'absolute', top: 0, bottom: 0, left: 0, width: WINDOW, overflow: 'hidden' },
});
