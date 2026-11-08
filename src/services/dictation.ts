/**
 * Dictation into the composer — T3 Code's voice input, ported (MIT; see THIRD_PARTY_NOTICES):
 * record with expo-audio (metering drives the waveform) → on ✓ stop → transcribe the whole
 * recording on this iPhone with Apple SpeechAnalyzer / SpeechTranscriber (iOS 26+, via the
 * patched `@react-native-ai/apple`) → insert the text at the caret. ✕ discards the recording,
 * so the draft is exactly what it was before. No words appear until ✓ ("Transcribing").
 *
 * One recorder and one session for the whole app (T3 `VoiceInputProvider`); each composer
 * binds to it with its draft key (T3 `useVoiceInputController`). The state machine is
 * `@/lib/voice-input` (T3 `@t3tools/client-runtime/voice-input`).
 *
 * Live dictation (Settings › Voice › Live dictation, off by default): when its Phonon-2 model is
 * ready, a new dictation uses `PhononDictation` instead (same controller, a different recorder +
 * transcriber; words appear in the composer as they are recognized). Otherwise — toggle off,
 * model downloading or preparing, non-English language, too slow on this iPhone — the
 * SpeechAnalyzer path below runs unchanged.
 *
 * Microphone (both engines): the iPhone's own, even with headphones connected, unless Settings ›
 * Voice › Microphone is "Headset" (`dictation-audio.ts`, `@/lib/dictation-mic`).
 *
 * Either way the text goes through the dictation dictionary (`./dictionary`) before it lands:
 * your words, skills ("slash jev mobile" → /jev-mobile), models, computers and folders.
 */

