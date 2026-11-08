/**
 * The natural voice's lifecycle (services/natural-voice.ts) against a fake native module: download →
 * load → read, the compute-unit fallback chain and its timeouts, background / memory warnings, the
 * crash marker, repair and the diagnostics report. Several reproduce a pre-release failure where
 * the app never got past "Natural voice getting ready" on a device.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createFakeKokoro, FAKE_NATIVE_FUNCTIONS, loadResult } from '@/lib/tts/__fixtures__/fake-kokoro';
import { statusLine, systemNotice } from '@/lib/tts/engine';

type NV = typeof import('../natural-voice');

const mockNative = createFakeKokoro();
const mockFiles = new Map<string, string>();
const mockArgs: Record<string, string> = {};
const mockPrefs: { ttsVoice?: string } = {};
const mockAppState = {
  currentState: 'active',
  listeners: new Map<string, Set<(s?: string) => void>>(),
  addEventListener(type: string, fn: (s?: string) => void) {
    if (!mockAppState.listeners.has(type)) mockAppState.listeners.set(type, new Set());
    mockAppState.listeners.get(type)!.add(fn);
    return { remove: () => mockAppState.listeners.get(type)?.delete(fn) };
  },
  set(state: string) {
    mockAppState.currentState = state;
    for (const fn of mockAppState.listeners.get('change') ?? []) fn(state);
  },
  memoryWarning() {
    for (const fn of mockAppState.listeners.get('memoryWarning') ?? []) fn();
  },
};

jest.mock('../../../modules/kokoro-tts', () => ({ __esModule: true, default: mockNative, isKokoroAvailable: () => true }));
jest.mock('expo-application', () => ({ nativeApplicationVersion: '0.1.0', nativeBuildVersion: '42' }));
jest.mock('expo-file-system', () => {
  class File {
    path: string;
    constructor(dir: string, name: string) {
      this.path = `${dir}/${name}`;
    }
    get exists() {
      return mockFiles.has(this.path);
    }
    textSync() {
      return mockFiles.get(this.path) ?? '';
    }
    writeSync(s: string) {
      mockFiles.set(this.path, s);
    }
  }
  return { File, Paths: { document: 'doc' }, Directory: class {} };
});
jest.mock('react-native', () => ({
  AppState: mockAppState,
  Alert: { alert: jest.fn() },
  Platform: { OS: 'ios', Version: '26.1' },
}));
jest.mock('../remote', () => ({ remote: { store: { getState: () => ({ prefs: { ...mockPrefs } }) } } }));
jest.mock('../live-dictation', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createStore } = require('zustand/vanilla');
  return { liveStore: createStore(() => ({ network: { connected: true, expensive: false, constrained: false } })) };
});
jest.mock('../history-files', () => ({
  diagnosticsFiles: {
    read: async (name: string) => mockFiles.get(`diag/${name}`) ?? null,
    write: async (name: string, data: string) => void mockFiles.set(`diag/${name}`, data),
    remove: async (name: string) => void mockFiles.delete(`diag/${name}`),
  },
}));
jest.mock('../launch-args', () => ({ launchArg: (k: string) => mockArgs[k] ?? null }));

/** A fresh app process (module state reset; files and the fake native module persist). */
function launch(): NV {
  mockAppState.listeners.clear();
  mockAppState.currentState = 'active';
  mockNative.dropListeners();
  let mod!: NV;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../natural-voice');
  });
  mod.initNaturalVoice();
  return mod;
}

const tick = (ms = 0) => jest.advanceTimersByTimeAsync(ms);
const state = (nv: NV) => nv.naturalStore.getState();
const units = () => mockNative.loads.map((l) => l.options.units);

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-11-05T12:00:00Z') });
  mockNative.reset();
  mockFiles.clear();
  for (const k of Object.keys(mockArgs)) delete mockArgs[k];
  delete mockPrefs.ttsVoice;
  mockAppState.currentState = 'active';
  mockAppState.listeners.clear();
});

