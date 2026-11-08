/**
 * One live-dictation session with Phonon-2, shaped as the two seams T3's voice-input controller
 * already has (a recorder and a transcriber), so `src/lib/voice-input` stays unchanged:
 *
 *   recorder.prepareToRecordAsync  → PhononStt.start (microphone; expo-audio already set the session)
 *   onPartial                      → `liveTextStore` (the composer shows committed + muted tail)
 *   recorder.stop on ✓             → PhononStt.stop: reads what is left of the open utterance (~30–60 ms)
 *   transcriber.transcribe         → that final text, inserted at the caret by the controller
 *   recorder.stop on ✕ / discard   → PhononStt.cancel (the draft was never touched)
 *
 * Performance guard: if 3 of the first 5 live updates take > 500 ms (Core ML fell back to the
 * CPU), live updates stop, the recording continues, and ✓ hands the whole recording to
 * SpeechAnalyzer as a WAV. Live dictation then stays off on this iPhone (live-dictation.ts).
 */

import { File, Paths } from 'expo-file-system';
import { createStore } from 'zustand/vanilla';

import PhononStt, { type PhononFinal, type PhononPartial } from '../../modules/phonon-stt';
import { summarizeSession, wordCount, type SessionOutcome } from '@/lib/live-dictation/diagnostics';
import { median, PERF_GUARD_LIMIT_MS, PerfGuard } from '@/lib/live-dictation/perf-guard';
import {
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
} from '@/lib/voice-input';

import { fileUri, launchArg } from './dictation-self-test';
import { livePreviewCorrector } from './dictionary';
import { markLiveDictationSlow, recordLiveError, recordLiveSession, unloadLiveDictationModel } from './live-dictation';

export type LiveText = { committed: string; tail: string };

/** The words recognized so far in the running live dictation (null: none / not live). */
export const liveTextStore = createStore<{ text: LiveText | null }>()(() => ({ text: null }));

export type PhononRecorderState = {
  canRecord: boolean;
  isRecording: boolean;
  durationMillis: number;
  mediaServicesDidReset: boolean;
  metering?: number;
  url: string | null;
};

type Subscription = { remove(): void };

export type PhononDictationDeps = {
  /** The controller is finishing (✓ or the time limit), not discarding. */
  isConfirming: () => boolean;
  /** The microphone capture ended (a call, Siri, …): the controller discards with this message. */
  onInterrupted: (message: string, uri: string) => void;
  /** The 5-minute limit was reached: the controller finishes as if ✓ was tapped. */
  onLimitReached: (uri: string) => void;
  /** SpeechAnalyzer, for the rest of this session when the guard trips (null below iOS 26). */
  fallbackTranscriber: () => VoiceTranscriber | null;
  /** One line above the composer. */
  onNotice: (message: string) => void;
};

let sequence = 0;

export class PhononDictation {
  readonly uri = `phonon://session-${++sequence}`;
  private readonly deps: PhononDictationDeps;
  private readonly guard: PerfGuard;
  private subs: Subscription[] = [];
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  private levelDb: number | undefined;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private finishing: Promise<PhononFinal> | null = null;
  private readonly decodeMs: number[] = [];
  private degraded = false;
  private speech: Promise<PreparedVoiceTranscription> | null = null;
  private nativeRunning = false;
  private recorded = false;
  private interruptedBy: string | null = null;
  private footprintStartMB: number | null = null;
  private footprintPeakMB: number | null = null;
  private thermalStart: string | null = null;
  private audioSeconds = 0;
  private readonly correct = livePreviewCorrector();

  constructor(deps: PhononDictationDeps) {
    this.deps = deps;
    const limit = Number(launchArg('phiPhononPerfGuardMs'));
    this.guard = new PerfGuard(Number.isFinite(limit) && limit > 0 ? limit : PERF_GUARD_LIMIT_MS);
  }

