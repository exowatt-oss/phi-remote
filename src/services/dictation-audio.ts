/**
 * The audio session around a dictation (both engines), wired to expo-audio, the native mic-route
 * module and the saved choice in Settings › Voice › Microphone. Order and reasons:
 * `src/lib/dictation-mic.ts`. In dev builds every step logs the active route
 * (`[mic] prefer selected: input MicrophoneBuiltIn "iPhone Microphone" · output …`).
 */

import { setAudioModeAsync, setIsAudioActiveAsync } from 'expo-audio';

import MicRoute from '../../modules/mic-route';
import { createRecordingAudio, describeRoute, dictationMic } from '@/lib/dictation-mic';

import { remote } from './remote';

const log = __DEV__ ? (line: string) => console.log(`[mic] ${line}`) : undefined;

if (log) MicRoute?.addListener('onRouteChange', (report) => log(describeRoute(report)));

export const recordingAudio = createRecordingAudio({
  setAudioMode: (mode) => setAudioModeAsync(mode),
  setActive: (active) => setIsAudioActiveAsync(active),
  route: MicRoute,
  mic: () => dictationMic(remote.store.getState().prefs),
  log,
});
