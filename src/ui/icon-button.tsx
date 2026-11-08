import type { AnimationSpec } from 'expo-symbols';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { layout, useTheme } from '@/theme';

import { Icon, type IconName } from './icon';

export type IconButtonVariant = 'plain' | 'filled' | 'danger' | 'subtle';

/**
 * T3's composer/voice action button: always a 44 pt hit area. `plain` is a bare 20 pt
 * glyph; the others draw a 30 pt circle (accent / danger / surface) with a 16 pt glyph.
 */
export function IconButton({
  icon,
  label,
  hint,
  onPress,
  onLongPress,
  variant = 'plain',
  disabled,
  loading,
  color,
  iconSize,
  box = layout.touch,
  animationSpec,
  style,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  variant?: IconButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  /** Overrides the glyph tint. */
  color?: string;
  iconSize?: number;
  /** Visual box for plain buttons (hit area stays 44). */
  box?: number;
  animationSpec?: AnimationSpec;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const circle = variant !== 'plain';
  const fill =
    variant === 'filled'
      ? disabled
        ? colors.accentSoft
        : colors.accent
      : variant === 'danger'
        ? colors.dangerSoft
        : variant === 'subtle'
          ? colors.surface
          : 'transparent';
  const tint =
    color ??
    (variant === 'filled'
      ? disabled
        ? colors.accent
        : colors.onAccent
      : variant === 'danger'
        ? colors.danger
        : colors.icon);
  const glyph = iconSize ?? (circle ? 16 : 20);
  const slop = Math.max(0, (layout.touch - box) / 2);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      disabled={disabled || loading}
      hitSlop={slop}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.hit,
        { width: box, height: box },
        pressed && { opacity: 0.7 },
        !circle && disabled && { opacity: 0.45 },
        style,
      ]}
    >
      {circle ? (
        <View style={[styles.circle, { backgroundColor: fill }]}>
          {loading ? (
            <ActivityIndicator size="small" color={colors.iconMuted} />
          ) : (
            <Icon name={icon} size={glyph} color={tint} weight="semibold" animationSpec={animationSpec} />
          )}
        </View>
      ) : loading ? (
        <ActivityIndicator size="small" color={colors.iconMuted} />
      ) : (
        <Icon name={icon} size={glyph} color={tint} animationSpec={animationSpec} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hit: { alignItems: 'center', justifyContent: 'center' },
  circle: {
    width: layout.circle,
    height: layout.circle,
    borderRadius: layout.circle / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
