/**
 * Which voice reads a reply, and what Settings › Voice says about the natural voice's model
 * (pure, unit-tested; the lifecycle itself is `src/services/natural-voice.ts`).
 *
 *   absent ──(Download)──▶ downloading ──▶ compiling ──▶ ready ──(load: Neural Engine → GPU → CPU)──▶ loaded
 *
 * The natural voice reads only when its model is loaded. A load starts as soon as the download
 * finishes, when the app comes to the foreground and when a read finds it unloaded; each compute
 * unit gets its own timeout, and the first that loads and makes real speech is remembered for this
 * app + iOS version. Otherwise the system voice reads and says why, quietly: not downloaded,
 * downloading, preparing (a load in progress), couldn't load (every compute unit failed: the reason),
 * too slow (the perf guard), stopped unexpectedly (the crash guard) or no usable audio.
 */

import { slowStillApplies, type SlowRecord, type VersionStamp } from '../live-dictation/perf-guard';
import { SYSTEM_VOICE } from './voices';

export type ModelPhase = 'absent' | 'downloading' | 'compiling' | 'ready';

/** Core ML compute units a load asks for: Neural Engine (+ GPU for three stages, FluidAudio's plan), GPU, CPU. */
export type Units = 'ane' | 'gpu' | 'cpu';
export const UNITS_ORDER: readonly Units[] = ['ane', 'gpu', 'cpu'];
export const UNIT_LABEL: Record<Units, string> = { ane: 'Neural Engine', gpu: 'GPU', cpu: 'CPU' };

/**
 * Per-attempt load timeouts. The first Neural Engine load compiles every stage for this iPhone's
 * ANE (13-18 s on an M-series Mac; unmeasured on a phone), so it gets two minutes; GPU and CPU
 * loads have no ANE compile.
 */
export const LOAD_TIMEOUT_MS: Record<Units, number> = { ane: 120_000, gpu: 60_000, cpu: 60_000 };
/** How long a read waits for a load in progress before the system voice reads instead. */
export const READ_WAIT_MS = 3_000;

export function isUnits(v: unknown): v is Units {
  return v === 'ane' || v === 'gpu' || v === 'cpu';
}

/** "ane=120,gpu=60,cpu=60" (seconds; QA launch argument) over the defaults. */
export function parseTimeouts(arg: string | null | undefined, base: Record<Units, number> = LOAD_TIMEOUT_MS): Record<Units, number> {
  const out = { ...base };
  for (const part of (arg ?? '').split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    const sec = Number(v);
    if (isUnits(k) && Number.isFinite(sec) && sec > 0) out[k] = Math.round(sec * 1000);
  }
  return out;
}

export type NaturalState = {
  /** Native module present and iOS 18+. */
  supported: boolean;
  model: ModelPhase;
  /** Download progress 0…1. */
  fraction: number;
  /** The ready marker is there but model files are missing (the download repairs them). */
  damaged: boolean;
  /** In memory in this app process. */
  loaded: boolean;
  loading: boolean;
  /** The compute units of the load in progress, or of the loaded model. */
  loadUnits: Units | null;
  /** When the load attempt in progress started (for "Preparing … 34 s"). */
  loadStartedAt: number | null;
  /** The stage the native load is on (diagnostics). */
  loadStage: string | null;
  /** Every compute unit failed to load on this app + iOS version (short reason); off until Try again or an update. */
  loadFailure: string | null;
  /** The perf guard's verdict for this app + iOS version. */
  slow: SlowRecord | null;
  /** The crash guard: the app died mid-read twice on this app + iOS version. */
  crashed: boolean;
  /** The model loaded but produced silence or garbage with every compute unit on this app + iOS version. */
  broken: boolean;
  /** Waiting for Wi-Fi (a download that may not use cellular). */
  waitingForWifi: boolean;
  /** Last download / read problem, phrased for the status line. */
  error: string | null;
};

export type SystemReason =
  | 'chosen'
  | 'unsupported'
  | 'not-downloaded'
  | 'downloading'
  | 'preparing'
  | 'load-failed'
  | 'slow'
  | 'crashed'
  | 'broken'
  | 'failed';
export type EngineChoice = { engine: 'natural' } | { engine: 'system'; reason: SystemReason; detail?: string };

/** `voice`: the resolved preference (a natural voice id or 'system'). */
export function chooseEngine(voice: string, s: NaturalState): EngineChoice {
  if (voice === SYSTEM_VOICE) return { engine: 'system', reason: 'chosen' };
  if (!s.supported) return { engine: 'system', reason: 'unsupported' };
  if (s.crashed) return { engine: 'system', reason: 'crashed' };
  if (s.broken) return { engine: 'system', reason: 'broken' };
  if (s.slow) return { engine: 'system', reason: 'slow' };
  if (s.model === 'absent') return { engine: 'system', reason: 'not-downloaded' };
  if (s.model !== 'ready') return { engine: 'system', reason: 'downloading' };
  if (s.loadFailure) return { engine: 'system', reason: 'load-failed', detail: s.loadFailure };
  if (!s.loaded) return { engine: 'system', reason: 'preparing' };
  return { engine: 'natural' };
}

