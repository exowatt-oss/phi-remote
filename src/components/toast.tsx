/** A single transient confirmation ("Copied") shown above the content. */

import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { motion, radii, space, useTheme } from '@/theme';
import { Icon, Text, type IconName } from '@/ui';

type ToastOptions = { icon?: IconName; durationMs?: number };
type ToastState = { id: number; message: string | null; error: boolean } & ToastOptions;
const toastStore = createStore<ToastState>()(() => ({ id: 0, message: null, error: false }));

/** `options`: a different icon (default a checkmark) and how long it stays (default 1.5 s, errors 3.5 s). */
export function showToast(message: string, error = false, options: ToastOptions = {}): void {
  toastStore.setState((s) => ({ id: s.id + 1, message, error, icon: options.icon, durationMs: options.durationMs }));
}

/** An error toast, with the error haptic (DESIGN.md §2.10). */
export function showError(message: string): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  showToast(message, true);
}

export function ToastHost() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { id, message, error, icon, durationMs } = useStore(toastStore);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => {
      if (toastStore.getState().id === id) toastStore.setState({ message: null });
    }, durationMs ?? (error ? 3500 : 1500));
    return () => clearTimeout(t);
  }, [id, message, error, durationMs]);
  if (!message) return null;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', paddingTop: insets.top + 52 }]}>
      <Animated.View
        key={id}
        entering={FadeIn.duration(motion.enter).reduceMotion(ReduceMotion.System)}
        exiting={FadeOut.duration(motion.exit).reduceMotion(ReduceMotion.System)}
        accessibilityLiveRegion="polite"
        style={[styles.toast, { backgroundColor: colors.text, shadowColor: colors.shadow }]}
      >
        <Icon name={icon ?? (error ? 'exclamationmark.triangle' : 'checkmark')} size={12} color={colors.bg} />
        <Text variant="label" weight="medium" style={[styles.message, { color: colors.bg }]}>
          {message}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  message: { flexShrink: 1 },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    maxWidth: '88%',
    borderRadius: radii.pill,
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
});
