/**
 * Settings › Voice › Live dictation details: everything a real-iPhone test needs, readable in one
 * screenshot or two — the model, the last prepare (the Neural Engine compile), whether live
 * updates run at Neural Engine speed, memory and heat. No transcript text is stored.
 */

import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import PhononStt, { type PhononDeviceInfo } from '../../../modules/phonon-stt';
import {
  aneVerdict,
  formatDelta,
  formatMB,
  formatMs,
  formatSeconds,
  type SessionDiag,
} from '@/lib/live-dictation/diagnostics';
import { statusLine } from '@/lib/live-dictation/status';
import { useLiveDictation } from '@/services/live-dictation';
import { space } from '@/theme';
import { ListSection, Text } from '@/ui';

/** A label and a value that wraps instead of truncating (this screen is read from screenshots). */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text variant="body" style={styles.rowLabel}>
        {label}
      </Text>
      <Text variant="body" tone="secondary" style={styles.rowValue}>
        {value}
      </Text>
    </View>
  );
}

const MB = (bytes: number) => bytes / 1_000_000;

function when(at: number | null | undefined): string {
  if (!at) return '—';
  const d = new Date(at);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function arrow(a: string | null | undefined, b: string | null | undefined): string {
  return `${a ?? '—'} → ${b ?? '—'}`;
}

const OUTCOME: Record<SessionDiag['outcome'], string> = {
  inserted: 'Inserted',
  cancelled: 'Cancelled',
  'no-speech': 'No speech',
  'fell-back': 'Too slow — fell back',
  interrupted: 'Interrupted',
  error: 'Error',
};

export default function LiveDictationDetailsScreen() {
  const s = useLiveDictation((x) => x);
  const [device, setDevice] = useState<PhononDeviceInfo | null>(null);
  useEffect(() => {
    const read = () => {
      try {
        setDevice(PhononStt?.getDeviceInfo() ?? null);
      } catch {}
    };
    read();
    const t = setInterval(read, 2000);
    return () => clearInterval(t);
  }, []);

  const p = s.lastPrepare;
  const last = s.sessions[0] ?? null;
  const verdict = aneVerdict(last?.medianMs);
  const fn = p ? Object.entries(p.functionSeconds).map(([k, v]) => `${Number(k)} s function: ${formatSeconds(v)}`).join(', ') : '';

  return (
    <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <ListSection title="Model">
        <Row label="Status" value={statusLine(s).label} />
        <Row label="Revision" value={s.revision.slice(0, 8)} />
        <Row label="Download size" value={formatMB(MB(s.downloadBytes))} />
        <Row label="On this iPhone" value={formatMB(MB(s.bytesOnDisk))} />
        <Row label="Last download" value={s.lastDownload ? `${when(s.lastDownload.at)} · ${formatSeconds(s.lastDownload.seconds)}` : '—'} />
      </ListSection>

      <ListSection title="Prepare (Neural Engine compile)" footer="The first prepare after installing or updating iOS compiles the model for this iPhone; later launches take under a second.">
        <Row label="Last run" value={when(p?.at)} />
        <Row label="Time" value={formatSeconds(p?.seconds)} />
        {fn ? <Row label="Function" value={fn} /> : null}
        <Row label="Compute units requested" value={p?.computeUnits ?? 'cpuAndNeuralEngine'} />
        <Row
          label="Memory at load"
          value={p ? `${formatDelta(p.footprintBeforeMB, p.footprintAfterMB)} (peak ${formatMB(p.footprintPeakMB)})` : '—'}
        />
        <Row label="Thermal" value={p ? arrow(p.thermalStart, p.thermalEnd) : '—'} />
      </ListSection>

      <ListSection title="Last dictation" footer="Neural Engine speed is ~30–120 ms per update; 500 ms or more means Core ML fell back to the CPU.">
        <Row label="Runs on the Neural Engine?" value={verdict.label} />
        <Row label="Per update, median / p95" value={last ? `${formatMs(last.medianMs)} / ${formatMs(last.p95Ms)}` : '—'} />
        <Row label="End of speech → final" value={formatMs(last?.finalMs)} />
        <Row label="Updates · words" value={last ? `${last.updates} · ${last.words}` : '—'} />
        <Row label="Audio" value={last ? formatSeconds(last.audioSeconds) : '—'} />
        <Row
          label="Memory while dictating"
          value={last ? `${formatDelta(last.footprintStartMB, last.footprintPeakMB)} (peak ${formatMB(last.footprintPeakMB)})` : '—'}
        />
        <Row label="Thermal" value={last ? arrow(last.thermalStart, last.thermalEnd) : '—'} />
        <Row label="Result" value={last ? `${OUTCOME[last.outcome]} · ${when(last.at)}` : '—'} />
      </ListSection>

      {s.sessions.length > 1 ? (
        <ListSection title="Earlier dictations">
          {s.sessions.slice(1).map((x) => (
            <Row
              key={x.at}
              label={when(x.at)}
              value={`${formatMs(x.medianMs)} / ${formatMs(x.p95Ms)} · ${x.updates} updates · ${x.words} words · ${OUTCOME[x.outcome]}`}
            />
          ))}
        </ListSection>
      ) : null}

      <ListSection title="This iPhone">
        <Row label="Model" value={device?.model ?? '—'} />
        <Row label="iOS" value={device?.osVersionString ?? (s.osVersionString || '—')} />
        <Row label="App memory now" value={formatMB(device?.footprintMB)} />
        <Row label="Thermal now" value={device ? `${device.thermalState}${device.lowPowerMode ? ' · Low Power Mode' : ''}` : '—'} />
        <Row label="Network" value={s.network.connected === null ? '—' : !s.network.connected ? 'Offline' : s.network.expensive ? 'Cellular' : s.network.constrained ? 'Low Data Mode' : 'Wi-Fi'} />
      </ListSection>

      <ListSection title="Last error">
        <Row label={s.lastError ? when(s.lastError.at) : 'None'} value={s.lastError?.message ?? ''} />
      </ListSection>

      <Text variant="footnote" tone="secondary" style={styles.footer}>
        Phonon-2 by Fermion Research (CC-BY-4.0), derived from NVIDIA Parakeet TDT 0.6B v3. See Open-source licenses.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.xl, paddingBottom: space.xxxl * 2 },
  footer: { paddingHorizontal: space.lg },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingHorizontal: space.lg, paddingVertical: 12, minHeight: 44 },
  rowLabel: { flexShrink: 1, maxWidth: '55%' },
  rowValue: { flex: 1, textAlign: 'right' },
});
