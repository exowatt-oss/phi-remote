/** Pairing QR scanner (expo-camera). Calls back once with the first valid phiremote://pair link. */

import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { parsePairingLink, type PairingLink } from '@/lib/pairing';
import { radii, space, useTheme } from '@/theme';
import { Button, Icon, Text } from '@/ui';

export function QrScanner({ onLink }: { onLink: (link: PairingLink) => void }) {
  const { colors } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState<string | null>(null);
  const lastBad = useRef(0);
  const done = useRef(false);

  if (!permission) return <View style={[styles.camera, { backgroundColor: colors.surface }]} />;
  if (!permission.granted) {
    return (
      <View style={[styles.camera, styles.off, { backgroundColor: colors.surface }]}>
        <Icon name="qrcode.viewfinder" size={32} color={colors.iconMuted} />
        <Text variant="footnote" tone="secondary" align="center">
          phi needs the camera to read the pairing code.
        </Text>
        {permission.canAskAgain ? (
          <Button title="Allow camera" variant="plain" onPress={() => void requestPermission()} />
        ) : (
          <Button title="Open Settings" variant="plain" onPress={() => void Linking.openSettings()} />
        )}
      </View>
    );
  }
  return (
    <View style={[styles.camera, { backgroundColor: colors.camera }]}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (done.current) return;
          const parsed = parsePairingLink(data);
          if (parsed.ok) {
            done.current = true;
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            onLink(parsed.value);
          } else if (Date.now() - lastBad.current > 2500) {
            lastBad.current = Date.now();
            setHint(parsed.error);
          }
        }}
      />
      <View pointerEvents="none" style={[styles.reticle, { borderColor: colors.onCamera }]} />
      {hint ? (
        <View pointerEvents="none" style={[styles.hint, { backgroundColor: colors.cameraHint }]}>
          <Text variant="label" weight="medium" align="center" style={{ color: colors.onCamera }}>
            {hint}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  camera: { aspectRatio: 1, borderRadius: radii.group, borderCurve: 'continuous', overflow: 'hidden' },
  off: { alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xxl },
  reticle: {
    position: 'absolute',
    top: '18%',
    left: '18%',
    right: '18%',
    bottom: '18%',
    borderRadius: radii.bubble,
    borderWidth: 2,
    opacity: 0.85,
  },
  hint: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    bottom: space.lg,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radii.pill,
  },
});
