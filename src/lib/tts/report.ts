/**
 * Settings › Voice › Diagnostics: the natural voice's state on this phone as plain text, for the
 * screen and for Copy (pure; `naturalVoiceReport()` in services/natural-voice.ts gathers the parts).
 */

import type { KokoroDiagnostics } from '../../../modules/kokoro-tts';
import { statusLine, UNIT_LABEL, type NaturalState, type Units } from './engine';
import { formatMs, formatTtsEvent, stamp, type TtsLogEvent } from './tts-log';

export type AttemptOutcome = 'ok' | 'timeout' | 'error' | 'bad-audio' | 'interrupted' | 'unloaded';
/** One load attempt with one set of compute units. */
export type LoadAttempt = { at: number; units: Units; ms: number; outcome: AttemptOutcome; error?: string };

export type ReportInput = {
  now: number;
  app: { version: string; build: string };
  os: string;
  voice: string;
  state: NaturalState & { bytesOnDisk: number; lastLoad: { at: number; seconds: number; warmupMs: number; footprintMB: number; units?: Units } | null };
  timeouts: Record<Units, number>;
  readWaitMs: number;
  chain: Units[];
  remembered: Units | null;
  loadCrashes: Units[];
  crashes: number;
  attempts: LoadAttempt[];
  native: KokoroDiagnostics | null;
  nativeError: string | null;
  events: TtsLogEvent[];
};

const mb = (bytes: number) => (bytes < 0 ? 'missing' : bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${(bytes / 1000).toFixed(1)} kB`);

export function formatReport(r: ReportInput): string {
  const s = r.state;
  const n = r.native;
  const lines: string[] = [];
  const push = (...xs: string[]) => lines.push(...xs);
  push(`phi remote · natural voice diagnostics · ${stamp(r.now)}`);
  push(`app ${r.app.version} (${r.app.build}) · iOS ${n?.osVersion || r.os} · ${n?.deviceModel || 'unknown device'}`);
  push(`voice: ${r.voice} · status: ${statusLine(s, r.now).label}`);
  push('');
  push('State');
  push(`  supported ${s.supported} · model ${s.model}${s.damaged ? ' (damaged)' : ''} · loaded ${s.loaded}${s.loadUnits ? ` (${s.loadUnits})` : ''} · loading ${s.loading}`);
  if (s.loading && s.loadStartedAt) push(`  loading for ${formatMs(r.now - s.loadStartedAt)}${s.loadStage ? `, stage ${s.loadStage}` : ''}`);
  push(`  guards: crashed ${s.crashed} (${r.crashes} read crash${r.crashes === 1 ? '' : 'es'}) · broken ${s.broken} · slow ${s.slow ? `yes (median ${s.slow.medianMs} ms/s)` : 'no'}`);
  push(`  load failure: ${s.loadFailure ?? 'none'} · error: ${s.error ?? 'none'}`);
  push(`  compute units: next load tries ${r.chain.length ? r.chain.join(' → ') : 'none'} · remembered ${r.remembered ?? 'none'} · crashed while loading ${r.loadCrashes.length ? r.loadCrashes.join(', ') : 'none'}`);
  push(`  timeouts: ${(['ane', 'gpu', 'cpu'] as Units[]).map((u) => `${u} ${Math.round(r.timeouts[u] / 1000)} s`).join(', ')} · a read waits ${formatMs(r.readWaitMs)}`);
  if (s.lastLoad) {
    const l = s.lastLoad;
    push(`  last load: ${stamp(l.at)} · ${l.units ? UNIT_LABEL[l.units] : 'Neural Engine'} · ${l.seconds.toFixed(1)} s + warm-up ${Math.round(l.warmupMs)} ms · ${Math.round(l.footprintMB)} MB`);
  } else push('  last load: never');
  push('');
  push(`Load attempts (newest last, ${r.attempts.length})`);
  if (!r.attempts.length) push('  none');
  for (const a of r.attempts) push(`  ${stamp(a.at)} ${a.units} ${a.outcome} after ${formatMs(a.ms)}${a.error ? `: ${a.error}` : ''}`);
  push('');
  push('Model files');
  if (n) {
    push(`  dir ${n.dir}`);
    push(`  ready marker ${n.readyMarker} · intact ${n.intact}${n.missing.length ? ` · missing ${n.missing.length}: ${n.missing.slice(0, 8).join(', ')}${n.missing.length > 8 ? ' …' : ''}` : ''}`);
    push(`  on disk ${mb(n.bytesOnDisk)} · free ${mb(n.freeBytes)} · protection ${n.protection} · excluded from backup ${n.excludedFromBackup}`);
    push(`  Core ML compile cache ${n.aneCacheBytes < 0 ? 'not found' : mb(n.aneCacheBytes)} · app memory ${Math.round(n.footprintMB)} MB`);
    push(`  native engine ${n.engineUnits ?? 'not loaded'}${n.running.length ? ` · still running: ${n.running.map((x) => `${x.units} ${Math.round(x.seconds)} s${x.timedOut ? ' (timed out)' : ''}${x.abandoned ? ' (dropped)' : ''}`).join(', ')}` : ''}`);
    if (n.qaFlags) push(`  QA flags: ${n.qaFlags}`);
    for (const f of n.files) push(`  ${f.bytes < 0 ? '✗' : '✓'} ${f.path} ${mb(f.bytes)}`);
  } else push(`  unavailable: ${r.nativeError ?? 'unknown'}`);
  if (n?.log.length) {
    push('');
    push(`Native log (newest last, ${n.log.length})`);
    for (const l of n.log) push(`  ${l}`);
  }
  push('');
  push(`Events (newest last, ${r.events.length})`);
  if (!r.events.length) push('  none');
  for (const e of r.events) push(`  ${formatTtsEvent(e)}`);
  return lines.join('\n');
}
