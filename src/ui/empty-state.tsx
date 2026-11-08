import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { space } from '@/theme';

import { Text } from './text';

/** T3 EmptyState (plain): optional mark, centered title, detail, optional action. */
export function EmptyState({ title, detail, action, mark }: { title: string; detail?: string; action?: ReactNode; mark?: ReactNode }) {
  return (
    <View style={styles.root}>
      {mark ? <View style={styles.mark}>{mark}</View> : null}
      <Text variant="title" weight="bold" align="center" accessibilityRole="header">
        {title}
      </Text>
      {detail ? (
        <Text variant="body" tone="secondary" align="center" style={styles.detail}>
          {detail}
        </Text>
      ) : null}
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', paddingHorizontal: space.xxxl, paddingVertical: space.xxxl },
  mark: { marginBottom: space.xxl },
  detail: { marginTop: space.sm, maxWidth: 340 },
  action: { marginTop: space.xl, alignSelf: 'stretch', alignItems: 'center', gap: space.xs },
});