import {
  AudioModule,
  getRecordingPermissionsAsync,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  type RecorderState,
  type RecordingStatus,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import { makeMutable, type SharedValue } from 'react-native-reanimated';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import {
  VOICE_RECORDING_LIMIT_SECONDS,
  voiceInputBlocksSubmission,
  type VoiceInputPhase,
  type VoiceInputState,
} from '@/lib/voice-input';
import { createLazyVoiceRecorder, type LazyVoiceRecorder } from '@/lib/voice-input/lazy-recorder';
import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from '@/lib/voice-input/metering';
import { createVoiceInputTarget, VoiceInputSession } from '@/lib/voice-input/session';
import { chooseEngine, liveGettingReady, type DictationEngine } from '@/lib/live-dictation/engine';

import { recordingAudio } from './dictation-audio';
import { injectedRecordingTranscriber, qaRecorder, qaTranscriber } from './dictation-self-test';
import { dictationContextualStrings, withDictionary } from './dictionary';
import { liveStore, phononReady, useLiveDictation } from './live-dictation';
import { liveTextStore, PhononDictation, type LiveText } from './phonon-dictation';
import { stopSpeaking } from './speech';
import { getLocalVoiceTranscriber } from './voice-transcription';

const INITIAL_STATE: VoiceInputState = { phase: 'idle', error: null, errorAction: null };
const VOICE_METERING_INTERVAL_MS = 80;
/** Errors show under the composer for a few seconds, then the control returns to idle. */
const ERROR_MS = 4000;
// The native constructor takes platform-flattened options, as `useAudioRecorder`
// builds them with expo-audio's internal `createRecordingOptions`.
const { ios: IOS_RECORDING_OPTIONS, android: ANDROID_RECORDING_OPTIONS } = RecordingPresets.HIGH_QUALITY;
const VOICE_RECORDING_OPTIONS = {
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
  bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
  isMeteringEnabled: true,
  ...(Platform.OS === 'ios' ? IOS_RECORDING_OPTIONS : ANDROID_RECORDING_OPTIONS),
};

type RuntimeState = {
  state: VoiceInputState;
  ownerKey: string | null;
  elapsedSeconds: number;
  /** Microphone access was refused for good: the mic button opens iOS Settings instead. */
  denied: boolean;
  /** One line above the composer while this dictation runs (live dictation getting ready / fell back). */
  notice: string | null;
};

const store = createStore<RuntimeState>()(() => ({
  state: INITIAL_STATE,
  ownerKey: null,
  elapsedSeconds: 0,
  denied: false,
  notice: null,
}));

type Runtime = {
  session: VoiceInputSession;
  recorder: LazyVoiceRecorder<RecorderState>;
  audioLevels: SharedValue<number[]>;
};

let runtime: Runtime | null = null;
let available: boolean | null = null;
/** The engine of the dictation in progress (chosen when it starts). */
let activeEngine: DictationEngine = 'speech';
let phonon: PhononDictation | null = null;
let gettingReadyShown = false;

const GETTING_READY = 'Live dictation is getting ready — using standard dictation for now.';

/** SpeechTranscriber is usable for the device language (iOS 26+ on supported hardware). */
function isSpeechAvailable(): boolean {
  if (available === null) {
    try {
      available = getTranscriber() !== null;
    } catch {
      available = false;
    }
  }
  return available;
}

/** Some engine can dictate now (SpeechAnalyzer, or live dictation with its model ready). */
export function isDictationAvailable(): boolean {
  return isSpeechAvailable() || phononReady();
}

function engineInput() {
  const s = liveStore.getState();
  return {
    speechAvailable: isSpeechAvailable(),
    phononSupported: s.supported,
    enabled: s.enabled,
    slow: !!s.slow,
    english: s.english,
    prepared: s.prepare === 'prepared',
  };
}

/** True while any composer is preparing, recording or transcribing (haptics and auto-read stay quiet). */
export function isDictating(): boolean {
  return voiceInputBlocksSubmission(store.getState().state);
}

/**
 * Called by the controller when a dictation starts: picks the engine for this dictation.
 * Live dictation when its model is ready, else SpeechAnalyzer (with a one-time note while the
 * live model is still getting ready).
 */
function startTranscriber() {
  const input = engineInput();
  const engine = chooseEngine(input);
  activeEngine = engine === 'phonon' ? 'phonon' : 'speech';
  phonon = null;
  if (engine === 'phonon') {
    phonon = new PhononDictation({
      isConfirming: () => runtime?.session.controller.currentState.phase === 'transcribing',
      onInterrupted: (message) =>
        void runtime?.session.controller.handleRecorderStatus({ isFinished: false, hasError: true, error: message, url: null }),
      onLimitReached: (uri) =>
        void runtime?.session.controller.handleRecorderStatus({ isFinished: true, hasError: false, error: null, url: uri }),
      fallbackTranscriber: () => (isSpeechAvailable() ? getTranscriber() : null),
      onNotice: (notice) => store.setState({ notice }),
    });
    store.setState({ notice: null });
    return phonon.transcriber;
  }
  if (liveGettingReady(input) && !gettingReadyShown) {
    gettingReadyShown = true;
    store.setState({ notice: GETTING_READY });
  } else store.setState({ notice: null });
  return getTranscriber();
}

/**
 * Apple SpeechTranscriber (T3's `getLocalVoiceTranscriber`, told the dictionary's words), plus the
 * launch-argument QA hooks.
 */
function getTranscriber() {
  const transcriber = getLocalVoiceTranscriber(dictationContextualStrings);
  return transcriber ? injectedRecordingTranscriber(transcriber) : qaTranscriber();
}

const blankLevels = () => Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);

