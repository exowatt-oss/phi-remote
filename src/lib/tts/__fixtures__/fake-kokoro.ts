/**
 * A fake KokoroTts native module for jest, following the contract in modules/kokoro-tts/index.ts
 * (and KokoroTtsModule.swift, checked by the contract test): loads and downloads stay pending until
 * the test settles them, unload() rejects a load in progress with ERR_KOKORO_UNLOADED, events are
 * emitted with `emit`.
 */

import type {
  KokoroDiagnostics,
  KokoroLoadProgress,
  KokoroLoadResult,
  KokoroModelStatus,
  KokoroPiece,
  KokoroProgress,
  KokoroUnits,
} from '../../../../modules/kokoro-tts';

type Pending<T> = { resolve: (v: T) => void; reject: (e: unknown) => void; settled: boolean };
export type LoadCall = Pending<KokoroLoadResult> & { options: { lexicon?: Record<string, string>; units?: KokoroUnits; timeoutMs?: number } };

export function nativeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`Calling the 'load' function has failed\n→ Caused by: ${message}`), { code });
}

export function loadResult(units: KokoroUnits = 'ane', extra: Partial<KokoroLoadResult> = {}): KokoroLoadResult {
  return { seconds: 1.2, warmupMs: 150, footprintBeforeMB: 90, footprintAfterMB: 280, alreadyLoaded: false, units, ...extra };
}

export const FAKE_DIAGNOSTICS: KokoroDiagnostics = {
  deviceModel: 'iPhone18,1',
  osVersion: '26.1',
  dir: '/var/mobile/Containers/Data/Application/X/Library/Application Support/KokoroModels/kokoro-82m-v3-6c0750dd02ef',
  readyMarker: true,
  intact: true,
  missing: [],
  files: [
    { path: 'base/KokoroAlbert.mlmodelc', bytes: 5_800_000 },
    { path: 'decoder/KokoroDecoderPre_120.mlmodelc', bytes: 33_700_000 },
  ],
  bytesOnDisk: 216_000_000,
  freeBytes: 40_000_000_000,
  footprintMB: 280,
  protection: 'NSFileProtectionCompleteUntilFirstUserAuthentication',
  excludedFromBackup: true,
  aneCacheBytes: 12_000_000,
  engineUnits: null,
  running: [],
  qaFlags: '',
  log: ['12:00:00.000 load ane: Albert 2.1 s'],
};

export function createFakeKokoro() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const fake = {
    status: { ready: true, bytesOnDisk: 216_000_000, downloadBytes: 226_869_788 } as KokoroModelStatus,
    loads: [] as LoadCall[],
    downloads: [] as Pending<{ seconds: number; dir: string }>[],
    synthesizeImpl: null as null | ((text: string) => Promise<KokoroPiece>),
    /** unload() rejects a load in progress (the current native contract); false = build 263091639's native, where it went on and resolved. */
    unloadRejectsLoads: true,
    reset(): void {
      fake.unloadRejectsLoads = true;
      fake.status = { ready: true, bytesOnDisk: 216_000_000, downloadBytes: 226_869_788 };
      fake.loads = [];
      fake.downloads = [];
      fake.synthesizeImpl = null;
      listeners.clear();
      for (const v of Object.values(fake as Record<string, unknown>)) if (typeof v === 'function' && 'mockClear' in v) (v as jest.Mock).mockClear();
    },
    /** A new app process: the previous one's listeners are gone. */
    dropListeners(): void {
      listeners.clear();
    },
    emit(name: 'onProgress' | 'onLoadProgress' | 'onInterrupted', e: KokoroProgress | KokoroLoadProgress | { message: string }): void {
      for (const l of listeners.get(name) ?? []) l(e);
    },
    /** The load calls not settled yet. */
    pending(): LoadCall[] {
      return fake.loads.filter((l) => !l.settled);
    },
    last(): LoadCall {
      const l = fake.loads[fake.loads.length - 1];
      if (!l) throw new Error('no load call');
      return l;
    },
    resolveLoad(r?: KokoroLoadResult): void {
      const l = fake.last();
      l.settled = true;
      l.resolve(r ?? loadResult(l.options.units ?? 'ane'));
    },
    rejectLoad(code: string, message: string): void {
      const l = fake.last();
      l.settled = true;
      l.reject(nativeError(code, message));
    },

    isAvailable: jest.fn(() => true),
    getModelStatus: jest.fn((): KokoroModelStatus => ({ ...fake.status })),
    footprintMB: jest.fn(() => 100),
    downloadModel: jest.fn(
      (_options?: { allowCellular?: boolean }) =>
        new Promise<{ seconds: number; dir: string }>((resolve, reject) => {
          fake.downloads.push({ resolve, reject, settled: false });
        }),
    ),
    cancelDownload: jest.fn(),
    removeModel: jest.fn(async () => undefined),
    load: jest.fn(
      (options: LoadCall['options'] = {}) =>
        new Promise<KokoroLoadResult>((resolve, reject) => {
          fake.loads.push({ options, resolve, reject, settled: false });
        }),
    ),
    unload: jest.fn((): void => {
      if (!fake.unloadRejectsLoads) return;
      for (const l of fake.pending()) {
        l.settled = true;
        l.reject(nativeError('ERR_KOKORO_UNLOADED', 'The voice model was unloaded.'));
      }
    }),
    diagnostics: jest.fn(async () => FAKE_DIAGNOSTICS),
    setLexicon: jest.fn(async (_entries: Record<string, string>) => undefined),
    phonemes: jest.fn(async (text: string) => text),
    synthesize: jest.fn(
      (text: string, _options: { voice: string; speed: number; pause?: number }): Promise<KokoroPiece> =>
        fake.synthesizeImpl ? fake.synthesizeImpl(text) : Promise.resolve({ id: 1, seconds: 1, audioSeconds: 1, synthMs: 60, frames: 120, fast: true }),
    ),
    play: jest.fn(async (_id: number) => true),
    stop: jest.fn(),
    writeWav: jest.fn(async () => ({ seconds: 0, pieces: [] })),
    writeSystemWav: jest.fn(async () => ({ seconds: 0, voice: '', voiceName: '' })),
    addListener: jest.fn((name: string, fn: (e: never) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn as (e: unknown) => void);
      return { remove: () => listeners.get(name)?.delete(fn as (e: unknown) => void) };
    }),
  };
  return fake;
}

export type FakeKokoro = ReturnType<typeof createFakeKokoro>;

/** The native functions the fake implements (the contract test compares them with the Swift module and index.ts). */
export const FAKE_NATIVE_FUNCTIONS = [
  'isAvailable',
  'getModelStatus',
  'footprintMB',
  'downloadModel',
  'cancelDownload',
  'removeModel',
  'load',
  'unload',
  'diagnostics',
  'setLexicon',
  'phonemes',
  'synthesize',
  'play',
  'stop',
  'writeWav',
  'writeSystemWav',
] as const;
