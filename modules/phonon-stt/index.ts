/**
 * phonon-stt: on-device live dictation with Phonon-2 (Core ML on the Neural Engine), iOS 18+.
 *
 * The native module re-reads the open utterance every ~0.4 s and commits it at pauses:
 *   onPartial { committed, tail }: show `committed` normally and `tail` slightly muted (it may still change)
 *   onFinal   { text }:            after stop(); `fullPassText` too when stop({ fullPass: true })
 * `null` on Android / web / Expo Go (no native module): callers fall back to the SpeechAnalyzer path.
 */
import { NativeModule, requireOptionalNativeModule } from 'expo';

export type PhononPartial = {
  committed: string;
  tail: string;
  kind: 'partial' | 'commit-pause' | 'commit-cut';
  audioSeconds: number;
  decodeMs: number;
  /** Encoder function used for this read (5, 10 or 15 s). */
  function: number;
  decodedSeconds: number;
  /** Seconds since start(). */
  t: number;
  /** App memory footprint after this update (MB). */
  footprintMB?: number;
};

export type PhononFinal = {
  text: string;
  audioSeconds: number;
  /** stop() -> final text (end of speech -> final text). */
  latencyMs: number;
  finalDecodeMs: number;
  updates: number;
  fullPassText?: string;
  fullPassMs?: number;
  /** The live re-reads were stopped by degrade() during this session. */
  degraded?: boolean;
  /** file:// URI of the recording as 16 kHz WAV, when stop({ audioPath }) asked for it. */
  audioUri?: string;
  footprintStartMB?: number;
  footprintPeakMB?: number;
  footprintEndMB?: number;
  thermalStart?: ThermalState;
  thermalEnd?: ThermalState;
};

export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';

export type PhononProgress = {
  /** "download" | "compiling" | "compiled" | "loading enc_10s" | "loaded enc_10s" | ... */
  phase: string;
  fraction?: number;
  file?: string;
  seconds?: number;
};

export type PhononModelStatus = {
  /** Downloaded, verified and compiled (the `.ready` marker). */
  ready: boolean;
  dir: string;
  bytesOnDisk: number;
  /** Size of the full download (bytes). */
  downloadBytes?: number;
  revision?: string;
  /** prepare() finished in this app process (the model is loaded). */
  prepared?: boolean;
  preparing?: boolean;
};

export type PhononPrepareResult = {
  loadSeconds: number;
  compileSeconds?: number;
  functionLoadSeconds?: Record<string, number>;
  compiledModel?: string;
  computeUnits?: string;
  functions?: number[];
  footprintBeforeMB?: number;
  footprintAfterMB?: number;
  footprintPeakMB?: number;
  thermalStart?: ThermalState;
  thermalEnd?: ThermalState;
  alreadyPrepared?: boolean;
};

export type PhononNetwork = {
  known?: false;
  connected?: boolean;
  /** Cellular or personal hotspot. */
  expensive?: boolean;
  /** Low Data Mode. */
  constrained?: boolean;
  wifi?: boolean;
  cellular?: boolean;
};

export type PhononDeviceInfo = {
  footprintMB: number;
  thermalState: ThermalState;
  osVersion: string;
  /** Includes the OS build, e.g. "Version 26.1 (Build 23B85)". */
  osVersionString: string;
  model: string;
  lowPowerMode: boolean;
};

export type PhononLiveOptions = {
  /** Seconds between re-reads (default 0.4). */
  interval?: number;
  /** Open utterance length that forces a cut at a sentence end (default 12 s, lowered to 7.5 s with only the 10 s function). */
  maxTail?: number;
  /** Quiet that commits an utterance (default 0.6 s). */
  pause?: number;
  /** start(): set the AVAudioSession category itself (default true; pass false when expo-audio already did). */
  configureAudioSession?: boolean;
  /** start() with configureAudioSession: the iPhone's built-in mic (default; headphones stay on A2DP) or a headset's (HFP). */
  mic?: 'iphone' | 'headset';
  /** startFile(): playback speed (default 1 = real time), stop at the end of the file (default true), full pass then. */
  speed?: number;
  autoStop?: boolean;
  fullPass?: boolean;
};

type Events = {
  onPartial: (e: PhononPartial) => void;
  onFinal: (e: PhononFinal) => void;
  onLevel: (e: { level: number }) => void;
  onProgress: (e: PhononProgress) => void;
  onError: (e: { message: string }) => void;
  /** The microphone capture ended (a call, Siri, media services reset, an input that could not restart). */
  onInterrupted: (e: { message: string }) => void;
  onNetwork: (e: PhononNetwork) => void;
};

declare class PhononSttModule extends NativeModule<Events> {
  isAvailable(): boolean;
  getModelStatus(): PhononModelStatus;
  getDeviceInfo(): PhononDeviceInfo;
  getNetworkStatus(): PhononNetwork;
  /** Download (resumable), verify, compile. allowCellular false (default): waits for Wi-Fi / an unconstrained network. */
  downloadModel(options?: { allowCellular?: boolean }): Promise<{ dir: string; seconds: number }>;
  cancelDownload(): void;
  prepare(
    modelDir?: string | null,
    /** functions: encoder functions to load (default [10]: one Neural Engine compile); [5, 10, 15] = faster short updates, 3 compiles. */
    options?: { functions?: number[]; computeUnits?: 'ane' | 'cpu' | 'gpu' | 'all' },
  ): Promise<PhononPrepareResult>;
  unload(): void;
  removeModel(): Promise<void>;
  start(options?: PhononLiveOptions): Promise<{ thermalState?: ThermalState; footprintMB?: number } | null>;
  startFile(path: string, options?: PhononLiveOptions): Promise<{ audioSeconds: number }>;
  degrade(): void;
  stop(options?: { fullPass?: boolean; decode?: boolean; audioPath?: string }): Promise<PhononFinal>;
  cancel(): void;
  transcribeFile(path: string): Promise<{
    text: string;
    audioSeconds: number;
    decodeMs: number;
    windows: number;
    words: { text: string; start: number; end: number }[];
  }>;
}

const PhononStt = requireOptionalNativeModule<PhononSttModule>('PhononStt');
export default PhononStt;

/** Phonon live dictation can run here (native module present, iOS 18+). */
export function isPhononAvailable(): boolean {
  try {
    return PhononStt?.isAvailable() ?? false;
  } catch {
    return false;
  }
}