function getRuntime(): Runtime {
  if (runtime) return runtime;
  const audioLevels = makeMutable<number[]>(blankLevels());
  let session: VoiceInputSession | null = null;
  const speechRecorder = createLazyVoiceRecorder({
    create: () =>
      (qaRecorder() as unknown as InstanceType<typeof AudioModule.AudioRecorder> | null) ??
      // AudioModule is the native module object (T3 does the same); import/namespace misreads it.
      // eslint-disable-next-line import/namespace
      new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS),
    onStatus: (status: RecordingStatus) => {
      session?.controller.handleRecorderStatus({
        isFinished: status.isFinished,
        hasError: status.hasError || status.mediaServicesDidReset === true,
        error: status.error,
        url: status.url,
      });
    },
  });
  // One recorder for the controller that forwards to the engine chosen for this dictation.
  const live = () => (activeEngine === 'phonon' ? phonon : null);
  const recorder: LazyVoiceRecorder<RecorderState> = {
    get uri() {
      const p = live();
      return p ? p.uri : speechRecorder.uri;
    },
    prepareToRecordAsync: async () => {
      await (live()?.prepareToRecordAsync() ?? speechRecorder.prepareToRecordAsync());
      // expo-audio's prepare sets the category again: select the chosen microphone last.
      await recordingAudio.prepared();
    },
    record: (options) => {
      const p = live();
      if (p) p.record(options);
      else speechRecorder.record(options);
    },
    stop: () => live()?.stop() ?? speechRecorder.stop(),
    getStatus: () => {
      const p = live();
      return p ? (p.getStatus() as unknown as RecorderState) : speechRecorder.getStatus();
    },
    release: () => speechRecorder.release(),
  };
  session = new VoiceInputSession({
    recorder,
    // Every engine's text is corrected against the dictionary (your words, skills, models…).
    getTranscriber: () => withDictionary(startTranscriber()),
    requestPermission: async () => {
      const permission = await requestRecordingPermissionsAsync();
      return { granted: permission.granted, canAskAgain: permission.canAskAgain };
    },
    // The chosen microphone (Settings › Voice › Microphone): the iPhone's own unless "Headset".
    configureRecording: recordingAudio.configure,
    releaseRecording: recordingAudio.release,
    deleteRecording: (uri) => {
      if (!uri.startsWith('phonon:')) new File(uri).delete();
    },
    onStateChange: (nextState) => onStateChange(nextState),
  });
  runtime = { session, recorder, audioLevels };

  AppState.addEventListener('change', (next) => {
    // iOS reports `inactive` while its permission dialog is open. Only the
    // real background state cancels preparation; recorder status handles
    // calls and route interruptions during capture.
    if (next === 'background') session?.controller.appMovedToBackground();
    if (next === 'active' && store.getState().denied) void recheckPermission();
  });
  return runtime;
}

/** After a visit to iOS Settings: drop the "denied" mic once access is possible again. */
async function recheckPermission(): Promise<void> {
  try {
    const permission = await getRecordingPermissionsAsync();
    if (permission.granted || permission.canAskAgain) store.setState({ denied: false });
  } catch {}
}

let keepAwakeSeq = 0;
let releaseKeepAwake: (() => void) | null = null;
let meteringTimer: ReturnType<typeof setInterval> | null = null;
let errorTimer: ReturnType<typeof setTimeout> | null = null;

function onStateChange(next: VoiceInputState): void {
  const rt = runtime;
  const prevPhase = store.getState().state.phase;
  const patch: Partial<RuntimeState> = { state: next, ownerKey: rt?.session.ownerKey ?? null };
  if (next.phase === 'error' && next.errorAction === 'settings') patch.denied = true;
  if (next.phase === 'recording') patch.denied = false;
  if (next.phase === 'idle' || next.phase === 'error') patch.notice = null;
  store.setState(patch);
  // The live words stay on screen through ✓ until the controller has committed them.
  if (!voiceInputBlocksSubmission(next) && liveTextStore.getState().text) liveTextStore.setState({ text: null });

  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = null;
  if (next.phase === 'error') {
    errorTimer = setTimeout(() => {
      if (rt?.session.controller.currentState.phase === 'error') rt.session.controller.cancel();
    }, ERROR_MS);
  }
  if (!rt || next.phase === prevPhase) return;

  // Keep the screen awake while recording (a long dictation otherwise auto-locks mid-sentence).
  if (next.phase === 'recording' && !releaseKeepAwake) {
    const tag = `voice-input:${++keepAwakeSeq}`;
    const activation = activateKeepAwakeAsync(tag);
    void activation.catch(() => {});
    // Release after activation settles, even if the recording ends immediately.
    releaseKeepAwake = () => void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
  } else if (next.phase !== 'recording' && releaseKeepAwake) {
    releaseKeepAwake();
    releaseKeepAwake = null;
  }

  // Metering: sample the recorder every 80 ms into the waveform ring and the clock.
  if (meteringTimer) clearInterval(meteringTimer);
  meteringTimer = null;
  if (next.phase === 'preparing' || next.phase === 'recording') {
    rt.audioLevels.value = blankLevels();
    if (store.getState().elapsedSeconds !== 0) store.setState({ elapsedSeconds: 0 });
  }
  if (next.phase !== 'recording') return;
  const sampleRecording = () => {
    if (rt.session.controller.currentState.phase !== 'recording') return;
    const status = rt.recorder.getStatus();
    if (!status?.isRecording) return;
    const level = normalizeVoiceInputDecibels(status.metering);
    const history = rt.audioLevels.value;
    if (level !== 0 || history.some((sample) => sample !== 0)) {
      rt.audioLevels.value = [...history.slice(1), level];
    }
    const seconds = Math.min(VOICE_RECORDING_LIMIT_SECONDS, Math.max(0, Math.floor(status.durationMillis / 1_000)));
    if (seconds !== store.getState().elapsedSeconds) store.setState({ elapsedSeconds: seconds });
  };
  sampleRecording();
  meteringTimer = setInterval(sampleRecording, VOICE_METERING_INTERVAL_MS);
}

