/**
 * Live dictation (Phonon-2 on the Neural Engine): the model lifecycle behind Settings › Voice ›
 * Live dictation, and the numbers on its details screen.
 *
 * Off by default. Turning it on downloads the model (Wi-Fi only unless "Download on cellular"),
 * then prepares it (the one-time Neural Engine compile, then well under a second per launch).
 * Both run in the background whenever the app comes to the foreground with the toggle on, and
 * resume after a relaunch. Until the model is ready, dictation uses SpeechAnalyzer
 * (`src/services/dictation.ts`). State lives in a zustand store; settings, the "too slow" verdict
 * and diagnostics persist in Documents/live-dictation.json (no transcript text).
 */

import * as Application from 'expo-application';
import { File, Paths } from 'expo-file-system';
import { AppState } from 'react-native';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import PhononStt, { isPhononAvailable, type PhononNetwork, type PhononProgress } from '../../modules/phonon-stt';
import { pushSession, type DownloadDiag, type PrepareDiag, type SessionDiag } from '@/lib/live-dictation/diagnostics';
import { isEnglishLocale, liveWanted } from '@/lib/live-dictation/engine';
import { slowStillApplies, type SlowRecord, type VersionStamp } from '@/lib/live-dictation/perf-guard';
import { nextAction, type LiveState, type NetworkState } from '@/lib/live-dictation/status';

const FILE = 'live-dictation.json';

type Persisted = {
  enabled: boolean;
  cellular: boolean;
  forceEnglish: boolean;
  slow: SlowRecord | null;
  /** A prepare finished for this app build + OS build: later launches skip the Neural Engine compile. */
  goodPrepare: { appBuild: string; osVersionString: string } | null;
  /** Set while prepare() runs; found at launch = the app died mid-prepare. */
  prepareInFlight: boolean;
  interruptedPrepares: number;
  lastPrepare: PrepareDiag | null;
  lastDownload: DownloadDiag | null;
  sessions: SessionDiag[];
  lastError: { at: number; message: string } | null;
};

const DEFAULTS: Persisted = {
  enabled: false,
  cellular: false,
  forceEnglish: false,
  slow: null,
  goodPrepare: null,
  prepareInFlight: false,
  interruptedPrepares: 0,
  lastPrepare: null,
  lastDownload: null,
  sessions: [],
  lastError: null,
};

export type LiveStore = LiveState &
  Omit<Persisted, 'goodPrepare' | 'prepareInFlight' | 'interruptedPrepares'> & {
    deviceEnglish: boolean;
    bytesOnDisk: number;
    downloadBytes: number;
    revision: string;
    osVersionString: string;
    loaded: boolean;
  };

const DOWNLOAD_BYTES = 345_010_107;
const REVISION = '48af304c8db8bcc25307c206c199612f48479954';

function deviceLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return 'en-US';
  }
}

const initialNetwork: NetworkState = { connected: null, expensive: false, constrained: false };

export const liveStore = createStore<LiveStore>()(() => ({
  supported: false,
  enabled: false,
  cellular: false,
  english: isEnglishLocale(deviceLocale()),
  deviceEnglish: isEnglishLocale(deviceLocale()),
  forceEnglish: false,
  slow: null,
  model: 'absent',
  fraction: 0,
  prepare: 'idle',
  coldPrepare: true,
  error: null,
  network: initialNetwork,
  lastPrepare: null,
  lastDownload: null,
  sessions: [],
  lastError: null,
  bytesOnDisk: 0,
  downloadBytes: DOWNLOAD_BYTES,
  revision: REVISION,
  osVersionString: '',
  loaded: false,
}));

export function useLiveDictation<T>(selector: (s: LiveStore) => T): T {
  return useStore(liveStore, selector);
}

/** The model is loaded and live dictation is wanted: new dictations use Phonon. */
export function phononReady(s: LiveStore = liveStore.getState()): boolean {
  return liveWanted({ phononSupported: s.supported, enabled: s.enabled, slow: !!s.slow, english: s.english }) && s.prepare === 'prepared';
}

let persisted: Persisted = { ...DEFAULTS };
let stamp: VersionStamp = { appVersion: '', appBuild: '', osVersion: '' };
let started = false;
let downloading = false;
let preparing = false;
/** Bumped by "Remove model": a prepare that finishes after it is discarded. */
let generation = 0;

function save(patch: Partial<Persisted>): void {
  persisted = { ...persisted, ...patch };
  try {
    new File(Paths.document, FILE).writeSync(JSON.stringify(persisted));
  } catch {}
}