/** The one-line note shown (once per app run and reason) when the system voice reads instead. */
export function systemNotice(reason: SystemReason, detail?: string): string | null {
  switch (reason) {
    case 'not-downloaded':
      return 'Reading with the system voice. The natural voice is in Settings › Voice.';
    case 'downloading':
      return 'Natural voice still downloading. Using the system voice.';
    case 'preparing':
      return 'Preparing the natural voice (the first time can take a minute). Using the system voice.';
    case 'load-failed':
      return `The natural voice couldn't load on this iPhone: ${detail || 'unknown error'}. Using the system voice.`;
    case 'slow':
      return 'Natural voice too slow on this iPhone. Using the system voice.';
    case 'crashed':
      return 'Natural voice stopped unexpectedly. Using the system voice.';
    case 'broken':
      return 'The natural voice made no usable audio on this iPhone. Using the system voice.';
    case 'failed':
      return 'Natural voice could not read this reply. Using the system voice.';
    default:
      return null;
  }
}

/** The natural voice could load now (nothing turned it off and it is not loaded or loading). */
export function canLoad(s: NaturalState): boolean {
  return s.supported && !s.crashed && !s.broken && !s.slow && !s.loadFailure && s.model === 'ready' && !s.loaded && !s.loading;
}

/** The natural voice should be loaded now (the app is in the foreground and it would read). */
export function shouldLoad(voice: string, s: NaturalState): boolean {
  return voice !== SYSTEM_VOICE && canLoad(s);
}

export type StatusTone = 'secondary' | 'success' | 'warning' | 'danger';
export type StatusLine = { label: string; tone: StatusTone };

export function statusLine(s: NaturalState, now = Date.now()): StatusLine {
  if (!s.supported) return { label: 'Needs iOS 18 or later', tone: 'secondary' };
  if (s.crashed) return { label: 'Off · stopped unexpectedly', tone: 'warning' };
  if (s.broken) return { label: 'Off · no usable audio on this iPhone', tone: 'warning' };
  if (s.slow) return { label: 'Off · too slow on this iPhone', tone: 'warning' };
  if (s.model === 'downloading') {
    const pct = Math.max(0, Math.min(99, Math.floor(s.fraction * 100)));
    const what = s.damaged ? 'Repairing' : 'Downloading';
    return { label: `${what} ${pct}%${s.waitingForWifi ? ' · waiting for Wi-Fi' : ''}`, tone: 'secondary' };
  }
  if (s.model === 'compiling') return { label: 'Preparing the files…', tone: 'secondary' };
  if (s.model === 'ready') {
    if (s.loadFailure) return { label: `Failed: ${s.loadFailure}`, tone: 'danger' };
    if (s.loading) {
      const secs = s.loadStartedAt ? Math.max(0, Math.floor((now - s.loadStartedAt) / 1000)) : 0;
      const label =
        !s.loadUnits || s.loadUnits === 'ane'
          ? `Preparing the voice (the first time can take a minute)… ${secs} s`
          : `Preparing the voice on the ${UNIT_LABEL[s.loadUnits]}… ${secs} s`;
      return { label, tone: 'secondary' };
    }
    if (s.loaded) return { label: `Loaded · ${UNIT_LABEL[s.loadUnits ?? 'ane']}`, tone: 'success' };
    if (s.error) return { label: `Ready · ${s.error}`, tone: 'warning' };
    return { label: 'Ready', tone: 'success' };
  }
  if (s.damaged) return { label: `Needs repair${s.error ? ` · ${s.error}` : ' · some files are missing'}`, tone: 'warning' };
  if (s.error) return { label: `Not downloaded · ${s.error}`, tone: 'warning' };
  const partial = s.fraction > 0 ? ` (${Math.floor(s.fraction * 100)}%)` : '';
  return { label: `Not downloaded${partial}`, tone: 'secondary' };
}

/**
 * A native error, short enough for a status line: no file paths (their last part stays), no
 * Expo wrapper, one line, at most `max` characters.
 */
export function shortReason(message: string, max = 140): string {
  let t = message;
  const i = t.lastIndexOf('Caused by:');
  if (i >= 0) t = t.slice(i + 'Caused by:'.length);
  t = t
    .replace(/(?:file:\/\/)?\/(?:[^\s'"/:]+\/)+([^\s'"/:]+)/g, '…/$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '');
  if (!t) return 'unknown error';
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Sizes from the pinned file list (modules/kokoro-tts/ios/KokoroModelStore.swift). */
export const DOWNLOAD_BYTES = 226_869_788;
export const SIZE_NOTE = '227 MB download, about 216 MB on this iPhone';

export function formatMB(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * Perf guard: synthesis must run faster than real time. The verdict comes from the first five
 * pieces after a load (3 of 5 slower than real time → too slow), the same median rule as live
 * dictation's guard, and lasts until the app or iOS version changes.
 */
export const REALTIME_MS_PER_SECOND = 1000;

/** A verdict that lasts until the app or iOS version changes (no usable audio). */
export type VersionRecord = VersionStamp & { at: number };

export function recordStillApplies(rec: VersionRecord | null | undefined, now: VersionStamp): boolean {
  return slowStillApplies(rec ? { ...rec, medianMs: 0 } : null, now);
}

/** Crash guard: a read in flight when the app died counts once; two (same app + iOS) turn the voice off. */
export type CrashRecord = VersionStamp & { count: number; at: number };
export const CRASH_LIMIT = 2;

export function crashesStillApply(rec: CrashRecord | null | undefined, now: VersionStamp): boolean {
  return !!rec && rec.count >= CRASH_LIMIT && slowStillApplies({ ...rec, medianMs: 0 }, now);
}

/** A read was in flight at the last launch: the new count (a different app or iOS version starts over). */
export function countCrash(rec: CrashRecord | null | undefined, now: VersionStamp, at: number): CrashRecord {
  const same = !!rec && slowStillApplies({ ...rec, medianMs: 0 }, now);
  return { ...now, count: (same ? rec!.count : 0) + 1, at };
}
