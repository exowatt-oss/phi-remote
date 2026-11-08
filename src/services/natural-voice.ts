/**
 * The natural read-aloud voice (Kokoro-82M on this iPhone): its model lifecycle behind
 * Settings › Voice, loading and unloading, and the perf and crash guards. `speech.ts` asks
 * `naturalChoice()` which voice reads a reply and calls `readNatural()` to read it.
 *
 * - Download: on request (Settings, or the one-time offer on the first read-aloud), Wi-Fi only
 *   unless the person allows cellular when asked. Resumes after a relaunch until it finishes or
 *   is removed. Stored in Application Support, excluded from backups (modules/kokoro-tts). A
 *   model whose files went missing is repaired by downloading only those.
 * - Load: right after the download finishes, 1.5 s after the app comes to the foreground, and
 *   when a read finds it unloaded (that read waits up to READ_WAIT_MS). A load tries the compute
 *   units in turn, Neural Engine → GPU → CPU, each with its own timeout (the first Neural Engine
 *   load compiles for this iPhone and may take a minute), and remembers the first that loads and
 *   makes real speech for this app + iOS version. When every one fails the reason is shown (the
 *   read notice and Settings) until "Try again" or an app or iOS update. A load in progress is
 *   never dropped by a memory warning or a trip to the background: it finishes, and is unloaded
 *   if the app is still in the background then.
 * - Memory (~190 MB loaded): unloaded in the background, and on memory warnings when idle.
 * - Perf guard: if synthesis runs slower than real time (3 of the first 5 pieces after a load),
 *   the rest of the reply and later replies use the system voice until the app or iOS updates.
 * - Crash guards: a read in flight is marked on disk; found at the next launch it counts as a
 *   crash, and two (same app + iOS version) switch to the system voice. A load in flight in the
 *   foreground is marked too; found at launch, those compute units are skipped from then on.
 *   "Try again" resets every verdict.
 * - Log: every step goes to the read-aloud log (Documents/diagnostics/tts-log.json), shown and
 *   copied by Settings › Voice › Diagnostics with the model files and the guards.
 *
 * Settings, the verdicts and the markers persist in Documents/natural-voice.json.
 */

import * as Application from 'expo-application';
import { File, Paths } from 'expo-file-system';
import { Alert, AppState, Platform } from 'react-native';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import KokoroTts, {
  isKokoroAvailable,
  type KokoroDiagnostics,
  type KokoroLoadProgress,
  type KokoroLoadResult,
  type KokoroProgress,
} from '../../modules/kokoro-tts';
import { PerfGuard, slowStillApplies, type SlowRecord, type VersionStamp } from '@/lib/live-dictation/perf-guard';
import {
  canLoad,
  chooseEngine,
  countCrash,
  crashesStillApply,
  DOWNLOAD_BYTES,
  formatMB,
  isUnits,
  LOAD_TIMEOUT_MS,
  parseTimeouts,
  READ_WAIT_MS,
  REALTIME_MS_PER_SECOND,
  recordStillApplies,
  shortReason,
  shouldLoad,
  UNIT_LABEL,
  UNITS_ORDER,
  type CrashRecord,
  type EngineChoice,
  type NaturalState,
  type Units,
  type VersionRecord,
} from '@/lib/tts/engine';
import { readPieces, type ReadResult } from '@/lib/tts/reader';
import { formatReport, type LoadAttempt } from '@/lib/tts/report';
import { PRONUNCIATIONS, type SpeechPiece } from '@/lib/tts/spoken';
import { TtsLog, formatTtsEvent } from '@/lib/tts/tts-log';
import { resolveTtsVoice } from '@/lib/tts/voices';

import { diagnosticsFiles } from './history-files';
import { launchArg } from './launch-args';
import { liveStore } from './live-dictation';
import { remote } from './remote';

const FILE = 'natural-voice.json';
/** Extra time JS gives a native load past its own timeout before giving up on it. */
const JS_GRACE_MS = 15_000;
/** A memory warning this soon after a load does not unload it (the load itself raised the footprint). */
const MEMORY_GRACE_MS = 60_000;
const ATTEMPTS_KEPT = 12;

type LastLoad = { at: number; seconds: number; warmupMs: number; footprintMB: number; units?: Units };