  /** The controller's transcriber: prepare is instant (the model is loaded); transcribe = the live result. */
  readonly transcriber: VoiceTranscriber = {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      return { locale: 'en-US', transcribe: (_uri, options) => this.transcribe(options.signal) };
    },
  };

  // ---- recorder ----

  async prepareToRecordAsync(): Promise<void> {
    if (!PhononStt) throw new Error('Live dictation is not available.');
    this.subscribe();
    // QA (Simulator, no microphone): the same live loop fed from a file in real time.
    const feed = launchArg('phiPhononFeedFile');
    try {
      if (feed) {
        await PhononStt.startFile(fileUri(feed).replace(/^file:\/\//, ''), { autoStop: false });
      } else {
        const info = await PhononStt.start({ configureAudioSession: false });
        this.thermalStart = info?.thermalState ?? null;
        this.footprintStartMB = info?.footprintMB ?? null;
      }
      this.nativeRunning = true;
    } catch (error) {
      this.dispose();
      recordLiveError(`start failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  record(options: { readonly forDuration: number }): void {
    this.startedAt = Date.now();
    this.limitTimer = setTimeout(() => {
      this.limitTimer = null;
      this.stoppedAt = Date.now();
      void this.finish().catch(() => undefined);
      this.deps.onLimitReached(this.uri);
    }, options.forDuration * 1000);
  }

  async stop(): Promise<void> {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    if (this.stoppedAt === null) this.stoppedAt = Date.now();
    if (this.deps.isConfirming()) {
      await this.finish();
      return;
    }
    this.cancel(this.interruptedBy ? 'interrupted' : 'cancelled');
  }

  getStatus(): PhononRecorderState {
    const recording = this.startedAt !== null && this.stoppedAt === null;
    return {
      canRecord: true,
      isRecording: recording,
      durationMillis: this.startedAt === null ? 0 : (this.stoppedAt ?? Date.now()) - this.startedAt,
      mediaServicesDidReset: false,
      metering: this.levelDb,
      url: this.uri,
    };
  }

  /** ✕ or a discard: drop the native session; no text. */
  cancel(outcome: SessionOutcome = 'cancelled'): void {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    if (this.nativeRunning && !this.finishing) PhononStt?.cancel();
    this.nativeRunning = false;
    this.record_(outcome, null);
    this.dispose();
  }

  // ---- internals ----

  private subscribe(): void {
    if (!PhononStt || this.subs.length) return;
    this.subs.push(
      PhononStt.addListener('onPartial', (e) => this.onPartial(e)),
      PhononStt.addListener('onLevel', ({ level }) => {
        this.levelDb = level > 0 ? 20 * Math.log10(level) : undefined;
      }),
      PhononStt.addListener('onInterrupted', ({ message }) => {
        if (this.interruptedBy || !this.nativeRunning) return;
        this.interruptedBy = message;
        this.deps.onInterrupted(message, this.uri);
      }),
      PhononStt.addListener('onError', ({ message }) => recordLiveError(message)),
    );
  }

  private onPartial(e: PhononPartial): void {
    if (this.degraded || !this.nativeRunning) return;
    this.audioSeconds = e.audioSeconds;
    if (typeof e.footprintMB === 'number') {
      this.footprintPeakMB = Math.max(this.footprintPeakMB ?? 0, e.footprintMB);
    }
    if (e.decodeMs > 0) {
      this.decodeMs.push(e.decodeMs);
      if (this.guard.observe(e.decodeMs) === 'slow') {
        this.degrade();
        return;
      }
    }
    // The words on screen are corrected like the final text (memoized: updates repeat them).
    liveTextStore.setState({ text: { committed: this.correct(e.committed), tail: this.correct(e.tail) } });
  }

  private degrade(): void {
    this.degraded = true;
    PhononStt?.degrade();
    markLiveDictationSlow(median(this.guard.observed) ?? 0);
    liveTextStore.setState({ text: null });
    const fallback = this.deps.fallbackTranscriber();
    if (fallback) {
      this.speech = fallback.prepare({ signal: new AbortController().signal });
      this.speech.catch(() => undefined);
    }
    this.deps.onNotice(
      fallback
        ? 'Live dictation is too slow on this iPhone — using standard dictation.'
        : 'Live dictation is too slow on this iPhone and is now off.',
    );
  }

  private finish(): Promise<PhononFinal> {
    if (!this.finishing) this.finishing = this.finishNative();
    return this.finishing;
  }

  private async finishNative(): Promise<PhononFinal> {
    if (!PhononStt) throw new Error('Live dictation is not available.');
    const handOver = this.degraded && this.speech !== null;
    const audioPath = handOver ? new File(Paths.cache, `phonon-fallback-${Date.now()}.wav`).uri : undefined;
    try {
      return await PhononStt.stop(handOver ? { decode: false, audioPath } : {});
    } finally {
      this.nativeRunning = false;
    }
  }

  private async transcribe(signal: AbortSignal): Promise<string> {
    let final: PhononFinal | null = null;
    try {
      final = await this.finish();
      throwIfVoiceTranscriptionAborted(signal);
      let text = final.text;
      if (final.audioUri && this.speech) {
        try {
          const prepared = await this.speech;
          throwIfVoiceTranscriptionAborted(signal);
          text = await prepared.transcribe(final.audioUri, { signal });
        } finally {
          try {
            new File(final.audioUri).delete();
          } catch {}
        }
      }
      this.record_(this.degraded ? 'fell-back' : text.trim() ? 'inserted' : 'no-speech', final, text);
      return text;
    } catch (error) {
      if (!signal.aborted) {
        recordLiveError(`finish failed: ${error instanceof Error ? error.message : String(error)}`);
        this.record_('error', final);
      } else this.record_('cancelled', final);
      throw error;
    } finally {
      this.dispose();
    }
  }

  private record_(outcome: SessionOutcome, final: PhononFinal | null, text = ''): void {
    if (this.recorded || this.startedAt === null) return;
    this.recorded = true;
    recordLiveSession(
      summarizeSession({
        at: this.startedAt,
        outcome,
        decodeMs: this.decodeMs,
        finalMs: final && !final.degraded ? final.latencyMs : null,
        audioSeconds: final?.audioSeconds ?? this.audioSeconds,
        words: wordCount(text),
        footprintStartMB: final?.footprintStartMB ?? this.footprintStartMB,
        footprintPeakMB: final?.footprintPeakMB ?? this.footprintPeakMB,
        footprintEndMB: final?.footprintEndMB ?? null,
        thermalStart: final?.thermalStart ?? this.thermalStart,
        thermalEnd: final?.thermalEnd ?? null,
      }),
    );
  }

  private dispose(): void {
    for (const s of this.subs) s.remove();
    this.subs = [];
    // liveTextStore is cleared by dictation.ts when the phase leaves recording/transcribing, after the commit.
    // The guard tripped: free the model Core ML loaded on the CPU path (it can hold GBs).
    if (this.degraded) unloadLiveDictationModel();
  }
}
