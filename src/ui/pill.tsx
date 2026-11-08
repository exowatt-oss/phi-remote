import { Pressable, StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';

import { radii, useTheme } from '@/theme';

import { Icon, type IconName } from './icon';
import { Text } from './text';

/**
 * T3 ComposerInlineControl: an unboxed inline control (icon + label + chevron) for the
 * model chip, host control and folder chip. Truncates before anything else in its row.
 */
export function Pill({
  label,
  suffix,
  icon,
  onPress,
  emphasized,
  chevron = 'down',
  disabled,
  accessibilityLabel,
  accessibilityHint,
  maxWidth = 190,
  style,
}: {
  label: string;
  /** Kept whole after the label, which truncates first ("· high" after a long model name). */
  suffix?: string;
  icon?: IconName;
  onPress?: () => void;
  emphasized?: boolean;
  chevron?: 'down' | 'right' | false;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  maxWidth?: DimensionValue;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const tint = emphasized ? colors.icon : colors.iconMuted;
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel ?? (suffix ? `${label} ${suffix}` : label)}
      accessibilityHint={accessibilityHint}
      accessibilityState={onPress ? { disabled: !!disabled } : undefined}
      disabled={disabled || !onPress}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        { maxWidth, opacity: disabled ? 0.45 : 1 },
        pressed && { backgroundColor: colors.subtle },
        style,
      ]}
    >
      <View style={styles.row}>
        {icon ? <Icon name={icon} size={14} color={tint} /> : null}
        <View style={styles.text}>
          <Text
            variant="label"
            weight="medium"
            tone={emphasized ? 'primary' : 'secondary'}
            numberOfLines={1}
            style={styles.label}
          >
            {label}
          </Text>
          {suffix ? (
            <Text variant="label" weight="medium" tone={emphasized ? 'primary' : 'secondary'} numberOfLines={1}>
              {` ${suffix}`}
            </Text>
          ) : null}
        </View>
        {chevron ? <Icon name={chevron === 'right' ? 'chevron.right' : 'chevron.down'} size={10} color={tint} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { height: 32, paddingHorizontal: 10, borderRadius: radii.md, borderCurve: 'continuous', justifyContent: 'center', flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  text: { flexDirection: 'row', flexShrink: 1, minWidth: 0 },
  label: { flexShrink: 1 },
});