type Persisted = {
  /** The person asked for the download (resume it after a relaunch until it finishes). */
  wanted: boolean;
  allowCellular: boolean;
  /** The first-use download offer was shown. */
  offered: boolean;
  slow: SlowRecord | null;
  crashes: CrashRecord | null;
  /** The model produced no usable audio with any compute unit on this app + iOS version. */
  broken: VersionRecord | null;
  /** Set while a reply is being read with the natural voice; found at launch = the app died mid-read. */
  readingSince: number | null;
  lastLoad: LastLoad | null;
  /** The compute units that loaded on this app + iOS version (tried first next time). */
  units: (VersionRecord & { units: Units }) | null;
  /** Every compute unit failed to load on this app + iOS version: off until Try again or an update. */
  loadFailure: (VersionRecord & { reason: string }) | null;
  /** Set while a load runs in the foreground; found at launch = the app died while loading. */
  loadingSince: { at: number; units: Units } | null;
  /** Compute units the app died while loading with on this app + iOS version: skipped. */
  loadCrashes: (VersionRecord & { units: Units[] }) | null;
  /** The newest load attempts (diagnostics), oldest first. */
  attempts: LoadAttempt[];
};

const DEFAULTS: Persisted = {
  wanted: false,
  allowCellular: false,
  offered: false,
  slow: null,
  crashes: null,
  broken: null,
  readingSince: null,
  lastLoad: null,
  units: null,
  loadFailure: null,
  loadingSince: null,
  loadCrashes: null,
  attempts: [],
};

export type NaturalStore = NaturalState & { bytesOnDisk: number; lastLoad: LastLoad | null };

export const naturalStore = createStore<NaturalStore>()(() => ({
  supported: false,
  model: 'absent',
  fraction: 0,
  damaged: false,
  loaded: false,
  loading: false,
  loadUnits: null,
  loadStartedAt: null,
  loadStage: null,
  loadFailure: null,
  slow: null,
  crashed: false,
  broken: false,
  waitingForWifi: false,
  error: null,
  bytesOnDisk: 0,
  lastLoad: null,
}));

export function useNaturalVoice<T>(selector: (s: NaturalStore) => T): T {
  return useStore(naturalStore, selector);
}

/** The read-aloud log (Settings › Voice › Diagnostics). QA: `-phiTtsLog 1` also prints each event (`[phi-tts] …`). */
export const ttsLog = new TtsLog({
  files: diagnosticsFiles,
  onEvent: launchArg('phiTtsLog') !== null ? (e) => console.log(`[phi-tts] ${formatTtsEvent(e)}`) : undefined,
});

type Run = { abandoned: boolean; backgrounded: boolean; promise: Promise<boolean> };

let persisted: Persisted = { ...DEFAULTS };
let stamp: VersionStamp = { appVersion: '', appBuild: '', osVersion: '' };
let started = false;
let downloading = false;
/** The load in progress (one at a time; ensureLoaded joins it). */
let current: Run | null = null;
let loadedAt = 0;
let guard = new PerfGuard(REALTIME_MS_PER_SECOND, 5);
let preloadTimer: ReturnType<typeof setTimeout> | null = null;
let timeouts: Record<Units, number> = { ...LOAD_TIMEOUT_MS };
let readWaitMs = READ_WAIT_MS;
let readingNow = false;
/** The first status read (at launch) is not a transition worth logging. */
let statusKnown = false;

function save(patch: Partial<Persisted>): void {
  persisted = { ...persisted, ...patch };
  try {
    new File(Paths.document, FILE).writeSync(JSON.stringify(persisted));
  } catch {}
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function versionRecord<T extends object>(v: unknown, extra: (o: Record<string, unknown>) => T | null): (VersionRecord & T) | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.appVersion !== 'string' || typeof o.appBuild !== 'string' || typeof o.osVersion !== 'string' || !isNum(o.at)) return null;
  const x = extra(o);
  return x ? { appVersion: o.appVersion, appBuild: o.appBuild, osVersion: o.osVersion, at: o.at, ...x } : null;
}

