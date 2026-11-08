import { View } from 'react-native';

import { useTheme } from '@/theme';

export type DotState = 'working' | 'live' | 'connecting' | 'offline' | 'error' | 'idle';

/** 8 pt state dot (no pulse; the shimmer carries motion). */
export function StatusDot({ state, size = 8 }: { state: DotState; size?: number }) {
  const { colors } = useTheme();
  const fill =
    state === 'working'
      ? colors.accent
      : state === 'live'
        ? colors.success
        : state === 'error'
          ? colors.danger
          : colors.textTertiary;
  const hollow = state === 'connecting';
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: hollow ? 'transparent' : fill,
        borderWidth: hollow ? 1.5 : 0,
        borderColor: fill,
        opacity: state === 'offline' || state === 'idle' ? 0.6 : 1,
      }}
    />
  );
}
