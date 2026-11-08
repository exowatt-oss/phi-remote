/**
 * Add thread (Overseers, v1 addition): asks an overseer for one more thread. A normal prompt
 * (mode auto, so it steers a working overseer) that reads "Start a new thread: <description>"
 * plus the thread defaults in plain words; the overseer starts it with its `overseer` tool.
 */

import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Composer } from '@/components/composer';
import { useOverseerDefaults } from '@/components/overseer/defaults-form';
import { describeError } from '@/lib/client';
import { addThreadPrompt, describeOverseerDefaults } from '@/lib/overseer';
import { remote, useRemote } from '@/services/remote';
import { layout, space, useTheme } from '@/theme';
import { Pill, Text } from '@/ui';

export default function AddThreadScreen() {
  const params = useLocalSearchParams<{ hubId: string; sessionId: string }>();
  const hubId = String(params.hubId ?? '');
  const sessionId = String(params.sessionId ?? '');
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const host = useRemote((s) => s.hosts[hubId]);
  const summary = useRemote((s) => s.sessions[hubId]?.[sessionId]);
  const defaults = useOverseerDefaults();
  const [error, setError] = useState<string | null>(null);
  const live = host?.conn.status === 'live';

  const send = async (text: string): Promise<boolean> => {
    if (!text.trim()) return false;
    setError(null);
    try {
      const own = summary?.model ? { provider: summary.model.provider, id: summary.model.id, thinkingLevel: summary.thinkingLevel } : null;
      await remote.prompt(hubId, sessionId, addThreadPrompt(text, defaults, own), [], 'auto');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
      return true;
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(describeError(err));
      return false;
    }
  };

  const blocked = !host ? 'That computer is not paired' : !live ? `${host.name} is offline` : !summary ? 'This overseer is not running' : null;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <View style={styles.hero}>
        <Text variant="title" weight="medium" align="center" style={styles.heroText}>
          What should the new thread do?
        </Text>
        <Text variant="footnote" tone="secondary" align="center" numberOfLines={2}>
          The overseer starts it and watches it with the others.
        </Text>
        <Pill
          icon="slider.horizontal.3"
          label={describeOverseerDefaults(defaults)}
          chevron="right"
          maxWidth="100%"
          onPress={() => router.push(`/session/${encodeURIComponent(hubId)}/${encodeURIComponent(sessionId)}/add-thread/defaults`)}
          accessibilityLabel={`Thread defaults: ${describeOverseerDefaults(defaults)}. Change`}
          style={styles.pill}
        />
        {error ? (
          <Text variant="footnote" tone="danger" align="center">
            {error}
          </Text>
        ) : null}
      </View>
      <KeyboardStickyView offset={{ closed: 0, opened: Math.max(space.sm, insets.bottom) - space.sm }} style={styles.dock}>
        <View style={[styles.dockInner, { paddingBottom: Math.max(space.sm, insets.bottom) }]}>
          <Composer
            draftKey={`add-thread:${hubId}:${sessionId}`}
            placeholder="Describe the thread…"
            working={false}
            allowAttachments={false}
            autoFocus
            blockedReason={blocked}
            onSend={(text) => send(text)}
            onError={setError}
          />
        </View>
      </KeyboardStickyView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  hero: { paddingTop: space.xxl, alignItems: 'center', gap: space.sm, paddingHorizontal: space.xxl },
  heroText: { letterSpacing: -0.3 },
  pill: { alignSelf: 'center', marginTop: space.xs },
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  dockInner: { paddingHorizontal: layout.composerInset },
});
