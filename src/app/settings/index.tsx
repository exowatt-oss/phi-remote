/** Settings: computers, new threads, read aloud, notifications, about. Nothing else. */

import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { describeNewThreadDefault } from '@/lib/new-thread';
import { SPEECH_RATES, voiceLabel, type VoiceLike } from '@/lib/speech';
import { naturalVoice, resolveTtsVoice } from '@/lib/tts/voices';
import { useNaturalVoice } from '@/services/natural-voice';
import { setNotificationsEnabled } from '@/services/push';
import { appBuild, appVersion, remote, useRemote } from '@/services/remote';
import { defaultVoice, installedVoices } from '@/services/speech';
import { radii, space, useTheme } from '@/theme';
import { ListRow, ListSection, PhiMark, Text } from '@/ui';

function SpeedControl({ rate }: { rate: number }) {
  const { colors } = useTheme();
  return (
    <View style={styles.speedRow}>
      <Text variant="body">Speed</Text>
      <View style={[styles.segmented, { backgroundColor: colors.bg }]} accessibilityRole="radiogroup" accessibilityLabel="Reading speed">
        {SPEECH_RATES.map((r) => {
          const on = Math.abs(r - rate) < 0.01;
          return (
            <Pressable
              key={r}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${r} times`}
              onPress={() => void remote.updatePrefs({ speechRate: r })}
              style={[styles.segment, on && { backgroundColor: colors.surfacePressed }]}
            >
              <Text variant="label" weight="medium" tone={on ? 'primary' : 'secondary'} numeric maxFontSizeMultiplier={1.3}>
                {`${r}×`}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function SettingsScreen() {
  const { colors } = useTheme();
  const hostCount = useRemote((s) => s.hostOrder.length);
  const prefs = useRemote((s) => s.prefs);
  const anyLive = useRemote((s) => s.hostOrder.some((id) => s.hosts[id]?.conn.status === 'live'));
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifNote, setNotifNote] = useState<{ text: string; denied: boolean } | null>(null);
  const [voice, setVoice] = useState<VoiceLike | null>(null);
  const naturalSupported = useNaturalVoice((s) => s.supported);
  const natural = naturalSupported ? naturalVoice(resolveTtsVoice(prefs.ttsVoice)) : undefined;

  useEffect(() => {
    let alive = true;
    void (async () => {
      const voices = await installedVoices();
      const chosen = (prefs.voiceId && voices.find((v) => v.identifier === prefs.voiceId)) || (await defaultVoice());
      if (alive) setVoice(chosen ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [prefs.voiceId]);

  const toggleNotifications = async (on: boolean) => {
    setNotifBusy(true);
    setNotifNote(null);
    try {
      const res = await setNotificationsEnabled(on);
      if (!res.ok) setNotifNote({ text: res.message, denied: res.denied });
    } finally {
      setNotifBusy(false);
    }
  };

  const switchColors = { true: colors.accent, false: colors.surfacePressed };

  return (
    <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <ListSection title="Hosts" inset>
        <ListRow
          icon="desktopcomputer"
          label="Computers"
          detail={hostCount === 0 ? 'None' : String(hostCount)}
          chevron
          onPress={() => router.push('/hosts')}
        />
      </ListSection>

      <ListSection title="New threads" footer={anyLive ? undefined : 'Models come from a connected computer. Connect one to change this.'}>
        <ListRow
          label="Model"
          detail={describeNewThreadDefault(prefs.newThread)}
          detailMaxWidth="72%"
          chevron={anyLive}
          onPress={anyLive ? () => router.push('/settings/new-thread') : undefined}
        />
      </ListSection>

      <ListSection title="Read aloud" footer="Replies are spoken on this iPhone. Code blocks are skipped.">
        <ListRow
          label="Voice"
          detail={natural ? natural.name : voice ? voiceLabel(voice) : 'System'}
          chevron
          onPress={() => router.push('/settings/voice')}
        />
        <SpeedControl rate={prefs.speechRate ?? 1} />
        <ListRow
          label="Read new replies automatically"
          description="Only in the thread you have open."
          accessory={
            <Switch
              value={!!prefs.autoRead}
              onValueChange={(v) => void remote.updatePrefs({ autoRead: v || undefined })}
              trackColor={switchColors}
              accessibilityLabel="Read new replies automatically"
            />
          }
        />
      </ListSection>

      <ListSection
        title="Notifications"
        footer={notifNote?.text ?? 'A notification arrives when a thread finishes, unless you are looking at it.'}
      >
        <ListRow
          label="When a thread finishes"
          accessory={
            <Switch
              value={prefs.notifications === 'on'}
              disabled={notifBusy}
              onValueChange={(v) => void toggleNotifications(v)}
              trackColor={switchColors}
              accessibilityLabel="Notify when a thread finishes"
            />
          }
        />
        {notifNote?.denied ? <ListRow label="Open iOS Settings" chevron onPress={() => void Linking.openSettings()} /> : null}
      </ListSection>

      <ListSection title="About">
        <ListRow label="Version" detail={`${appVersion} (${appBuild})`} />
        <ListRow label="Open-source licenses" chevron onPress={() => router.push('/settings/licenses')} />
      </ListSection>

      <View style={styles.colophon} accessible accessibilityLabel="phi remote">
        <PhiMark size={24} />
        <Text variant="footnote" weight="medium" tone="secondary">
          phi remote
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.xxl, paddingBottom: space.xxxl * 2 },
  speedRow: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
  segmented: { flexDirection: 'row', borderRadius: radii.md, padding: 3 },
  colophon: { alignItems: 'center', gap: space.sm, paddingTop: space.sm },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: radii.sm + 1 },
});
