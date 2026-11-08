/**
 * Add a computer: scan the QR from `phi remote pair`, or type its address and code. A
 * phiremote://pair link (deep link or QR) asks for confirmation first.
 */

import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { QrScanner } from '@/components/qr-scanner';
import { showToast } from '@/components/toast';
import { machineSymbol } from '@/lib/format';
import { displayHost, normalizeCode, normalizeHubUrl, pairWithHub, parsePairingLink, PairingError, type PairingLink } from '@/lib/pairing';
import { offerNotifications } from '@/services/push';
import { deviceName, fetchImpl, remote } from '@/services/remote';
import { fonts, radii, space, useTheme } from '@/theme';
import { Button, Icon, Text } from '@/ui';

type Mode = 'scan' | 'manual';

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function Segmented({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  const { colors } = useTheme();
  const items: { key: Mode; label: string }[] = [
    { key: 'scan', label: 'Scan code' },
    { key: 'manual', label: 'Enter code' },
  ];
  return (
    <View style={[styles.segmented, { backgroundColor: colors.surface }]} accessibilityRole="tablist">
      {items.map((it) => {
        const on = it.key === value;
        return (
          <Pressable
            key={it.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(it.key)}
            style={[styles.segment, on && { backgroundColor: colors.bgElevated }]}
          >
            <Text variant="label" weight="medium" tone={on ? 'primary' : 'secondary'}>
              {it.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function PairScreen() {
  const params = useLocalSearchParams<{ link?: string; mode?: string; url?: string; name?: string }>();
  const { colors } = useTheme();
  const fromLink = useMemo(() => {
    const raw = first(params.link);
    return raw ? parsePairingLink(raw) : null;
  }, [params.link]);
  const prefillUrl = first(params.url);

  const [mode, setMode] = useState<Mode>(first(params.mode) === 'manual' || prefillUrl ? 'manual' : 'scan');
  const [link, setLink] = useState<PairingLink | null>(fromLink?.ok ? fromLink.value : null);
  const [address, setAddress] = useState(prefillUrl ? displayHost(prefillUrl) : '');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(fromLink && !fromLink.ok ? fromLink.error : null);

  const pair = async (req: { urls: string[]; code: string; hubId?: string; name?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const host = await pairWithHub({ ...req, deviceName }, { fetch: fetchImpl });
      await remote.addHost(host);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.dismissTo('/');
      showToast(`Paired with ${host.name}`);
      // First computer: ask for notifications now (once; never after a no).
      void offerNotifications().catch(() => undefined);
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(err instanceof PairingError || err instanceof Error ? err.message : 'Pairing failed.');
    } finally {
      setBusy(false);
    }
  };

  if (link) {
    const name = link.name ?? 'this computer';
    return (
      <KeyboardAwareScrollView contentContainerStyle={styles.content}>
        <View style={[styles.confirm, { backgroundColor: colors.surface }]}>
          <View style={[styles.mark, { backgroundColor: colors.bg }]}>
            <Icon name={machineSymbol(name)} size={20} />
          </View>
          <Text variant="title" weight="bold" align="center">
            {`Pair with ${name}?`}
          </Text>
          <Text variant="footnote" tone="secondary" align="center">
            This iPhone will see and control every phi session on it.
          </Text>
          {/* One line where it fits: the sheet opens at 60 %, and on a 375 pt phone the
              stacked facts pushed Pair below the fold. */}
          <Text mono tone="tertiary" align="center" style={styles.facts}>
            {[...link.urls.map(displayHost), `code ${link.code}`].join('  ·  ')}
          </Text>
        </View>
        {error ? (
          <Text variant="footnote" tone="danger" align="center">
            {error}
          </Text>
        ) : null}
        <Button title={busy ? 'Pairing…' : 'Pair'} busy={busy} onPress={() => pair({ urls: link.urls, code: link.code, hubId: link.hubId, name: link.name })} />
        <Button title="Cancel" variant="plain" onPress={() => (setLink(null), setError(null))} />
      </KeyboardAwareScrollView>
    );
  }

  const manualUrl = normalizeHubUrl(address);
  const manualCode = normalizeCode(code);

  return (
    <KeyboardAwareScrollView bottomOffset={space.xl} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Text variant="footnote" tone="secondary">
        On the computer, run phi remote pair. It shows a code and the addresses this iPhone can use.
      </Text>
      <Segmented value={mode} onChange={setMode} />
      {mode === 'scan' ? (
        <QrScanner onLink={setLink} />
      ) : (
        <View style={styles.form}>
          <View style={[styles.field, { backgroundColor: colors.surface }]}>
            <Text variant="label" tone="secondary">
              Address
            </Text>
            <TextInput
              value={address}
              onChangeText={setAddress}
              placeholder="192.0.2.10 or my-mac.local"
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              textContentType="URL"
              selectionColor={colors.accent}
              accessibilityLabel="Computer address"
              style={[styles.input, { color: colors.text }]}
            />
          </View>
          <View style={[styles.field, { backgroundColor: colors.surface }]}>
            <Text variant="label" tone="secondary">
              Code
            </Text>
            <TextInput
              value={code}
              onChangeText={(t) => setCode(t.toUpperCase())}
              placeholder="K7Q2M9XD"
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={11}
              selectionColor={colors.accent}
              accessibilityLabel="Pairing code, 8 characters"
              style={[styles.input, styles.code, { color: colors.text }]}
            />
          </View>
          <Text variant="caption" tone="tertiary">
            Port 7717 is assumed when you leave it out.
          </Text>
          {error ? (
            <Text variant="footnote" tone="danger">
              {error}
            </Text>
          ) : null}
          <Button
            title={busy ? 'Pairing…' : 'Pair'}
            busy={busy}
            disabled={!manualUrl || !manualCode}
            onPress={() => manualUrl && manualCode && pair({ urls: [manualUrl], code: manualCode })}
          />
        </View>
      )}
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg, paddingBottom: space.xxxl * 2 },
  segmented: { flexDirection: 'row', borderRadius: radii.md, padding: 3 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: radii.sm + 1 },
  form: { gap: space.md },
  field: { borderRadius: radii.notice, borderCurve: 'continuous', paddingHorizontal: space.lg, paddingTop: space.sm, gap: 2 },
  input: { fontFamily: fonts.regular, fontSize: 16, paddingVertical: space.sm },
  code: { fontFamily: fonts.mono, fontSize: 20, letterSpacing: 3 },
  confirm: { borderRadius: radii.card, borderCurve: 'continuous', padding: space.xl, gap: space.sm, alignItems: 'center' },
  mark: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginBottom: space.xs },
  facts: { marginTop: space.xs },
});
