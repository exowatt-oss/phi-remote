/**
 * T3 VoiceWaveform: 2 pt bars, 5 pt apart, one per recent level sample (newest at the
 * right). Each bar scales from 2/32 to full height with its level.
 */

import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, withTiming, type SharedValue } from 'react-native-reanimated';

import { VOICE_WAVEFORM_SAMPLE_COUNT } from '@/lib/voice-input/metering';
import { motion, radii, useReduceMotion, useTheme } from '@/theme';

const SPACING = 5;
const HEIGHT = 32;

function Bar({ levels, index, count, color, reduce }: { levels: SharedValue<number[]>; index: number; count: number; color: string; reduce: boolean }) {
  const style = useAnimatedStyle(() => {
    const ring = levels.value;
    const level = ring[ring.length - count + index] ?? 0;
    const scale = Math.max(2 / HEIGHT, level);
    const opacity = 0.22 + level * 0.78;
    // Reduce Motion: fixed-height bars; only their opacity follows the voice.
    if (reduce) return { transform: [{ scaleY: 0.25 }], opacity };
    return {
      transform: [{ scaleY: withTiming(scale, { duration: motion.waveformSample }) }],
      opacity: withTiming(opacity, { duration: motion.waveformSample }),
    };
  });
  return <Animated.View style={[styles.bar, { backgroundColor: color }, style]} />;
}

export function Waveform({ levels }: { levels: SharedValue<number[]> }) {
  const { colors } = useTheme();
  const reduce = useReduceMotion();
  const [width, setWidth] = useState(0);
  const count = Math.min(VOICE_WAVEFORM_SAMPLE_COUNT, Math.floor(width / SPACING));
  return (
    <View
      style={styles.wave}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: count }, (_, i) => (
        <Bar key={i} levels={levels} index={i} count={count} color={colors.text} reduce={reduce} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wave: { flex: 1, height: HEIGHT, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: SPACING - 2, overflow: 'hidden' },
  bar: { width: 2, height: HEIGHT, borderRadius: radii.pill },
});
