import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { space } from '@/theme';

import { Button } from './button';
import { Text } from './text';

/** Title row for sheets that hide the native header: centered 18 Bold title, text buttons either side. */
export function SheetHeader({
  title,
  left,
  right,
}: {
  title: string;
  left?: { title: string; onPress: () => void; disabled?: boolean } | ReactNode;
  right?: { title: string; onPress: () => void; disabled?: boolean; busy?: boolean } | ReactNode;
}) {
  const slot = (v: typeof left | typeof right) =>
    v && typeof v === 'object' && 'title' in v && 'onPress' in v ? (
      <Button
        compact
        variant="plain"
        title={v.title}
        onPress={v.onPress}
        disabled={v.disabled}
        busy={'busy' in v ? v.busy : undefined}
      />
    ) : (
      (v as ReactNode)
    );
  return (
    <View style={styles.row}>
      <View style={[styles.side, styles.left]}>{slot(left)}</View>
      <Text variant="headline" weight="bold" align="center" numberOfLines={1} style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      <View style={[styles.side, styles.right]}>{slot(right)}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: space.lg, paddingTop: space.sm },
  side: { width: 88, justifyContent: 'center' },
  left: { alignItems: 'flex-start' },
  right: { alignItems: 'flex-end' },
  title: { flex: 1 },
});
