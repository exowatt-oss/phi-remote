/**
 * Read-aloud: speaks assistant replies in a natural voice that runs on this iPhone (Kokoro-82M,
 * `natural-voice.ts` + modules/kokoro-tts), streamed piece by piece so the first words start
 * after one short synthesis; or with the system voice (AVSpeechSynthesizer via expo-speech, the
 * best installed one unless another is picked) when that is chosen or the natural voice is not
 * ready, which is said once, quietly. Text is cleaned for speech (`speakableText`, then
 * `spokenForm` for the natural voice). Playback uses the app's own audio session in the
 * `playback` category, so it is audible with the ring/silent switch on silent, ducks (rather
 * than stops) a podcast, and headphones stay in full-quality A2DP. Stop is instant.
 */

import { createAudioPlayer, setAudioModeAsync, setIsAudioActiveAsync, type AudioPlayer } from 'expo-audio';
import * as Speech from 'expo-speech';
import { AppState, Platform } from 'react-native';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { showToast } from '@/components/toast';
import { chunkSpeech, isNovelty, pickBestVoice, speakableText, type VoiceLike } from '@/lib/speech';
import { systemNotice, type SystemReason } from '@/lib/tts/engine';
import { handoverText } from '@/lib/tts/reader';
import { speechPieces, spokenForm } from '@/lib/tts/spoken';

import { errorMessage, naturalChoice, naturalStore, offerNaturalDownload, readNatural, stopNatural } from './natural-voice';
import { remote } from './remote';

type SpeechState = { speakingId: string | null };

export const speechStore = createStore<SpeechState>()(() => ({ speakingId: null }));

export function useSpeakingId(): string | null {
  return useStore(speechStore, (s) => s.speakingId);
}

let voicesCache: VoiceLike[] | null = null;

// Voices can be downloaded while phi is in the background: refresh on every foreground.
AppState.addEventListener('change', (state) => {
  if (state === 'active') voicesCache = null;
  else if (state === 'background') void stopSpeaking();
});

export async function installedVoices(): Promise<VoiceLike[]> {
  if (!voicesCache) {
    try {
      voicesCache = (await Speech.getAvailableVoicesAsync())
        .map((v) => ({ identifier: v.identifier, name: v.name, quality: String(v.quality), language: v.language }))
        .filter((v) => !isNovelty(v));
    } catch {
      voicesCache = [];
    }
  }
  return voicesCache;
}

export function deviceLanguage(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
}

/** The system voice used when the user has not picked one. */
export async function defaultVoice(): Promise<VoiceLike | null> {
  return pickBestVoice(await installedVoices(), deviceLanguage());
}

/** The system voice to read with: the one picked in Settings › Voice, else the best installed. */
export async function chosenSystemVoice(): Promise<VoiceLike | null> {
  const id = remote.store.getState().prefs.voiceId;
  const voices = await installedVoices();
  return (id && voices.find((v) => v.identifier === id)) || pickBestVoice(voices, deviceLanguage());
}

let sessionActive = false;

/** `playback` category (audible on silent) that ducks other audio, via expo-audio. */
async function activateSession(): Promise<void> {
  if (Platform.OS !== 'ios' || sessionActive) return;
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'duckOthers',
      allowsRecording: false,
      shouldPlayInBackground: false,
    });
    await setIsAudioActiveAsync(true);
    sessionActive = true;
  } catch {
    // Falls back to the synthesizer's own session.
  }
}

function releaseSession(): void {
  if (Platform.OS !== 'ios' || !sessionActive) return;
  sessionActive = false;
  // Deactivating notifies other apps (duckOthers) so a podcast returns to full volume.
  void setIsAudioActiveAsync(false).catch(() => undefined);
}

/** Why the system voice reads, said once per app run (and again when the reason's detail changes). */
const noticed = new Set<string>();

function notice(reason: SystemReason, detail?: string): void {
  const text = systemNotice(reason, detail);
  const key = `${reason}\n${detail ?? ''}`;
  if (!text || noticed.has(key)) return;
  noticed.add(key);
  showToast(text, false, { icon: 'speaker.wave.2', durationMs: reason === 'load-failed' ? 6000 : 4000 });
}

let token = 0;
let sample: AudioPlayer | null = null;

function stopSample(): void {
  if (!sample) return;
  try {
    sample.remove();
  } catch {}
  sample = null;
}

export async function stopSpeaking(): Promise<void> {
  token += 1;
  const wasSpeaking = speechStore.getState().speakingId !== null;
  speechStore.setState({ speakingId: null });
  if (!wasSpeaking) return;
  stopSample();
  stopNatural();
  await Speech.stop().catch(() => undefined);
  releaseSession();
}

