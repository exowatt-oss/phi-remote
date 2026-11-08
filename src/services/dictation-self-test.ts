/**
 * Simulator / QA hooks for dictation. Inert unless the app is launched with one of these
 * launch arguments (iOS puts `-key value` launch arguments in NSUserDefaults' argument
 * domain, which RN `Settings` reads) — an App Store or TestFlight install never has them:
 *
 *   -phiDictationSelfTest <file>   at launch, run the exact transcriber the ✓ button uses
 *                                  (prepare + transcribe) on <file> and write the result to
 *                                  Documents/dictation-selftest.json (+ console.log).
 *   -phiDictationInjectFile <file> the real recorder runs as usual, but ✓ transcribes <file>
 *                                  instead of the recording (the Simulator has no microphone).
 *   -phiDictationQATranscript <text>
 *                                  only where SpeechTranscriber is unavailable (the iOS
 *                                  Simulator reports no supported locales): the real recorder
 *                                  and composer flow run, ✓ copies the recording to
 *                                  Documents/dictation-qa-recording.m4a, waits 1.5 s
 *                                  ("Transcribing…") and returns <text>.
 *   -phiPhononFeedFile <file>      live dictation (Phonon) reads <file> through its live loop in
 *                                  real time instead of the microphone (the Simulator has none),
 *                                  so words appear in the composer as with a real voice.
 *   -phiPhononPerfGuardMs <ms>     the live-dictation performance guard's limit (default 500 ms;
 *                                  the Simulator has no Neural Engine, so its CPU updates need more).
 *   -phiPhononModel / -phiPhononFiles / -phiPhononSpeed / -phiPhononUnits / -phiPhononLog
 *                                  the Phonon self-test at launch (src/services/phonon-self-test.ts).
 *   -phiDictationQARecorder <file> only for hosts with no audio input (a Simulator on a Mac
 *                                  without a microphone: AVAudioRecorder gets a 0-channel
 *                                  input and cannot start): a stand-in for the native
 *                                  recorder whose "recording" is a copy of <file> and whose
 *                                  metering is a synthetic voice-like level, so the composer
 *                                  flow (✕ · waveform · clock · ✓) can be driven end to end.
 *
 * <file> is an absolute path, a file:// URI, or a name inside the app's Documents folder.
 */

import { File, Paths } from 'expo-file-system';

import type { PreparedVoiceTranscription, VoiceTranscriber } from '@/lib/voice-input';

import { launchArg } from './launch-args';
import { getLocalVoiceTranscriber } from './voice-transcription';

const SELF_TEST_ARG = 'phiDictationSelfTest';
const INJECT_ARG = 'phiDictationInjectFile';
const QA_TRANSCRIPT_ARG = 'phiDictationQATranscript';
const QA_RECORDER_ARG = 'phiDictationQARecorder';
const RESULT_FILE = 'dictation-selftest.json';
const QA_RECORDING_FILE = 'dictation-qa-recording.m4a';

export { launchArg } from './launch-args';

export function fileUri(path: string): string {
  if (path.startsWith('file://')) return path;
  if (path.startsWith('/')) return `file://${path}`;
  return new File(Paths.document, path).uri;
}

/** With `-phiDictationInjectFile`, ✓ transcribes that file; otherwise the transcriber is unchanged. */
export function injectedRecordingTranscriber(transcriber: VoiceTranscriber): VoiceTranscriber {
  const injected = launchArg(INJECT_ARG);
  if (!injected) return transcriber;
  const uri = fileUri(injected);
  return {
    prepare: async (options) => {
      const prepared = await transcriber.prepare(options);
      const swapped: PreparedVoiceTranscription = {
        locale: prepared.locale,
        transcribe: (_recording, opts) => prepared.transcribe(uri, opts),
      };
      return swapped;
    },
  };
}