function load(): Persisted {
  try {
    const f = new File(Paths.document, FILE);
    if (!f.exists) return { ...DEFAULTS };
    const v = JSON.parse(f.textSync()) as Partial<Persisted>;
    return {
      ...DEFAULTS,
      ...v,
      enabled: v.enabled === true,
      cellular: v.cellular === true,
      forceEnglish: v.forceEnglish === true,
      sessions: Array.isArray(v.sessions) ? v.sessions.slice(0, 5) : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function toNetwork(n: PhononNetwork | null | undefined): NetworkState {
  if (!n || n.known === false || typeof n.connected !== 'boolean') return initialNetwork;
  return { connected: n.connected, expensive: !!n.expensive, constrained: !!n.constrained };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function setError(message: string | null): void {
  liveStore.setState({ error: message });
  if (message) {
    const lastError = { at: Date.now(), message };
    save({ lastError });
    liveStore.setState({ lastError });
  }
}

function refreshModelStatus(): void {
  if (!PhononStt) return;
  try {
    const st = PhononStt.getModelStatus();
    const total = st.downloadBytes || DOWNLOAD_BYTES;
    const s = liveStore.getState();
    const patch: Partial<LiveStore> = { bytesOnDisk: st.bytesOnDisk, downloadBytes: total, revision: st.revision ?? REVISION };
    if (st.ready) {
      if (s.model !== 'downloaded') patch.model = 'downloaded';
      if (st.prepared) patch.prepare = 'prepared';
    } else if (!downloading) {
      patch.model = 'absent';
      patch.fraction = Math.min(0.99, st.bytesOnDisk / total);
    }
    liveStore.setState(patch);
  } catch {}
}

/** App start (bootstrap): load settings, watch the network and app state, resume the lifecycle. */
export function initLiveDictation(): void {
  if (started) return;
  started = true;
  persisted = load();
  const supported = isPhononAvailable();
  let osVersionString = '';
  if (supported && PhononStt) {
    try {
      osVersionString = PhononStt.getDeviceInfo().osVersionString;
    } catch {}
  }
  stamp = {
    appVersion: Application.nativeApplicationVersion ?? '0',
    appBuild: Application.nativeBuildVersion ?? '0',
    osVersion: osVersionString,
  };
  // A "too slow" verdict lasts until the app or iOS version changes.
  if (persisted.slow && !slowStillApplies(persisted.slow, stamp)) save({ slow: null });
  // The app died while preparing (a jetsam during the Neural Engine compile?): retry, but not forever.
  if (persisted.prepareInFlight) save({ prepareInFlight: false, interruptedPrepares: persisted.interruptedPrepares + 1 });
  const interrupted = persisted.interruptedPrepares >= 2;
  const deviceEnglish = isEnglishLocale(deviceLocale());
  liveStore.setState({
    supported,
    enabled: persisted.enabled,
    cellular: persisted.cellular,
    forceEnglish: persisted.forceEnglish,
    deviceEnglish,
    english: deviceEnglish || persisted.forceEnglish,
    slow: persisted.slow,
    coldPrepare: !isWarm(),
    lastPrepare: persisted.lastPrepare,
    lastDownload: persisted.lastDownload,
    sessions: persisted.sessions,
    lastError: persisted.lastError,
    osVersionString,
    prepare: interrupted ? 'failed' : 'idle',
    error: interrupted ? 'Preparing was interrupted twice' : null,
    loaded: true,
  });
  if (!supported || !PhononStt) return;
  liveStore.setState({ network: toNetwork(PhononStt.getNetworkStatus()) });
  refreshModelStatus();
  PhononStt.addListener('onNetwork', (n) => {
    const before = liveStore.getState().network;
    const network = toNetwork(n);
    if (before.connected === network.connected && before.expensive === network.expensive && before.constrained === network.constrained) return;
    liveStore.setState({ network });
    // Download on cellular off and Wi-Fi went away mid-download: the OS pauses it; nothing to do.
    tick();
  });
  PhononStt.addListener('onProgress', onProgress);
  AppState.addEventListener('change', (next) => {
    if (next === 'active') {
      refreshModelStatus();
      tick();
    }
  });
  tick();
}

function isWarm(): boolean {
  const g = persisted.goodPrepare;
  return !!g && g.appBuild === stamp.appBuild && g.osVersionString === stamp.osVersion;
}

function onProgress(e: PhononProgress): void {
  if (e.phase === 'download' && typeof e.fraction === 'number') {
    if (liveStore.getState().model !== 'downloading') return;
    liveStore.setState({ fraction: e.fraction });
  } else if (e.phase === 'compiling') {
    liveStore.setState({ model: 'compiling', fraction: 1 });
  }
}

/** Starts whatever the state allows next (download or prepare); safe to call any time. */
export function tick(): void {
  const s = liveStore.getState();
  if (AppState.currentState === 'background') return;
  const action = nextAction(s);
  if (action === 'download' && !downloading) void download();
  else if (action === 'prepare' && !preparing) void prepare();
}

async function download(): Promise<void> {
  if (!PhononStt) return;
  downloading = true;
  const started = Date.now();
  liveStore.setState({ model: 'downloading', error: null });
  try {
    const r = await PhononStt.downloadModel({ allowCellular: liveStore.getState().cellular });
    const lastDownload = { at: Date.now(), seconds: r.seconds ?? (Date.now() - started) / 1000 };
    save({ lastDownload });
    liveStore.setState({ model: 'downloaded', fraction: 1, lastDownload });
  } catch (e) {
    const code = (e as { code?: string }).code;
    liveStore.setState({ model: 'absent' });
    if (code !== 'ERR_PHONON_CANCELLED') setError(`download stopped: ${errorMessage(e)}`);
  } finally {
    downloading = false;
    refreshModelStatus();
  }
  tick();
}

async function prepare(): Promise<void> {
  if (!PhononStt) return;
  preparing = true;
  const cold = !isWarm();
  liveStore.setState({ prepare: 'preparing', coldPrepare: cold, error: null });
  save({ prepareInFlight: true });
  const t0 = Date.now();
  const gen = generation;
  try {
    const r = await PhononStt.prepare(null, {});
    if (!liveStore.getState().enabled || gen !== generation) {
      // turned off while it was loading
      PhononStt.unload();
      liveStore.setState({ prepare: 'idle' });
      save({ prepareInFlight: false });
      return;
    }
    const patch: Partial<Persisted> = {
      prepareInFlight: false,
      interruptedPrepares: 0,
      goodPrepare: { appBuild: stamp.appBuild, osVersionString: stamp.osVersion },
    };
    if (!r.alreadyPrepared) {
      patch.lastPrepare = {
        at: Date.now(),
        seconds: (Date.now() - t0) / 1000,
        modelCompileSeconds: null,
        functionSeconds: r.functionLoadSeconds ?? {},
        computeUnits: r.computeUnits ?? 'cpuAndNeuralEngine',
        footprintBeforeMB: r.footprintBeforeMB ?? null,
        footprintAfterMB: r.footprintAfterMB ?? null,
        footprintPeakMB: r.footprintPeakMB ?? null,
        thermalStart: r.thermalStart ?? null,
        thermalEnd: r.thermalEnd ?? null,
        osVersionString: stamp.osVersion,
        appBuild: stamp.appBuild,
      };
    }
    save(patch);
    liveStore.setState({ prepare: 'prepared', coldPrepare: false, ...(patch.lastPrepare ? { lastPrepare: patch.lastPrepare } : {}) });
  } catch (e) {
    save({ prepareInFlight: false });
    liveStore.setState({ prepare: 'failed' });
    setError(`prepare failed: ${errorMessage(e)}`);
  } finally {
    preparing = false;
  }
}

// ---- settings actions ----

export function setLiveDictationEnabled(on: boolean): void {
  save({ enabled: on, ...(on ? { slow: null, interruptedPrepares: 0 } : {}) });
  const s = liveStore.getState();
  if (on) {
    liveStore.setState({ enabled: true, slow: null, error: null, prepare: s.prepare === 'failed' ? 'idle' : s.prepare });
    tick();
    return;
  }
  liveStore.setState({ enabled: false, error: null });
  if (!PhononStt) return;
  if (downloading) PhononStt.cancelDownload();
  // Free the loaded model (~110 MB); the files stay so turning it back on is quick.
  if (s.prepare === 'prepared') {
    PhononStt.unload();
    liveStore.setState({ prepare: 'idle' });
  }
}

export function setLiveDictationCellular(on: boolean): void {
  save({ cellular: on });
  liveStore.setState({ cellular: on });
  // A running download keeps the network rule it started with: restart it (it resumes from the bytes on disk).
  if (downloading && PhononStt) PhononStt.cancelDownload();
  else tick();
}

export function setLiveDictationForceEnglish(on: boolean): void {
  save({ forceEnglish: on });
  liveStore.setState({ forceEnglish: on, english: liveStore.getState().deviceEnglish || on });
  tick();
}

/** "Remove model": turns live dictation off and deletes the model (and any partial download). */
export async function removeLiveDictationModel(): Promise<void> {
  generation += 1;
  save({ enabled: false });
  liveStore.setState({ enabled: false, error: null });
  if (!PhononStt) return;
  try {
    await PhononStt.removeModel();
  } catch (e) {
    setError(`remove failed: ${errorMessage(e)}`);
  }
  liveStore.setState({ model: 'absent', fraction: 0, prepare: 'idle', bytesOnDisk: 0 });
  refreshModelStatus();
  tick();
}

/** The performance guard tripped: off on this iPhone until re-enabled or the app/OS version changes. */
export function markLiveDictationSlow(medianMs: number): void {
  const slow: SlowRecord = { ...stamp, at: Date.now(), medianMs: Math.round(medianMs) };
  save({ slow });
  liveStore.setState({ slow });
}

/** After the session that tripped the guard: free the (CPU-path, possibly GBs) model. */
export function unloadLiveDictationModel(): void {
  if (!PhononStt) return;
  PhononStt.unload();
  if (liveStore.getState().prepare === 'prepared') liveStore.setState({ prepare: 'idle' });
}

export function recordLiveSession(diag: SessionDiag): void {
  const sessions = pushSession(persisted.sessions, diag);
  save({ sessions });
  liveStore.setState({ sessions });
}

/** A dictation-session error: kept for the details screen, not shown in the status line. */
export function recordLiveError(message: string): void {
  const lastError = { at: Date.now(), message };
  save({ lastError });
  liveStore.setState({ lastError });
}

export function liveVersionStamp(): VersionStamp {
  return stamp;
}