/** System voice: queues ≤1,000-character chunks with expo-speech; `finish` runs at the end or on stop. */
function speakSystem(text: string, voice: VoiceLike | null, rate: number, finish: () => void): void {
  const chunks = chunkSpeech(text);
  if (chunks.length === 0) {
    finish();
    return;
  }
  chunks.forEach((chunk, i) => {
    Speech.speak(chunk, {
      voice: voice?.identifier,
      language: voice ? undefined : deviceLanguage(),
      rate,
      useApplicationAudioSession: sessionActive,
      onDone: i === chunks.length - 1 ? finish : undefined,
      onStopped: finish,
      onError: finish,
    });
  });
}

/**
 * Speaks already-clean text as item `id`, replacing anything being read. `systemVoice` given
 * (a Settings preview of a system voice): that voice, never the natural one.
 */
async function speakText(id: string, text: string, systemVoice?: VoiceLike | null): Promise<void> {
  await stopSpeaking();
  if (!text.trim()) return;
  const mine = ++token;
  const rate = remote.store.getState().prefs.speechRate ?? 1;
  const finish = () => {
    if (mine !== token) return;
    speechStore.setState({ speakingId: null });
    releaseSession();
  };
  speechStore.setState({ speakingId: id });
  await activateSession();
  if (mine !== token) {
    // Stopped while the session was activating: give the audio session back.
    if (speechStore.getState().speakingId === null) releaseSession();
    return;
  }
  let rest = text;
  if (systemVoice === undefined) {
    const { choice, voice } = await naturalChoice();
    if (mine !== token) return;
    if (choice.engine === 'natural') {
      const pieces = speechPieces(spokenForm(text), rate);
      const result = await readNatural(pieces, voice, rate, () => mine !== token);
      if (mine !== token) return;
      if (result.outcome === 'slow') notice('slow');
      if (result.outcome === 'error') {
        notice('failed');
        naturalStore.setState({ error: `last reply used the system voice (${errorMessage(result.error)})` });
      } else if (result.outcome === 'done' && naturalStore.getState().error) naturalStore.setState({ error: null });
      rest = handoverText(pieces, result);
      if (!rest) {
        finish();
        return;
      }
    } else if (!(choice.reason === 'not-downloaded' && offerNaturalDownload())) notice(choice.reason, choice.detail);
  }
  const v = systemVoice === undefined ? await chosenSystemVoice() : systemVoice;
  if (mine !== token) return;
  speakSystem(rest, v, rate, finish);
}

/** Starts reading a markdown reply aloud as item `id`. */
export function speak(id: string, markdown: string): Promise<void> {
  return speakText(id, speakableText(markdown));
}

/** Speaker button behaviour: start reading this item, or stop if it is the one being read. */
export function toggleSpeak(id: string, markdown: string): void {
  if (speechStore.getState().speakingId === id) void stopSpeaking();
  else void speak(id, markdown);
}

/** Settings preview of a system voice (or the current choice) at the chosen speed. */
export function previewVoice(voice?: VoiceLike | null): void {
  void (async () => speakText('__preview__', 'This is how phi reads replies aloud.', voice ?? (await chosenSystemVoice())))();
}

/** Two-second clips of each natural voice, made with the model itself (they play before it is downloaded). */
const SAMPLES: Record<string, number> = {
  af_heart: require('../../assets/voice-samples/af_heart.m4a'),
  af_bella: require('../../assets/voice-samples/af_bella.m4a'),
  af_sarah: require('../../assets/voice-samples/af_sarah.m4a'),
  am_michael: require('../../assets/voice-samples/am_michael.m4a'),
  am_fenrir: require('../../assets/voice-samples/am_fenrir.m4a'),
  am_puck: require('../../assets/voice-samples/am_puck.m4a'),
};

/** Settings: plays a natural voice's sample clip. */
export async function previewNaturalVoice(voice: string): Promise<void> {
  const source = SAMPLES[voice];
  if (!source) return;
  await stopSpeaking();
  const mine = ++token;
  speechStore.setState({ speakingId: '__preview__' });
  await activateSession();
  if (mine !== token) return;
  const player = createAudioPlayer(source);
  sample = player;
  player.addListener('playbackStatusUpdate', (s) => {
    if (!s.didJustFinish || sample !== player) return;
    stopSample();
    if (mine === token) {
      speechStore.setState({ speakingId: null });
      releaseSession();
    }
  });
  player.play();
}
