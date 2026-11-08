/**
 * Thread header pieces: two-line title (T3 thread header), the "read latest reply" toggle and a
 * plain icon button. A thread of an overseer draws its subtitle as a small chip ("Thread of …").
 */

import { ActivityIndicator, Pressable, Text as RNText, StyleSheet, useWindowDimensions, View } from 'react-native';

import { useDelayed } from '@/hooks/use-delayed';
import type { AssistantItem } from '@/lib/protocol';
import { stopSpeaking, toggleSpeak, useSpeakingId } from '@/services/speech';
import { motion, radii, useTheme } from '@/theme';
import { Icon, Text, type IconName } from '@/ui';

export function ThreadTitle({
  title,
  subtitle,
  reconnecting,
  chip = false,
  rightButtons = 1,
  onPress,
  accessibilityHint,
}: {
  title: string;
  subtitle: string;
  reconnecting: boolean;
  /** The subtitle is a chip that leads somewhere (an overseer's thread: "Thread of …"). */
  chip?: boolean;
  /** 44 pt buttons on the right of the header (the title gets what is left between them). */
  rightButtons?: number;
  /** Makes the title a button (a subagent's title opens its parent thread). */
  onPress?: () => void;
  accessibilityHint?: string;
}) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const showReconnecting = useDelayed(reconnecting, motion.statusDelay);
  const label = `${title}. ${showReconnecting ? 'Reconnecting' : subtitle}`;
  // Room between the two 44 pt header buttons (16 margins + 12 gaps), so big phones show more;
  // each extra button on the right takes its width (plus the glass capsule's padding) away.
  const extra = Math.max(0, rightButtons - 1) * 52;
  const maxWidth = Math.max(extra ? 150 : 220, width - 2 * (16 + 44 + 12) - extra);
  const content = (
    <>
      <RNText numberOfLines={1} maxFontSizeMultiplier={1.3} style={[styles.titleText, { color: colors.text }]}>
        {title}
      </RNText>
      <View style={[styles.subtitle, chip && !showReconnecting && [styles.chip, { backgroundColor: colors.surface }]]}>
        {showReconnecting ? <ActivityIndicator size="small" color={colors.textSecondary} style={styles.spinner} /> : null}
        {chip && !showReconnecting ? <Icon name="rectangle.stack" size={10} weight="semibold" color={colors.iconMuted} /> : null}
        <Text variant="caption" weight="medium" tone="secondary" numberOfLines={1} style={styles.subtitleText}>
          {showReconnecting ? 'Reconnecting…' : subtitle}
        </Text>
        {chip && !showReconnecting ? <Icon name="chevron.right" size={8} weight="bold" color={colors.iconMuted} /> : null}
      </View>
    </>
  );
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        hitSlop={8}
        onPress={onPress}
        style={({ pressed }) => [styles.title, { maxWidth }, pressed && styles.pressed]}
      >
        {content}
      </Pressable>
    );
  }
  return (
    <View style={[styles.title, { maxWidth }]} accessible accessibilityRole="header" accessibilityLabel={label}>
      {content}
    </View>
  );
}

/** A plain 44 pt header icon button. */
export function HeaderIconButton({ icon, label, hint, onPress }: { icon: IconName; label: string; hint?: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} hitSlop={10} onPress={onPress} style={styles.button}>
      <Icon name={icon} size={19} color={colors.icon} />
    </Pressable>
  );
}

/** Speaks the newest reply; shows stop while anything in this thread is being read. */
export function ReadLatestButton({ latest, threadItemIds }: { latest: AssistantItem | null; threadItemIds: ReadonlySet<string> }) {
  const { colors } = useTheme();
  const speakingId = useSpeakingId();
  const speakingHere = speakingId !== null && threadItemIds.has(speakingId);
  if (!latest && !speakingHere) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={speakingHere ? 'Stop reading' : 'Read latest reply'}
      hitSlop={10}
      onPress={() => (speakingHere ? void stopSpeaking() : latest && toggleSpeak(latest.id, latest.text))}
      style={styles.button}
    >
      <Icon name={speakingHere ? 'stop.fill' : 'speaker.wave.2'} size={20} color={speakingHere ? colors.accent : colors.icon} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  title: { alignItems: 'center' },
  pressed: { opacity: 0.55 },
  // T3 uses the system face at 17/800 for the navigation title.
  titleText: { fontSize: 17, lineHeight: 21, fontWeight: '800' },
  subtitle: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%' },
  subtitleText: { flexShrink: 1 },
  chip: { marginTop: 2, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radii.pill },
  spinner: { transform: [{ scale: 0.6 }], width: 12, height: 12 },
  button: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