afterEach(() => {
  jest.useRealTimers();
});

/**
 * Regressions against the pre-release API (which lacked compute-unit selection).
 * The fixtures cover eight failure paths that the current fallback chain handles.
 */
describe('regressions: why the natural voice never got past "getting ready"', () => {
  /** Rejects every load the app starts (the old build tried once, the new one walks its fallback chain). */
  async function failEveryLoad(message: string) {
    for (let i = 0; i < 10 && mockNative.pending().length; i++) {
      mockNative.rejectLoad('ERR_KOKORO_LOAD_FAILED', message);
      await tick(0);
    }
  }
  async function resolveEveryLoad() {
    for (let i = 0; i < 10 && mockNative.pending().length; i++) {
      mockNative.resolveLoad(loadResult());
      await tick(0);
    }
  }

  it('a load that fails is not reported as "getting ready"', async () => {
    const nv = launch();
    await tick(1500);
    expect(mockNative.load).toHaveBeenCalled();
    await failEveryLoad('Failed to build the model execution plan (error code: -5)');
    const { choice } = await nv.naturalChoice();
    expect(choice).toMatchObject({ engine: 'system', reason: 'load-failed' });
    expect((choice as { detail?: string }).detail).toMatch(/Failed to build the model execution plan/);
  });

  it('a load that never answers does not leave it loading forever', async () => {
    const nv = launch();
    await tick(1500);
    expect(state(nv).loading).toBe(true);
    await tick(10 * 60_000);
    expect(state(nv).loading).toBe(false);
    expect(state(nv).loadFailure ?? state(nv).error).toMatch(/timed out/);
  });

  it('a trip to the background during the load does not throw the load away', async () => {
    // That build's native load went on after unload() and resolved; the app then threw the result away.
    mockNative.unloadRejectsLoads = false;
    const nv = launch();
    await tick(1500);
    mockAppState.set('background');
    mockAppState.set('active');
    await tick(2000);
    await resolveEveryLoad();
    await tick(2000);
    await resolveEveryLoad();
    expect(state(nv).loaded).toBe(true);
  });

  it('a memory warning during the load does not throw the load away', async () => {
    const nv = launch();
    await tick(1500);
    mockAppState.memoryWarning();
    await resolveEveryLoad();
    expect(state(nv).loaded).toBe(true);
  });

  it('the read that finds it unloaded waits long enough for a warm load (~3 s)', async () => {
    mockPrefs.ttsVoice = 'system';
    const nv = launch();
    await tick(2000);
    mockPrefs.ttsVoice = 'af_heart';
    const choice = nv.naturalChoice();
    await tick(2800);
    await resolveEveryLoad();
    await expect(choice).resolves.toMatchObject({ choice: { engine: 'natural' } });
  });

  it('a late "compiling" event after the download does not take the model back to preparing', async () => {
    mockNative.status = { ready: false, bytesOnDisk: 0, downloadBytes: 226_869_788 };
    const nv = launch();
    nv.requestNaturalDownload();
    mockNative.status = { ready: true, bytesOnDisk: 216_000_000, downloadBytes: 226_869_788 };
    mockNative.downloads[0].resolve({ seconds: 30, dir: '/x' });
    await tick(0);
    mockNative.emit('onProgress', { phase: 'compiling', fraction: 1 });
    expect(state(nv).model).toBe('ready');
  });

  it('the download finishing in the foreground starts the load right away', async () => {
    mockNative.status = { ready: false, bytesOnDisk: 0, downloadBytes: 226_869_788 };
    const nv = launch();
    nv.requestNaturalDownload();
    mockNative.status = { ready: true, bytesOnDisk: 216_000_000, downloadBytes: 226_869_788 };
    mockNative.downloads[0].resolve({ seconds: 30, dir: '/x' });
    await tick(100);
    expect(mockNative.load).toHaveBeenCalledTimes(1);
    expect(state(nv).loading).toBe(true);
  });

  it('a model whose files went missing under the ready marker is repaired', async () => {
    mockNative.status = { ready: false, damaged: true, missing: 2, bytesOnDisk: 200_000_000, downloadBytes: 226_869_788 };
    launch();
    await tick(2000);
    expect(mockNative.downloadModel).toHaveBeenCalledTimes(1);
  });
});

