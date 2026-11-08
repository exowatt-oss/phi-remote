/**
 * Home header title: the phi wordmark, or — once a computer has not been live for 800 ms — the
 * connection status in its place (T3 WorkspaceConnectionTitle).
 */

import { router } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';

import { useDelayed } from '@/hooks/use-delayed';
import { connectionTitle, type HostView } from '@/lib/store';
import { motion, useTheme } from '@/theme';
import { Icon, PhiMark, Text } from '@/ui';

export function BrandTitle() {
  return (
    <View style={styles.brand} accessible accessibilityRole="header" accessibilityLabel="phi remote">
      <PhiMark size={18} />
      <Text variant="title" weight="bold" style={styles.word}>
        phi
      </Text>
      <Text variant="title" weight="medium" tone="secondary" style={styles.word}>
        remote
      </Text>
    </View>
  );
}

export function HomeTitle({ hosts }: { hosts: HostView[] }) {
  const { colors } = useTheme();
  const status = connectionTitle(hosts);
  const show = useDelayed(status !== null, motion.statusDelay);
  if (!show || !status) return <BrandTitle />;
  const { text, spinner } = status;
  return (
    <Animated.View entering={FadeIn.duration(motion.statusFade).reduceMotion(ReduceMotion.System)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={text}
        accessibilityHint="Shows your computers"
        accessibilityLiveRegion="polite"
        onPress={() => router.push('/hosts')}
        style={styles.status}
      >
        {spinner ? <ActivityIndicator size="small" color={colors.textSecondary} /> : <Icon name="wifi.slash" size={15} color={colors.textSecondary} />}
        <Text variant="body" weight="bold" tone="secondary" numberOfLines={1}>
          {text}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  word: { letterSpacing: -0.5 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 260 },
});

