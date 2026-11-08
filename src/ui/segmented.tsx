import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, View } from 'react-native';

import { radii, useTheme } from '@/theme';

import { Text } from './text';

/** A small iOS-style segmented control (two to four options). */
export function Segmented<K extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  options: readonly { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
  accessibilityLabel?: string;
}) {
  const { colors, dark } = useTheme();
  return (
    <View accessibilityRole="tablist" accessibilityLabel={accessibilityLabel} style={[styles.track, { backgroundColor: colors.surface }]}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            accessibilityRole="tab"
            accessibilityLabel={o.label}
            accessibilityState={{ selected: on }}
            onPress={() => {
              if (on) return;
              void Haptics.selectionAsync();
              onChange(o.key);
            }}
            style={[
              styles.segment,
              on && { backgroundColor: dark ? colors.surfacePressed : colors.bgElevated, boxShadow: dark ? undefined : '0 1px 3px rgba(0,0,0,0.12)' },
            ]}
          >
            <Text variant="label" weight={on ? 'bold' : 'medium'} tone={on ? 'primary' : 'secondary'} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', padding: 2, borderRadius: radii.sm + 1, borderCurve: 'continuous' },
  segment: { minWidth: 84, height: 28, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderRadius: radii.sm - 1, borderCurve: 'continuous' },
});