describe('natural voice: loading after the download', () => {
  it('starts the load as soon as the download finishes in the foreground', async () => {
    mockNative.status = { ready: false, bytesOnDisk: 0, downloadBytes: 226_869_788 };
    const nv = launch();
    await tick(2000);
    expect(mockNative.load).not.toHaveBeenCalled();
    nv.requestNaturalDownload();
    expect(mockNative.downloadModel).toHaveBeenCalledTimes(1);
    mockNative.emit('onProgress', { phase: 'compiling', fraction: 1 });
    expect(state(nv).model).toBe('compiling');
    mockNative.status = { ready: true, bytesOnDisk: 216_000_000, downloadBytes: 226_869_788 };
    mockNative.downloads[0].resolve({ seconds: 30, dir: '/x' });
    await tick(0);
    expect(state(nv).model).toBe('ready');
    // No foreground transition needed, no 1.5 s wait.
    expect(mockNative.load).toHaveBeenCalledTimes(1);
    expect(units()).toEqual(['ane']);
    expect(state(nv).loading).toBe(true);
    // A late "compiling" event must not take the ready model back to preparing.
    mockNative.emit('onProgress', { phase: 'compiling', fraction: 1 });
    expect(state(nv).model).toBe('ready');
    mockNative.resolveLoad();
    await tick(0);
    expect(state(nv).loaded).toBe(true);
    expect(statusLine(state(nv)).label).toBe('Loaded · Neural Engine');
  });

  it('loads on its own after a relaunch with the model on disk', async () => {
    const nv = launch();
    await tick(1500);
    expect(units()).toEqual(['ane']);
    mockNative.resolveLoad();
    await tick(0);
    expect(state(nv).loaded).toBe(true);
  });

  it('does not load when the system voice is chosen', async () => {
    mockPrefs.ttsVoice = 'system';
    launch();
    await tick(5000);
    expect(mockNative.load).not.toHaveBeenCalled();
  });
});

describe('natural voice: a read finds it not loaded', () => {
  it('starts the load and waits up to 3 s for it', async () => {
    mockPrefs.ttsVoice = 'system';
    const nv = launch();
    await tick(5000);
    mockPrefs.ttsVoice = 'af_heart';
    const choice = nv.naturalChoice();
    await tick(0);
    expect(mockNative.load).toHaveBeenCalledTimes(1);
    await tick(2900);
    mockNative.resolveLoad();
    await tick(0);
    await expect(choice).resolves.toEqual({ choice: { engine: 'natural' }, voice: 'af_heart' });
  });

  it('falls back with "preparing" when the load takes longer, and the next read uses the natural voice', async () => {
    mockPrefs.ttsVoice = 'system';
    const nv = launch();
    mockPrefs.ttsVoice = 'af_heart';
    const first = nv.naturalChoice();
    await tick(3100);
    await expect(first).resolves.toEqual({ choice: { engine: 'system', reason: 'preparing' }, voice: 'af_heart' });
    expect(systemNotice('preparing')).toMatch(/first time can take a minute/);
    expect(statusLine(state(nv), Date.now()).label).toBe('Preparing the voice (the first time can take a minute)… 3 s');
    await tick(40_000);
    mockNative.resolveLoad();
    await tick(0);
    const second = nv.naturalChoice();
    await expect(second).resolves.toEqual({ choice: { engine: 'natural' }, voice: 'af_heart' });
    expect(mockNative.load).toHaveBeenCalledTimes(1);
  });

  it('a read waiting time can be set with -phiTtsReadWaitMs (QA)', async () => {
    mockArgs.phiTtsReadWaitMs = '500';
    mockPrefs.ttsVoice = 'system';
    const nv = launch();
    mockPrefs.ttsVoice = 'af_heart';
    const choice = nv.naturalChoice();
    await tick(600);
    await expect(choice).resolves.toMatchObject({ choice: { engine: 'system', reason: 'preparing' } });
  });
});