function loadPersisted(): Persisted {
  try {
    const f = new File(Paths.document, FILE);
    if (!f.exists) return { ...DEFAULTS };
    const v = JSON.parse(f.textSync()) as Partial<Persisted> & Record<string, unknown>;
    const since = v.loadingSince as { at?: unknown; units?: unknown } | null | undefined;
    return {
      ...DEFAULTS,
      ...v,
      wanted: v.wanted === true,
      allowCellular: v.allowCellular === true,
      offered: v.offered === true,
      readingSince: isNum(v.readingSince) ? v.readingSince : null,
      units: versionRecord(v.units, (o) => (isUnits(o.units) ? { units: o.units } : null)),
      loadFailure: versionRecord(v.loadFailure, (o) => (typeof o.reason === 'string' ? { reason: o.reason } : null)),
      loadCrashes: versionRecord(v.loadCrashes, (o) => (Array.isArray(o.units) ? { units: o.units.filter(isUnits) } : null)),
      loadingSince: since && isNum(since.at) && isUnits(since.units) ? { at: since.at, units: since.units } : null,
      attempts: Array.isArray(v.attempts) ? v.attempts.filter((a) => a && isUnits(a.units) && isNum(a.at)).slice(-ATTEMPTS_KEPT) : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** The native reason without Expo's "Calling the … function has failed → Caused by:" wrapper. */
export function errorMessage(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const i = text.lastIndexOf('Caused by:');
  return (i >= 0 ? text.slice(i + 'Caused by:'.length) : text).trim();
}

const errorCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

function chosenVoice(): string {
  return resolveTtsVoice(remote.store.getState().prefs.ttsVoice);
}

const active = () => AppState.currentState === 'active';

function describe(s: NaturalStore = naturalStore.getState()): string {
  const load = s.loaded ? `loaded (${s.loadUnits})` : s.loading ? `loading (${s.loadUnits})` : s.loadFailure ? `failed (${s.loadFailure})` : 'not loaded';
  return `model ${s.model}${s.damaged ? ' (damaged)' : ''}, ${load}`;
}

function refreshModelStatus(): void {
  if (!KokoroTts) return;
  try {
    const st = KokoroTts.getModelStatus();
    const s = naturalStore.getState();
    const patch: Partial<NaturalStore> = { bytesOnDisk: st.bytesOnDisk };
    let repair = false;
    if (st.ready) {
      if (s.model !== 'ready' || s.damaged) Object.assign(patch, { model: 'ready', fraction: 1, damaged: false });
    } else if (!downloading) {
      const damaged = st.damaged === true;
      Object.assign(patch, { model: 'absent', damaged, fraction: Math.min(0.99, st.bytesOnDisk / (st.downloadBytes || DOWNLOAD_BYTES)) });
      if (damaged && !s.damaged) {
        // Files went missing under a model that was ready (an earlier build could delete a bundle after a failed load):
        // download only the missing ones, on the same network rules as the first download.
        repair = true;
        ttsLog.record('model', `damaged: ${st.missing ?? '?'} file(s) missing; repairing`);
      }
      if (s.loaded || s.loading) unload('model files missing');
    }
    naturalStore.setState(patch);
    if (statusKnown && patch.model && patch.model !== s.model) ttsLog.record('model', `${s.model} → ${patch.model} (${formatMB(st.bytesOnDisk)} on disk)`);
    statusKnown = true;
    if (repair) {
      save({ wanted: true });
      resumeDownload();
    }
  } catch (e) {
    ttsLog.record('model', `status failed: ${errorMessage(e)}`);
  }
}

function updateWaiting(): void {
  const n = liveStore.getState().network;
  const waiting = downloading && !persisted.allowCellular && (n.expensive || n.constrained || n.connected === false);
  if (naturalStore.getState().waitingForWifi !== waiting) naturalStore.setState({ waitingForWifi: waiting });
}

function positive(v: string | null): number | null {
  const n = Number(v);
  return v !== null && Number.isFinite(n) && n > 0 ? n : null;
}

/** App start (bootstrap). */
export function initNaturalVoice(): void {
  if (started) return;
  started = true;
  persisted = loadPersisted();
  stamp = {
    appVersion: Application.nativeApplicationVersion ?? '0',
    appBuild: Application.nativeBuildVersion ?? '0',
    osVersion: String(Platform.Version),
  };
  timeouts = parseTimeouts(launchArg('phiTtsLoadTimeouts'));
  readWaitMs = positive(launchArg('phiTtsReadWaitMs')) ?? READ_WAIT_MS;
  void ttsLog.load();
  ttsLog.record('launch', `app ${stamp.appVersion} (${stamp.appBuild}), iOS ${stamp.osVersion}`);
  if (persisted.slow && !slowStillApplies(persisted.slow, stamp)) save({ slow: null });
  if (persisted.broken && !recordStillApplies(persisted.broken, stamp)) save({ broken: null });
  if (persisted.units && !recordStillApplies(persisted.units, stamp)) save({ units: null });
  if (persisted.loadFailure && !recordStillApplies(persisted.loadFailure, stamp)) save({ loadFailure: null });
  if (persisted.loadCrashes && !recordStillApplies(persisted.loadCrashes, stamp)) save({ loadCrashes: null });
  if (persisted.readingSince !== null) {
    save({ readingSince: null, crashes: countCrash(persisted.crashes, stamp, Date.now()) });
    ttsLog.record('guard', `the app stopped while reading (${persisted.crashes?.count ?? 0} on this version)`);
  }
  if (persisted.loadingSince) {
    // The app died while a load ran in the foreground (jetsam or a Core ML crash): skip those compute units from now on.
    const units = persisted.loadingSince.units;
    const prev = persisted.loadCrashes?.units ?? [];
    save({ loadingSince: null, loadCrashes: { ...stamp, at: Date.now(), units: [...new Set([...prev, units])] } });
    ttsLog.record('guard', `the app stopped while loading on the ${UNIT_LABEL[units]}: skipping it on this version`);
  }
  naturalStore.setState({
    supported: isKokoroAvailable(),
    slow: persisted.slow,
    crashed: crashesStillApply(persisted.crashes, stamp),
    broken: !!persisted.broken,
    loadFailure: persisted.loadFailure?.reason ?? null,
    lastLoad: persisted.lastLoad,
  });
  if (!KokoroTts || !naturalStore.getState().supported) {
    ttsLog.record('model', 'natural voice not supported here');
    return;
  }
  KokoroTts.addListener('onProgress', onProgress);
  KokoroTts.addListener('onLoadProgress', onLoadProgress);
  refreshModelStatus();
  ttsLog.record('model', `${describe()}, ${formatMB(naturalStore.getState().bytesOnDisk)} on disk`);
  liveStore.subscribe((s, prev) => {
    if (s.network !== prev.network) updateWaiting();
  });
  AppState.addEventListener('change', onAppState);
  AppState.addEventListener('memoryWarning', onMemoryWarning);
  resumeDownload();
  schedulePreload();
}

function onAppState(next: string): void {
  if (next === 'active') {
    ttsLog.record('foreground', describe());
    refreshModelStatus();
    resumeDownload();
    const units = naturalStore.getState().loadUnits;
    if (current && units) save({ loadingSince: { at: Date.now(), units } });
    schedulePreload();
  } else if (next === 'background') {
    ttsLog.record('background', describe());
    if (preloadTimer) clearTimeout(preloadTimer);
    preloadTimer = null;
    if (persisted.loadingSince) save({ loadingSince: null });
    // A load in progress finishes (or fails) on its own and is unloaded then if the app is still in the background.
    if (current) current.backgrounded = true;
    else unload('background');
  }
}

function onMemoryWarning(): void {
  const s = naturalStore.getState();
  if (current) ttsLog.record('memory', 'warning during a load: the load goes on');
  else if (readingNow) ttsLog.record('memory', 'warning while reading: kept');
  else if (!s.loaded) ttsLog.record('memory', 'warning');
  else if (Date.now() - loadedAt < MEMORY_GRACE_MS) ttsLog.record('memory', 'warning right after the load: kept');
  else {
    ttsLog.record('memory', 'warning: unloaded');
    unload('memory warning');
  }
}

function onProgress(e: KokoroProgress): void {
  const s = naturalStore.getState();
  if (e.phase === 'compiling') {
    // A late event after the download resolved must not take a ready model back to "preparing".
    if (downloading && s.model !== 'ready') naturalStore.setState({ model: 'compiling', fraction: 1 });
  } else if (s.model === 'downloading') naturalStore.setState({ fraction: e.fraction });
}

function onLoadProgress(e: KokoroLoadProgress): void {
  const s = naturalStore.getState();
  if (!current || e.units !== s.loadUnits) return;
  if (!e.done) naturalStore.setState({ loadStage: e.stage });
  else if ((e.ms ?? 0) >= 500) ttsLog.record('stage', `${e.units} ${e.stage}`, e.ms);
}

function resumeDownload(): void {
  if (persisted.wanted && naturalStore.getState().model === 'absent' && !downloading) void download();
}

/** Load a little after the app comes to the foreground (not competing with launch), when it would read. */
function schedulePreload(): void {
  if (preloadTimer) clearTimeout(preloadTimer);
  preloadTimer = setTimeout(() => {
    preloadTimer = null;
    if (active() && shouldLoad(chosenVoice(), naturalStore.getState())) void ensureLoaded();
  }, 1500);
}

async function download(): Promise<void> {
  if (!KokoroTts) return;
  downloading = true;
  const repair = naturalStore.getState().damaged;
  naturalStore.setState({ model: 'downloading', error: null });
  ttsLog.record('download', repair ? 'repair: fetching the missing files' : `start${persisted.allowCellular ? ' (cellular allowed)' : ''}`);
  updateWaiting();
  const t0 = Date.now();
  let ok = false;
  try {
    await KokoroTts.downloadModel({ allowCellular: persisted.allowCellular });
    save({ wanted: false });
    naturalStore.setState({ model: 'ready', fraction: 1, damaged: false });
    ok = true;
    ttsLog.record('download', 'done', Date.now() - t0);
  } catch (e) {
    const code = errorCode(e);
    naturalStore.setState({ model: 'absent' });
    ttsLog.record('download', `stopped: ${code ?? ''} ${errorMessage(e)}`, Date.now() - t0);
    if (code === 'ERR_KOKORO_NO_SPACE') {
      save({ wanted: false });
      naturalStore.setState({ error: errorMessage(e) });
    } else if (code !== 'ERR_KOKORO_CANCELLED') {
      naturalStore.setState({ error: 'download stopped, it resumes when you open the app' });
    }
  } finally {
    downloading = false;
    updateWaiting();
    refreshModelStatus();
  }
  // Load at once: the first read after the download must not find the model unloaded.
  if (ok && active() && shouldLoad(chosenVoice(), naturalStore.getState())) void ensureLoaded();
  else schedulePreload();
}

/** "Download": asks before using cellular; the download then runs (and resumes) on its own. */
export function requestNaturalDownload(): void {
  if (!KokoroTts || downloading) return;
  const n = liveStore.getState().network;
  const start = (allowCellular: boolean) => {
    save({ wanted: true, allowCellular, offered: true });
    void download();
  };
  if (n.expensive || n.constrained) {
    Alert.alert('Download on cellular?', `The natural voice is a ${formatMB(DOWNLOAD_BYTES)} download.`, [
      { text: 'Wait for Wi-Fi', onPress: () => start(false) },
      { text: 'Download now', onPress: () => start(true) },
    ]);
  } else start(false);
}

export function cancelNaturalDownload(): void {
  save({ wanted: false });
  ttsLog.record('download', 'cancel');
  KokoroTts?.cancelDownload();
}

export async function removeNaturalVoiceModel(): Promise<void> {
  save({ wanted: false, units: null, loadFailure: null, loadCrashes: null });
  unload('remove');
  ttsLog.record('model', 'remove');
  if (!KokoroTts) return;
  try {
    await KokoroTts.removeModel();
  } catch (e) {
    naturalStore.setState({ error: errorMessage(e) });
  }
  naturalStore.setState({ model: 'absent', fraction: 0, bytesOnDisk: 0, damaged: false, loadFailure: null });
  refreshModelStatus();
}

/** "Try again": clears every verdict (too slow, stopped, no audio, couldn't load, remembered compute units) and loads at once. */
export function retryNaturalVoice(): void {
  save({ slow: null, crashes: null, broken: null, loadFailure: null, loadCrashes: null, units: null });
  guard = new PerfGuard(REALTIME_MS_PER_SECOND, 5);
  naturalStore.setState({ slow: null, crashed: false, broken: false, error: null, loadFailure: null });
  ttsLog.record('retry', describe());
  refreshModelStatus();
  if (active() && shouldLoad(chosenVoice(), naturalStore.getState())) void ensureLoaded();
  else schedulePreload();
}

/** The first read-aloud without the model: offer the download once (Settings › Voice has it after that); true when shown. */
export function offerNaturalDownload(): boolean {
  if (persisted.offered || !KokoroTts || downloading) return false;
  save({ offered: true });
  Alert.alert(
    'Download the natural voice?',
    `Replies can be read in a natural voice that runs on this iPhone and works offline. It is a ${formatMB(DOWNLOAD_BYTES)} download; until then the system voice reads.`,
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Download', onPress: requestNaturalDownload },
    ],
  );
  return true;
}

/** The compute units to try, in order: the remembered ones first, without those the app died loading with. */
export function unitChain(): Units[] {
  const crashed = persisted.loadCrashes && recordStillApplies(persisted.loadCrashes, stamp) ? persisted.loadCrashes.units : [];
  const start = persisted.units && recordStillApplies(persisted.units, stamp) ? persisted.units.units : 'ane';
  return UNITS_ORDER.slice(UNITS_ORDER.indexOf(start)).filter((u) => !crashed.includes(u));
}

const TIMEOUT = Symbol('timeout');

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    p.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(TIMEOUT), ms);
    }),
  ]);
}

