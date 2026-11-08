import { useEffect } from 'react';
import { AccessibilityInfo, Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { radii, space, useTheme } from '@/theme';

import { Icon, type IconName } from './icon';
import { Text } from './text';

/** T3 Notice: icon + message (+ action, + dismiss). Announced to VoiceOver when shown. */
export function Notice({
  message,
  tone = 'neutral',
  icon,
  action,
  onDismiss,
  card,
  announce = true,
  style,
}: {
  message: string;
  tone?: 'neutral' | 'danger';
  icon?: IconName;
  action?: { title: string; onPress: () => void };
  onDismiss?: () => void;
  /** Draw as a `surface` card (terminal host states). */
  card?: boolean;
  /** Announce to VoiceOver when shown (off for notices inside old transcript content). */
  announce?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  useEffect(() => {
    if (announce && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(message);
  }, [message, announce]);
  const danger = tone === 'danger';
  return (
    <View style={[styles.row, card && [styles.card, { backgroundColor: colors.surface }], style]}>
      <Icon
        name={icon ?? (danger ? 'exclamationmark.triangle' : 'info.circle')}
        size={16}
        color={danger ? colors.danger : colors.iconMuted}
      />
      <Text variant="footnote" weight="medium" tone={danger ? 'danger' : 'secondary'} style={styles.message} selectable>
        {message}
      </Text>
      {action ? (
        <Pressable accessibilityRole="button" accessibilityLabel={action.title} hitSlop={10} onPress={action.onPress}>
          <Text variant="footnote" weight="bold" tone="accent">
            {action.title}
          </Text>
        </Pressable>
      ) : null}
      {onDismiss ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" hitSlop={10} onPress={onDismiss}>
          <Icon name="xmark" size={12} color={colors.iconMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 2 },
  card: { borderRadius: radii.notice, borderCurve: 'continuous', paddingVertical: space.md, paddingHorizontal: 14 },
  message: { flex: 1 },
});