describe('natural voice: failures are visible and never leave it loading', () => {
  it('a load that fails on every compute unit says why (not "getting ready") until Try again', async () => {
    const nv = launch();
    await tick(1500);
    mockNative.rejectLoad('ERR_KOKORO_LOAD_FAILED', 'E5RT: Failed to compile the model for the Neural Engine (11)');
    await tick(0);
    mockNative.rejectLoad('ERR_KOKORO_LOAD_FAILED', 'Metal: insufficient memory');
    await tick(0);
    mockNative.rejectLoad('ERR_KOKORO_LOAD_FAILED', 'Missing model KokoroAlbert at /var/mobile/Containers/Data/Application/X/Library/KokoroAlbert.mlmodelc');
    await tick(0);
    expect(units()).toEqual(['ane', 'gpu', 'cpu']);
    const s = state(nv);
    expect(s.loading).toBe(false);
    expect(s.loaded).toBe(false);
    expect(s.loadFailure).toBe('CPU: Missing model KokoroAlbert at …/KokoroAlbert.mlmodelc');
    const { choice } = await nv.naturalChoice();
    expect(choice).toEqual({ engine: 'system', reason: 'load-failed', detail: s.loadFailure });
    expect(systemNotice('load-failed', s.loadFailure!)).toBe(
      "The natural voice couldn't load on this iPhone: CPU: Missing model KokoroAlbert at …/KokoroAlbert.mlmodelc. Using the system voice.",
    );
    expect(statusLine(s)).toEqual({ label: `Failed: ${s.loadFailure}`, tone: 'danger' });
    // No retry loop: not on reads, not on foreground, not after a relaunch (same app + iOS).
    mockAppState.set('background');
    mockAppState.set('active');
    await tick(5000);
    expect(mockNative.load).toHaveBeenCalledTimes(3);
    const again = launch();
    await tick(5000);
    expect(state(again).loadFailure).toBe(s.loadFailure);
    expect(mockNative.load).toHaveBeenCalledTimes(3);
    // Try again: at once, from the Neural Engine.
    again.retryNaturalVoice();
    expect(units()).toEqual(['ane', 'gpu', 'cpu', 'ane']);
    expect(state(again).loadFailure).toBeNull();
    expect(state(again).loading).toBe(true);
  });

  it('a load that never answers times out per compute unit; loading never stays stuck', async () => {
    const nv = launch();
    await tick(1500);
    expect(units()).toEqual(['ane']);
    expect(mockNative.last().options.timeoutMs).toBe(120_000);
    // Native never answers (a hung Core ML / ANE compile): JS gives up 15 s after the native timeout.
    await tick(135_000);
    expect(mockNative.unload).toHaveBeenCalled();
    expect(units()).toEqual(['ane', 'gpu']);
    expect(mockNative.last().options.timeoutMs).toBe(60_000);
    expect(state(nv).loading).toBe(true);
    await tick(75_000);
    await tick(75_000);
    expect(units()).toEqual(['ane', 'gpu', 'cpu']);
    const s = state(nv);
    expect(s.loading).toBe(false);
    expect(s.loadFailure).toBe('timed out (Neural Engine 135 s, GPU 75 s, CPU 75 s)');
    const { choice } = await nv.naturalChoice();
    expect(choice).toMatchObject({ engine: 'system', reason: 'load-failed' });
  });

  it('falls back Neural Engine → GPU → CPU and remembers what worked for this app + iOS version', async () => {
    const nv = launch();
    await tick(1500);
    mockNative.rejectLoad('ERR_KOKORO_LOAD_TIMEOUT', 'The voice did not load within 120 s on the Neural Engine.');
    await tick(0);
    mockNative.rejectLoad('ERR_KOKORO_BAD_AUDIO', 'garbled audio');
    await tick(0);
    expect(units()).toEqual(['ane', 'gpu', 'cpu']);
    mockNative.resolveLoad(loadResult('cpu'));
    await tick(0);
    expect(state(nv).loaded).toBe(true);
    expect(state(nv).loadUnits).toBe('cpu');
    expect(state(nv).lastLoad?.units).toBe('cpu');
    expect(statusLine(state(nv)).label).toBe('Loaded · CPU');
    // Relaunch: starts with the CPU.
    launch();
    await tick(1500);
    expect(units()).toEqual(['ane', 'gpu', 'cpu', 'cpu']);
  });

  it('turns itself off as "no usable audio" only when every compute unit made bad audio', async () => {
    const nv = launch();
    await tick(1500);
    for (let i = 0; i < 3; i++) {
      mockNative.rejectLoad('ERR_KOKORO_BAD_AUDIO', 'no sound');
      await tick(0);
    }
    expect(state(nv).broken).toBe(true);
    expect(state(nv).loading).toBe(false);
    expect((await nv.naturalChoice()).choice).toEqual({ engine: 'system', reason: 'broken' });
  });

  it('load timeouts can be set with -phiTtsLoadTimeouts (QA)', async () => {
    mockArgs.phiTtsLoadTimeouts = 'ane=5,cpu=90';
    launch();
    await tick(1500);
    expect(mockNative.last().options).toMatchObject({ units: 'ane', timeoutMs: 5000 });
    mockNative.rejectLoad('ERR_KOKORO_LOAD_TIMEOUT', 'timed out');
    await tick(0);
    expect(mockNative.last().options).toMatchObject({ units: 'gpu', timeoutMs: 60_000 });
    mockNative.rejectLoad('ERR_KOKORO_LOAD_FAILED', 'x');
    await tick(0);
    expect(mockNative.last().options).toMatchObject({ units: 'cpu', timeoutMs: 90_000 });
  });
});