function recordAttempt(a: LoadAttempt): void {
  save({ attempts: [...persisted.attempts, a].slice(-ATTEMPTS_KEPT) });
}

const idle: Partial<NaturalStore> = { loading: false, loadStartedAt: null, loadStage: null };

/** Why every compute unit failed, short: "timed out (Neural Engine 120 s, GPU 60 s, CPU 60 s)" or the last error. */
function chainReason(failures: LoadAttempt[]): string {
  if (failures.every((f) => f.outcome === 'timeout')) {
    return `timed out (${failures.map((f) => `${UNIT_LABEL[f.units]} ${Math.round(f.ms / 1000)} s`).join(', ')})`;
  }
  const last = [...failures].reverse().find((f) => f.outcome !== 'timeout') ?? failures[failures.length - 1];
  const what = last.outcome === 'bad-audio' ? `no usable audio (${last.error ?? ''})` : (last.error ?? 'unknown error');
  return `${UNIT_LABEL[last.units]}: ${what}`;
}

async function runChain(run: Run, tts: NonNullable<typeof KokoroTts>): Promise<boolean> {
  const chain = unitChain();
  const mine = () => current === run && !run.abandoned;
  if (chain.length === 0) {
    const reason = 'the app stopped while loading it';
    save({ loadFailure: { ...stamp, at: Date.now(), reason } });
    naturalStore.setState({ ...idle, loadFailure: reason });
    ttsLog.record('load-fail', `no compute units left: ${reason}`);
    return false;
  }
  ttsLog.record('load', `start: ${chain.join(' → ')}`);
  const failures: LoadAttempt[] = [];
  for (const units of chain) {
    if (!mine()) return false;
    const timeoutMs = timeouts[units];
    const t0 = Date.now();
    run.backgrounded = !active();
    naturalStore.setState({ loading: true, loadUnits: units, loadStartedAt: t0, loadStage: null, error: null });
    if (active()) save({ loadingSince: { at: t0, units } });
    ttsLog.record('attempt', `${units} (timeout ${Math.round(timeoutMs / 1000)} s)`);
    let result: KokoroLoadResult | null = null;
    let err: unknown = null;
    try {
      result = await withTimeout(tts.load({ lexicon: { ...PRONUNCIATIONS }, units, timeoutMs }), timeoutMs + JS_GRACE_MS);
    } catch (e) {
      err = e;
    }
    const ms = Date.now() - t0;
    if (persisted.loadingSince) save({ loadingSince: null });
    if (!mine()) {
      // unload() / remove ran meanwhile: whatever native loaded is dropped there.
      if (result) tts.unload();
      recordAttempt({ at: t0, units, ms, outcome: 'unloaded' });
      return false;
    }
    if (result) {
      recordAttempt({ at: t0, units, ms, outcome: 'ok' });
      save({ units: { ...stamp, at: Date.now(), units }, loadFailure: null });
      const detail = `${result.adopted ? 'continued, ' : ''}load ${result.seconds.toFixed(1)} s, warm-up ${Math.round(result.warmupMs ?? 0)} ms, ${Math.round(result.footprintAfterMB ?? 0)} MB`;
      if (!active() && run.backgrounded) {
        // Finished while the app is in the background: free the memory; the next foreground loads it again (quick now).
        tts.unload();
        naturalStore.setState({ ...idle, loaded: false, loadUnits: null });
        ttsLog.record('loaded', `${units} in the background (${detail}); unloaded until the app is back`, ms);
        return false;
      }
      guard = new PerfGuard(REALTIME_MS_PER_SECOND, 5);
      loadedAt = Date.now();
      let lastLoad = naturalStore.getState().lastLoad;
      if (!result.alreadyLoaded) {
        lastLoad = { at: Date.now(), seconds: result.seconds, warmupMs: result.warmupMs ?? 0, footprintMB: result.footprintAfterMB ?? 0, units };
        save({ lastLoad });
      }
      naturalStore.setState({ ...idle, loaded: true, loadUnits: units, lastLoad, loadFailure: null, error: null });
      ttsLog.record('loaded', `${units}: ${detail}`, ms);
      return true;
    }
    const code = err === TIMEOUT ? 'JS_TIMEOUT' : errorCode(err);
    const message = err === TIMEOUT ? `no answer after ${Math.round((timeoutMs + JS_GRACE_MS) / 1000)} s` : errorMessage(err);
    if (code === 'ERR_KOKORO_UNLOADED' || code === 'ERR_KOKORO_NOT_DOWNLOADED') {
      recordAttempt({ at: t0, units, ms, outcome: 'unloaded', error: shortReason(message) });
      ttsLog.record('load-fail', `${units}: ${message}`, ms);
      naturalStore.setState({ ...idle, loadUnits: null });
      if (code === 'ERR_KOKORO_NOT_DOWNLOADED') refreshModelStatus();
      return false;
    }
    if (run.backgrounded || !active()) {
      // In the background iOS refuses GPU work and suspends the app: not a verdict on this iPhone. Next foreground retries.
      recordAttempt({ at: t0, units, ms, outcome: 'interrupted', error: shortReason(message) });
      ttsLog.record('load-fail', `${units} interrupted by the background: ${message}`, ms);
      naturalStore.setState({ ...idle, loadUnits: null });
      if (active()) schedulePreload();
      return false;
    }
    const outcome = code === 'JS_TIMEOUT' || code === 'ERR_KOKORO_LOAD_TIMEOUT' ? 'timeout' : code === 'ERR_KOKORO_BAD_AUDIO' ? 'bad-audio' : 'error';
    // Native gives up waiting on it too (a Core ML load cannot be interrupted; its result is dropped when it ends).
    if (code === 'JS_TIMEOUT') tts.unload();
    const attempt: LoadAttempt = { at: t0, units, ms, outcome, error: shortReason(message) };
    recordAttempt(attempt);
    failures.push(attempt);
    ttsLog.record('load-fail', `${units} ${outcome}: ${message}`, ms);
  }
  if (!mine()) return false;
  if (failures.every((f) => f.outcome === 'bad-audio')) {
    save({ broken: { ...stamp, at: Date.now() } });
    naturalStore.setState({ ...idle, loadUnits: null, broken: true });
    ttsLog.record('guard', 'no usable audio with any compute unit: off until Try again or an update');
    return false;
  }
  const reason = chainReason(failures);
  save({ loadFailure: { ...stamp, at: Date.now(), reason } });
  naturalStore.setState({ ...idle, loadUnits: null, loadFailure: reason });
  ttsLog.record('load-fail', `every compute unit failed: ${reason}`);
  return false;
}

