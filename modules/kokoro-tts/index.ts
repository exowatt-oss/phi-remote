/**
 * kokoro-tts: read-aloud with Kokoro-82M on this iPhone (Core ML: Neural Engine + GPU), iOS 18+.
 *
 * The model (~227 MB) downloads on first use from Hugging Face, pinned and checksummed; nothing is
 * sent anywhere while reading. JS splits a reply into pieces and streams them: synthesize(piece)
 * keeps the audio natively and returns its id, play(id) schedules it right after whatever is
 * playing and resolves when it has been heard (false when stop() or an interruption ended it).
 * `null` on Android / web / Expo Go (no native module): read-aloud uses the system voice.
 */
import { NativeModule, requireOptionalNativeModule } from 'expo';

export type KokoroModelStatus = {
  /** Downloaded, verified and compiled: the `.ready` marker and every model file in place. */
  ready: boolean;
  /** The `.ready` marker is there but files are missing (the next download fetches only those). */
  damaged?: boolean;
  /** How many of the pinned files are missing (when damaged). */
  missing?: number;
  bytesOnDisk: number;
  /** Size of the full download (bytes). */
  downloadBytes: number;
  revision?: string;
  dir?: string;
};

export type KokoroProgress = { phase: 'download' | 'compiling'; fraction: number };

/** Core ML compute units: 'ane' = Neural Engine (+ GPU for three stages, FluidAudio's plan), 'gpu' = CPU + GPU, 'cpu' = CPU only. */
export type KokoroUnits = 'ane' | 'gpu' | 'cpu';

export type KokoroLoadResult = {
  seconds: number;
  warmupMs?: number;
  footprintBeforeMB?: number;
  footprintAfterMB?: number;
  alreadyLoaded: boolean;
  /** The compute units the model is loaded with. */
  units?: KokoroUnits;
  /** This call took over an attempt with the same units that was still running (e.g. across a background trip). */
  adopted?: boolean;
};

/** A native load's stages, as they start (`done: false`) and finish (`ms`). */
export type KokoroLoadProgress = { units: KokoroUnits; stage: string; done: boolean; ms?: number };

export type KokoroDiagnostics = {
  deviceModel: string;
  osVersion: string;
  dir: string;
  readyMarker: boolean;
  intact: boolean;
  missing: string[];
  /** Each model file or compiled bundle (relative to `dir`) with its size; -1 when missing. */
  files: { path: string; bytes: number }[];
  bytesOnDisk: number;
  freeBytes: number;
  footprintMB: number;
  /** File protection class of the model folder and one weight file (NSFileProtection…). */
  protection: string;
  excludedFromBackup: boolean;
  /** Size of Core ML's compile cache (e5rt) for this app (bytes; -1 when not found). */
  aneCacheBytes: number;
  engineUnits: KokoroUnits | null;
  /** Load attempts still running natively (Core ML loads cannot be interrupted). */
  running: { units: KokoroUnits; seconds: number; timedOut: boolean; abandoned: boolean }[];
  /** QA launch flags in effect (-phiTtsForceFail / -phiTtsForceHang / -phiTtsForceBadAudio / -phiTtsAcceptAnyAudio). */
  qaFlags: string;
  /** The newest native log lines (load stages, attempt outcomes, errors in full). */
  log: string[];
};

export type KokoroPiece = {
  id: number;
  /** Seconds of audio stored, including the pause after it. */
  seconds: number;
  /** Seconds of speech the model produced (before trimming). */
  audioSeconds: number;
  synthMs: number;
  frames: number;
  /** The static fast path ran (pieces up to ~5 s); false = the slower general vocoder. */
  fast: boolean;
};

export type KokoroWavResult = {
  seconds: number;
  pieces: {
    text: string;
    synthMs: number;
    audioSeconds: number;
    /** Largest absolute sample (0 = silence). */
    peak?: number;
    frames: number;
    fast: boolean;
    phonemes: string;
    stageMs: Record<string, number>;
  }[];
};

type Events = {
  onProgress: (e: KokoroProgress) => void;
  onLoadProgress: (e: KokoroLoadProgress) => void;
  /** Playback ended without stop(): a call, Siri, a route change, a media-services reset. */
  onInterrupted: (e: { message: string }) => void;
};

declare class KokoroTtsModule extends NativeModule<Events> {
  isAvailable(): boolean;
  getModelStatus(): KokoroModelStatus;
  footprintMB(): number;
  /** Download (resumable), verify, compile. allowCellular false (default): waits for Wi-Fi / an unconstrained network. */
  downloadModel(options?: { allowCellular?: boolean }): Promise<{ seconds: number; dir: string }>;
  cancelDownload(): void;
  removeModel(): Promise<void>;
  /**
   * Loads every stage with `units` (default 'ane') and warms up one piece per synthesis path (the first ANE load after
   * installing or updating iOS compiles for the Neural Engine). Rejects with ERR_KOKORO_LOAD_TIMEOUT after `timeoutMs`
   * (default 120 s), ERR_KOKORO_BAD_AUDIO when the warm-up is silent or garbled, ERR_KOKORO_UNLOADED when unload() or
   * removeModel() ran meanwhile, ERR_KOKORO_NOT_DOWNLOADED, or ERR_KOKORO_LOAD_FAILED (the Core ML error).
   */
  load(options?: { lexicon?: Record<string, string>; units?: KokoroUnits; timeoutMs?: number }): Promise<KokoroLoadResult>;
  /** Frees the model; a load in progress rejects with ERR_KOKORO_UNLOADED. */
  unload(): void;
  /** Settings › Voice › Diagnostics. */
  diagnostics(): Promise<KokoroDiagnostics>;
  /** Word (any case) -> Misaki IPA, checked before the built-in lexicon. */
  setLexicon(entries: Record<string, string>): Promise<void>;
  phonemes(text: string): Promise<string>;
  /** `pause`: seconds of silence after the piece (the model's own edge silence is trimmed). */
  synthesize(text: string, options: { voice: string; speed: number; pause?: number }): Promise<KokoroPiece>;
  play(id: number): Promise<boolean>;
  stop(): void;
  /** QA / samples: the pieces as the player joins them (edge silence trimmed, `pauses[i]` after piece i), one WAV. */
  writeWav(pieces: string[], options: { voice: string; speed?: number; pauses?: number[] }, path: string): Promise<KokoroWavResult>;
  /** QA: the system voice (AVSpeechSynthesizer) to a WAV. */
  writeSystemWav(
    text: string,
    options: { voiceId?: string; rate?: number },
    path: string,
  ): Promise<{ seconds: number; voice: string; voiceName: string }>;
}

const KokoroTts = requireOptionalNativeModule<KokoroTtsModule>('KokoroTts');

export default KokoroTts;

export function isKokoroAvailable(): boolean {
  try {
    return !!KokoroTts?.isAvailable();
  } catch {
    return false;
  }
}