describe('natural voice: background and memory warnings', () => {
  it('a trip to the background during the load does not drop it', async () => {
    const nv = launch();
    await tick(1500);
    mockAppState.set('inactive');
    mockAppState.set('background');
    await tick(10_000);
    mockAppState.set('active');
    await tick(2000);
    // The foreground joins the load in progress: no unload, no second load.
    expect(mockNative.unload).not.toHaveBeenCalled();
    expect(mockNative.load).toHaveBeenCalledTimes(1);
    mockNative.resolveLoad();
    await tick(0);
    expect(state(nv).loaded).toBe(true);
    expect((await nv.naturalChoice()).choice).toEqual({ engine: 'natural' });
  });

  it('a load that ends in the background is unloaded then and loads again on the next foreground', async () => {
    const nv = launch();
    await tick(1500);
    mockAppState.set('background');
    mockNative.resolveLoad();
    await tick(0);
    expect(mockNative.unload).toHaveBeenCalledTimes(1);
    expect(state(nv).loaded).toBe(false);
    expect(state(nv).loading).toBe(false);
    mockAppState.set('active');
    await tick(1500);
    expect(units()).toEqual(['ane', 'ane']);
    mockNative.resolveLoad();
    await tick(0);
    expect(state(nv).loaded).toBe(true);
  });

  it('a failure while in the background is not a verdict: the next foreground tries again', async () => {
    const nv = launch();
    await tick(1500);
    mockAppState.set('background');
    mockNative.rejectLoad('ERR_KOKORO_LOAD_FAILED', 'Insufficient Permission (to submit GPU work from background)');
    await tick(0);
    expect(state(nv).loadFailure).toBeNull();
    expect(units()).toEqual(['ane']);
    mockAppState.set('active');
    await tick(1500);
    expect(units()).toEqual(['ane', 'ane']);
  });

  it('memory warnings never drop a load in progress, nor a model just loaded; later they unload it', async () => {
    const nv = launch();
    await tick(1500);
    mockAppState.memoryWarning();
    expect(mockNative.unload).not.toHaveBeenCalled();
    mockNative.resolveLoad();
    await tick(0);
    expect(state(nv).loaded).toBe(true);
    mockAppState.memoryWarning();
    expect(state(nv).loaded).toBe(true);
    await tick(61_000);
    mockAppState.memoryWarning();
    expect(state(nv).loaded).toBe(false);
    // The next read loads it again.
    const choice = nv.naturalChoice();
    await tick(0);
    mockNative.resolveLoad();
    await expect(choice).resolves.toMatchObject({ choice: { engine: 'natural' } });
  });

  it('unloads in the background when loaded', async () => {
    const nv = launch();
    await tick(1500);
    mockNative.resolveLoad();
    await tick(0);
    mockAppState.set('background');
    expect(mockNative.unload).toHaveBeenCalledTimes(1);
    expect(state(nv).loaded).toBe(false);
  });
});