/** Loads the model (once; callers join a load in progress); true when it is ready to read. */
export function ensureLoaded(): Promise<boolean> {
  const tts = KokoroTts;
  if (!tts) return Promise.resolve(false);
  const s = naturalStore.getState();
  if (s.loaded) return Promise.resolve(true);
  if (current) return current.promise;
  if (!canLoad(s)) return Promise.resolve(false);
  const run: Run = { abandoned: false, backgrounded: !active(), promise: Promise.resolve(false) };
  current = run;
  run.promise = runChain(run, tts)
    .catch((e) => {
      ttsLog.record('load-fail', `unexpected: ${errorMessage(e)}`);
      if (current === run) naturalStore.setState({ ...idle, loadUnits: null, error: `could not load: ${errorMessage(e)}` });
      return false;
    })
    .finally(() => {
      if (current === run) current = null;
    });
  return run.promise;
}

/** Frees the model (~190 MB) and drops a load in progress; the next read or foreground loads it again (a second or two). */
export function unload(why = 'unload'): void {
  if (preloadTimer) clearTimeout(preloadTimer);
  preloadTimer = null;
  if (current) {
    current.abandoned = true;
    current = null;
  }
  if (persisted.loadingSince) save({ loadingSince: null });
  if (!KokoroTts) return;
  KokoroTts.stop();
  KokoroTts.unload();
  const s = naturalStore.getState();
  if (s.loaded || s.loading) {
    naturalStore.setState({ ...idle, loaded: false, loadUnits: null });
    ttsLog.record('unload', why);
  }
}