export type Dictation = {
  /** The mic is shown only when on-device transcription exists for the device language. */
  available: boolean;
  /** This composer's phase (`idle` while another composer owns the recorder). */
  phase: VoiceInputPhase;
  /** Last 64 input levels (0…1), newest last, for the waveform. */
  levels: SharedValue<number[]>;
  elapsedSeconds: number;
  error: string | null;
  /** Microphone access was refused: the mic button should open iOS Settings instead. */
  denied: boolean;
  /** Live dictation: the words recognized so far (committed + unstable tail), else null. */
  live: LiveText | null;
  /** One line to show above the composer during this dictation. */
  notice: string | null;
  start: () => void;
  /** ✓: stop recording and transcribe. */
  confirm: () => void;
  /** ✕: discard the recording (or abandon the transcription); the draft is untouched. */
  cancel: () => void;
  openSettings: () => void;
};

const IDLE_LEVELS = makeMutable<number[]>([]);

export function useDictation(opts: {
  /** One per draft (the composer's draft key). */
  ownerKey: string;
  getText: () => string;
  getSelection: () => { start: number; end: number };
  setText: (text: string, selection: { start: number; end: number }) => void;
  /** Calls `onChange` after every change to the draft text. */
  subscribe: (onChange: () => void) => () => void;
}): Dictation {
  const [speechAvailable] = useState(isSpeechAvailable);
  const liveReady = useLiveDictation((s) => phononReady(s));
  const isAvailable = speechAvailable || liveReady;
  const mine = useStore(store, (s) => s.ownerKey === opts.ownerKey);
  const state = useStore(store, (s) => (s.ownerKey === opts.ownerKey ? s.state : INITIAL_STATE));
  const elapsedSeconds = useStore(store, (s) => (s.ownerKey === opts.ownerKey ? s.elapsedSeconds : 0));
  const denied = useStore(store, (s) => s.denied);
  const notice = useStore(store, (s) => (s.ownerKey === opts.ownerKey ? s.notice : null));
  const live = useStore(liveTextStore, (s) => (mine ? s.text : null));
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });

  // Never leave the microphone running after its composer goes away.
  useEffect(
    () => () => {
      runtime?.session.cancel(latest.current.ownerKey);
    },
    [],
  );

  const start = useCallback(() => {
    if (!isAvailable) return;
    const rt = getRuntime();
    const captured = latest.current;
    if (voiceInputBlocksSubmission(rt.session.controller.currentState)) return;
    void stopSpeaking();
    void rt.session.start({
      ...createVoiceInputTarget(
        captured.ownerKey,
        captured.getText,
        (text, selection) => latest.current.setText(text, selection),
        captured.getSelection(),
        captured.subscribe,
      ),
    });
  }, [isAvailable]);

  const confirm = useCallback(() => {
    void runtime?.session.controller.stop();
  }, []);
  const cancel = useCallback(() => {
    runtime?.session.cancel(latest.current.ownerKey);
  }, []);
  const openSettings = useCallback(() => void Linking.openSettings(), []);

  return {
    available: isAvailable,
    phase: state.phase,
    levels: mine && runtime ? runtime.audioLevels : IDLE_LEVELS,
    elapsedSeconds,
    error: state.phase === 'error' ? state.error : null,
    denied,
    live: state.phase === 'recording' || state.phase === 'transcribing' ? live : null,
    notice: state.phase === 'idle' ? null : notice,
    start,
    confirm,
    cancel,
    openSettings,
  };
}