describe('natural voice: crash marker, repair, remove', () => {
  it('the app dying while loading in the foreground skips those compute units at the next launch', async () => {
    launch();
    await tick(1500);
    expect(units()).toEqual(['ane']);
    // The process dies here (jetsam, a Core ML crash): no answer, no background event.
    const nv = launch();
    await tick(1500);
    expect(units()).toEqual(['ane', 'gpu']);
    mockNative.resolveLoad(loadResult('gpu'));
    await tick(0);
    expect(state(nv).loadUnits).toBe('gpu');
  });

  it('leaving for the background clears the marker (a later kill by iOS is not a crash)', async () => {
    launch();
    await tick(1500);
    mockAppState.set('background');
    launch();
    await tick(1500);
    expect(units()).toEqual(['ane', 'ane']);
  });

  it('a model whose files went missing is repaired by downloading only those, then loads', async () => {
    mockNative.status = { ready: false, damaged: true, missing: 3, bytesOnDisk: 180_000_000, downloadBytes: 226_869_788 };
    const nv = launch();
    expect(state(nv).damaged).toBe(true);
    expect(mockNative.downloadModel).toHaveBeenCalledTimes(1);
    expect(statusLine(state(nv)).label).toMatch(/^Repairing \d+%$/);
    mockNative.status = { ready: true, bytesOnDisk: 216_000_000, downloadBytes: 226_869_788 };
    mockNative.downloads[0].resolve({ seconds: 3, dir: '/x' });
    await tick(0);
    expect(state(nv).damaged).toBe(false);
    expect(units()).toEqual(['ane']);
  });

  it('removing the model during a load drops the load without a failure', async () => {
    const nv = launch();
    await tick(1500);
    await nv.removeNaturalVoiceModel();
    await tick(0);
    mockNative.status = { ready: false, bytesOnDisk: 0, downloadBytes: 226_869_788 };
    const s = state(nv);
    expect(s.loading).toBe(false);
    expect(s.loadFailure).toBeNull();
    expect(mockNative.load).toHaveBeenCalledTimes(1);
  });

  it('a read that finds native lost the model loads it again next time', async () => {
    const nv = launch();
    await tick(1500);
    mockNative.resolveLoad();
    await tick(0);
    mockNative.synthesizeImpl = () => Promise.reject(Object.assign(new Error('The voice model is not loaded.'), { code: 'ERR_KOKORO_NOT_LOADED' }));
    const result = await nv.readNatural([{ text: 'Hello.', pause: 0.2 }], 'af_heart', 1, () => false);
    expect(result.outcome).toBe('error');
    expect(state(nv).loaded).toBe(false);
    const choice = nv.naturalChoice();
    await tick(0);
    expect(mockNative.load).toHaveBeenCalledTimes(2);
    mockNative.resolveLoad();
    await expect(choice).resolves.toMatchObject({ choice: { engine: 'natural' } });
  });
});