/**
 * Which voice reads now. When the natural voice is wanted but not loaded, starts (or joins) the
 * load and waits up to `waitMs` for it; `choice.detail` carries a load failure's reason.
 */
export async function naturalChoice(waitMs = readWaitMs): Promise<{ choice: EngineChoice; voice: string }> {
  const voice = chosenVoice();
  let choice = chooseEngine(voice, naturalStore.getState());
  if (choice.engine === 'system' && choice.reason === 'preparing' && KokoroTts) {
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      ensureLoaded(),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), waitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    choice = chooseEngine(voice, naturalStore.getState());
    ttsLog.record('read', `${choice.engine === 'natural' ? 'natural voice' : `system voice (${choice.reason})`} after waiting for the load`, Date.now() - t0);
  } else if (choice.engine === 'system' && choice.reason !== 'chosen') {
    ttsLog.record('read', `system voice (${choice.reason}${choice.detail ? `: ${choice.detail}` : ''})`);
  }
  return { choice, voice };
}

/**
 * Reads pieces with the natural voice. On 'slow' the verdict is saved (later replies use the
 * system voice); the caller reads `pieces.slice(result.next)` with the system voice.
 */
export async function readNatural(
  pieces: SpeechPiece[],
  voice: string,
  rate: number,
  cancelled: () => boolean,
): Promise<ReadResult> {
  if (!KokoroTts) return { outcome: 'error', next: 0, error: new Error('unavailable') };
  const tts = KokoroTts;
  readingNow = true;
  save({ readingSince: Date.now() });
  const t0 = Date.now();
  let firstMs = -1;
  try {
    const result = await readPieces(pieces, {
      synthesize: (p) =>
        tts.synthesize(p.text, { voice, speed: rate, pause: p.pause }).then((r) => {
          if (firstMs < 0) firstMs = Date.now() - t0;
          return r;
        }),
      play: (id) => tts.play(id),
      cancelled,
      // Milliseconds of synthesis per second of speech (the audio already reflects the rate): above 1000 = slower than real time.
      timing: (ms, seconds) => seconds > 0 && guard.observe(ms / seconds) === 'slow',
    });
    ttsLog.record(
      'read',
      `natural ${voice} ${result.outcome}: ${result.next}/${pieces.length} pieces, first piece ${firstMs} ms${result.error ? `, ${errorMessage(result.error)}` : ''}`,
      Date.now() - t0,
    );
    if (result.outcome === 'slow') {
      const slow: SlowRecord = { ...stamp, at: Date.now(), medianMs: Math.round(guard.observed.slice().sort((a, b) => a - b)[2] ?? 0) };
      save({ slow });
      naturalStore.setState({ slow });
      ttsLog.record('guard', `too slow (median ${slow.medianMs} ms per second of speech)`);
      unload('too slow');
    } else if (result.outcome === 'error' && errorCode(result.error) === 'ERR_KOKORO_NOT_LOADED') {
      // Native lost the model (unloaded under us): the next read loads it again.
      naturalStore.setState({ ...idle, loaded: false, loadUnits: null });
    }
    return result;
  } finally {
    readingNow = false;
    save({ readingSince: null });
  }
}