/** With `-phiDictationQATranscript` (Simulator UI QA only): a stand-in transcriber; else null. */
export function qaTranscriber(): VoiceTranscriber | null {
  const transcript = launchArg(QA_TRANSCRIPT_ARG);
  if (!transcript) return null;
  return {
    prepare: async () => ({
      locale: 'en-US',
      transcribe: async (uri) => {
        // Keep what the real recorder wrote, so its format can be checked from the host.
        try {
          const copy = new File(Paths.document, QA_RECORDING_FILE);
          if (copy.exists) copy.delete();
          new File(uri).copySync(copy);
          console.log(`[phi-dictation-qa] recording ${uri} (${new File(uri).size} bytes) copied to ${QA_RECORDING_FILE}`);
        } catch (error) {
          console.log(`[phi-dictation-qa] could not copy the recording: ${String(error)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return transcript;
      },
    }),
  };
}

type QARecorderState = {
  canRecord: boolean;
  isRecording: boolean;
  durationMillis: number;
  fileSize: number;
  mediaServicesDidReset: boolean;
  metering?: number;
  url: string | null;
};

/** With `-phiDictationQARecorder` (mic-less Simulator UI QA only): a stand-in native recorder; else null. */
export function qaRecorder(): {
  readonly uri: string | null;
  prepareToRecordAsync(): Promise<void>;
  record(options: { readonly forDuration: number }): void;
  stop(): Promise<void>;
  getStatus(): QARecorderState;
  addListener(eventName: 'recordingStatusUpdate', listener: (status: never) => void): { remove(): void };
  getAvailableInputs(): { uid: string; name: string; type: string }[];
  setInput(uid: string): void;
  release(): void;
} | null {
  const source = launchArg(QA_RECORDER_ARG);
  if (!source) return null;
  let uri: string | null = null;
  let startedAt: number | null = null;
  let stoppedAt: number | null = null;
  let take = 0;
  const elapsed = () => (startedAt === null ? 0 : (stoppedAt ?? Date.now()) - startedAt);
  return {
    get uri() {
      return uri;
    },
    async prepareToRecordAsync() {
      const copy = new File(Paths.cache, `qa-recording-${Date.now()}-${++take}.m4a`);
      new File(fileUri(source)).copySync(copy);
      uri = copy.uri;
      startedAt = null;
      stoppedAt = null;
    },
    record() {
      startedAt = Date.now();
    },
    async stop() {
      if (startedAt !== null && stoppedAt === null) stoppedAt = Date.now();
    },
    getStatus() {
      const t = elapsed() / 1000;
      // Syllable-rate bursts between -50 and -8 dBFS.
      const level = 0.5 + 0.5 * Math.sin(t * 9) * Math.sin(t * 2.3);
      return {
        canRecord: true,
        isRecording: startedAt !== null && stoppedAt === null,
        durationMillis: elapsed(),
        fileSize: 0,
        mediaServicesDidReset: false,
        metering: -50 + 42 * level,
        url: uri,
      };
    },
    addListener: () => ({ remove() {} }),
    getAvailableInputs: () => [],
    setInput() {},
    release() {},
  };
}

let ran = false;

/** Runs the launch-argument self-test once (no-op without `-phiDictationSelfTest`). */
export async function runDictationSelfTestIfRequested(): Promise<void> {
  const path = launchArg(SELF_TEST_ARG);
  if (!path || ran) return;
  ran = true;
  const started = Date.now();
  const result: Record<string, unknown> = { file: path, deviceLocale: Intl.DateTimeFormat().resolvedOptions().locale };
  try {
    const transcriber = getLocalVoiceTranscriber();
    result.available = transcriber !== null;
    if (transcriber) {
      const { signal } = new AbortController();
      const prepared = await transcriber.prepare({ signal });
      result.locale = prepared.locale;
      result.prepareMs = Date.now() - started;
      const t0 = Date.now();
      result.text = await prepared.transcribe(fileUri(path), { signal });
      result.transcribeMs = Date.now() - t0;
    }
  } catch (error) {
    result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
    if (cause !== undefined) result.cause = cause instanceof Error ? cause.message : String(cause);
  }
  const json = JSON.stringify(result);
  console.log(`[phi-dictation-selftest] ${json}`);
  try {
    await new File(Paths.document, RESULT_FILE).write(json);
  } catch (error) {
    console.log(`[phi-dictation-selftest] could not write ${RESULT_FILE}: ${String(error)}`);
  }
}