describe('natural voice: diagnostics', () => {
  it('the report has the device, files, attempts, guards and the newest events', async () => {
    const nv = launch();
    await tick(1500);
    mockNative.emit('onLoadProgress', { units: 'ane', stage: 'Vocoder', done: false });
    expect(state(nv).loadStage).toBe('Vocoder');
    mockNative.emit('onLoadProgress', { units: 'ane', stage: 'Vocoder', done: true, ms: 4200 });
    mockNative.rejectLoad('ERR_KOKORO_LOAD_TIMEOUT', 'The voice did not load within 120 s on the Neural Engine.');
    await tick(0);
    mockNative.resolveLoad(loadResult('gpu'));
    await tick(0);
    const report = await nv.naturalVoiceReport();
    expect(report).toContain('iOS 26.1 · iPhone18,1');
    expect(report).toContain('status: Loaded · GPU');
    expect(report).toMatch(/ane timeout after .*: The voice did not load within 120 s/);
    expect(report).toMatch(/gpu ok after/);
    expect(report).toContain('✓ base/KokoroAlbert.mlmodelc 5.8 MB');
    expect(report).toContain('protection NSFileProtectionCompleteUntilFirstUserAuthentication');
    expect(report).toContain('remembered gpu');
    expect(report).toMatch(/stage ane Vocoder · 4\.20 s/);
    expect(report).toMatch(/loaded gpu: load 1\.2 s/);
    const events = report.split('Events (newest last, ')[1];
    expect(Number.parseInt(events, 10)).toBeLessThanOrEqual(50);
    // The log persists (debounced) in Documents/diagnostics/tts-log.json.
    await tick(2000);
    expect(mockFiles.get('diag/tts-log.json')).toContain('"kind":"loaded"');
  });
});

describe('native module contract', () => {
  const root = join(__dirname, '../../..');
  const swift = readFileSync(join(root, 'modules/kokoro-tts/ios/KokoroTtsModule.swift'), 'utf8');
  const ts = readFileSync(join(root, 'modules/kokoro-tts/index.ts'), 'utf8');

  it('the Swift module, index.ts and the jest fake define the same functions and events', () => {
    const swiftFns = [...swift.matchAll(/\b(?:Async)?Function\("(\w+)"\)/g)].map((m) => m[1]).sort();
    const decl = ts.slice(ts.indexOf('declare class KokoroTtsModule'), ts.indexOf('const KokoroTts ='));
    const tsFns = [...decl.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]).sort();
    expect(tsFns).toEqual(swiftFns);
    expect([...FAKE_NATIVE_FUNCTIONS].sort()).toEqual(swiftFns);
    for (const fn of FAKE_NATIVE_FUNCTIONS) expect(typeof (mockNative as Record<string, unknown>)[fn]).toBe('function');
    const swiftEvents = [...(swift.match(/Events\(([^)]*)\)/)?.[1] ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
    const eventsDecl = ts.slice(ts.indexOf('type Events = {'), ts.indexOf('declare class'));
    const tsEvents = [...eventsDecl.matchAll(/^ {2}(\w+): \(/gm)].map((m) => m[1]).sort();
    expect(tsEvents).toEqual(swiftEvents);
    expect(swiftEvents).toEqual(['onInterrupted', 'onLoadProgress', 'onProgress']);
  });

  it('every error code the app reacts to is thrown by the Swift module', () => {
    const natural = readFileSync(join(root, 'src/services/natural-voice.ts'), 'utf8');
    const codes = new Set([...natural.matchAll(/'(ERR_KOKORO_\w+)'/g)].map((m) => m[1]));
    expect(codes.size).toBeGreaterThanOrEqual(6);
    const native = ['KokoroTtsModule.swift', 'KokoroLoader.swift'].map((f) => {
      try {
        return readFileSync(join(root, 'modules/kokoro-tts/ios', f), 'utf8');
      } catch {
        return '';
      }
    });
    for (const code of codes) expect(native.join('\n')).toContain(`"${code}"`);
  });
});