export function stopNatural(): void {
  KokoroTts?.stop();
}

export function naturalVersionStamp(): VersionStamp {
  return stamp;
}

/** Settings › Voice › Diagnostics: everything about the natural voice on this phone, as text to copy. */
export async function naturalVoiceReport(now = Date.now()): Promise<string> {
  let native: KokoroDiagnostics | null = null;
  let nativeError: string | null = null;
  if (KokoroTts) {
    try {
      native = await withTimeout(KokoroTts.diagnostics(), 5_000);
    } catch (e) {
      nativeError = e === TIMEOUT ? 'no answer in 5 s' : errorMessage(e);
    }
  } else nativeError = 'native module missing';
  const s = naturalStore.getState();
  return formatReport({
    now,
    app: { version: stamp.appVersion, build: stamp.appBuild },
    os: String(Platform.Version),
    voice: chosenVoice(),
    state: s,
    timeouts,
    readWaitMs,
    chain: unitChain(),
    remembered: persisted.units && recordStillApplies(persisted.units, stamp) ? persisted.units.units : null,
    loadCrashes: persisted.loadCrashes?.units ?? [],
    crashes: persisted.crashes?.count ?? 0,
    attempts: persisted.attempts,
    native,
    nativeError,
    events: ttsLog.events(50),
  });
}
