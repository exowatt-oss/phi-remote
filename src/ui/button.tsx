import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { radii, space, useTheme } from '@/theme';

import { Icon, type IconName } from './icon';
import { Text } from './text';

export type ButtonVariant = 'primary' | 'secondary' | 'plain' | 'destructive';

/** T3 Button: 48 pt, pill radius, 16 Medium label. `plain` is a text button in the accent. */
export function Button({
  title,
  onPress,
  variant = 'primary',
  icon,
  busy,
  disabled,
  compact,
  style,
}: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  busy?: boolean;
  disabled?: boolean;
  /** Header/text-button sizing (no minimum height or horizontal padding). */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const inactive = disabled || busy;
  const bg =
    variant === 'primary'
      ? inactive
        ? colors.accentSoft
        : colors.accent
      : variant === 'secondary'
        ? colors.surface
        : 'transparent';
  const fg =
    variant === 'primary'
      ? inactive
        ? colors.accent
        : colors.onAccent
      : variant === 'destructive'
        ? colors.danger
        : variant === 'plain'
          ? colors.accent
          : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      disabled={inactive}
      hitSlop={compact ? 10 : undefined}
      onPress={onPress}
      style={({ pressed }) => [
        compact ? styles.compact : styles.base,
        { backgroundColor: bg },
        pressed && { opacity: 0.7 },
        compact && inactive && { opacity: 0.45 },
        style,
      ]}
    >
      <View style={styles.row}>
        {busy ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={16} color={fg} weight="semibold" /> : null}
        <Text variant="body" weight="medium" style={{ color: fg }} numberOfLines={1}>
          {title}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: 48, borderRadius: radii.pill, paddingHorizontal: space.xxl, justifyContent: 'center' },
  compact: { justifyContent: 'center', paddingVertical: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
});
