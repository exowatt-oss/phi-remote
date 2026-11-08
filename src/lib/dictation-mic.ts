/**
 * Which microphone dictation records from (Settings › Voice › Microphone), and the order of the
 * audio-session calls around every recording, for both engines (SpeechAnalyzer's expo-audio
 * recorder and live dictation's Phonon microphone tap):
 *
 *   configure  expo-audio play-and-record category: Bluetooth HFP only for "Headset", otherwise
 *              A2DP, so connected headphones keep playing in full quality and cannot become the
 *              input; activate the session; then select the chosen microphone (native mic-route,
 *              which selects it again after every route change until release)
 *   prepared   select it again after the recorder is prepared (expo-audio's prepareToRecordAsync
 *              sets the category once more, so the selection is the last word before recording)
 *   release    stop selecting, leave play-and-record and deactivate (headphones never stay in
 *              call mode; other apps' audio resumes)
 *
 * Why "iPhone" is the default: with HFP allowed, iOS routes a play-and-record session's input to
 * the most recently connected headset, so a dictation picked up the headphones' microphone instead
 * of the phone the user was talking into, and dropped the headphones to call-quality audio.
 */

export type DictationMic = 'iphone' | 'headset';

export const DICTATION_MICS: readonly { value: DictationMic; label: string }[] = [
  { value: 'iphone', label: 'iPhone' },
  { value: 'headset', label: 'Headset' },
];

export function isDictationMic(value: unknown): value is DictationMic {
  return value === 'iphone' || value === 'headset';
}

/** The saved choice; "iPhone" unless the user picked "Headset". */
export function dictationMic(prefs: { dictationMic?: DictationMic } | null | undefined): DictationMic {
  return prefs?.dictationMic === 'headset' ? 'headset' : 'iphone';
}

/** expo-audio mode for a recording (`allowsBluetoothHFP` is phi remote's expo-audio patch). */
export type RecordingAudioMode = {
  allowsRecording: true;
  interruptionMode: 'doNotMix';
  playsInSilentMode: true;
  shouldPlayInBackground: false;
  allowsBluetoothHFP: boolean;
};

export function recordingAudioMode(mic: DictationMic): RecordingAudioMode {
  return {
    allowsRecording: true,
    interruptionMode: 'doNotMix',
    playsInSilentMode: true,
    shouldPlayInBackground: false,
    allowsBluetoothHFP: mic === 'headset',
  };
}

type Port = { type: string; name: string };

/** What the native mic-route module reports after each step (see modules/mic-route). */
export type MicRouteReportLike = {
  reason: string;
  action: string;
  input: Port | null;
  outputs: readonly Port[];
  options?: readonly string[];
  error?: string;
};

export type MicRouteLike = {
  prefer(mic: DictationMic): Promise<MicRouteReportLike>;
  release(): Promise<MicRouteReportLike>;
};

/** One log line: `prefer selected: input MicrophoneBuiltIn "iPhone Microphone" · output BluetoothA2DPOutput "AirPods" · allowBluetoothA2DP,defaultToSpeaker`. */
export function describeRoute(r: MicRouteReportLike): string {
  const port = (p: Port) => `${p.type} "${p.name}"`;
  const outputs = r.outputs.length ? r.outputs.map(port).join(', ') : 'none';
  const options = r.options?.length ? ` · ${r.options.join(',')}` : '';
  return `${r.reason} ${r.action}: input ${r.input ? port(r.input) : 'none'} · output ${outputs}${options}${r.error ? ` · ${r.error}` : ''}`;
}

export type RecordingAudioDeps = {
  setAudioMode: (mode: RecordingAudioMode | { allowsRecording: false }) => Promise<void>;
  setActive: (active: boolean) => Promise<void>;
  /** Native mic-route; null where it does not exist (Android, web, Expo Go). */
  route: MicRouteLike | null;
  /** The saved choice, read when each dictation starts. */
  mic: () => DictationMic;
  log?: (line: string) => void;
};

export type RecordingAudio = {
  configure(): Promise<void>;
  prepared(): Promise<void>;
  release(): Promise<void>;
};

export function createRecordingAudio(deps: RecordingAudioDeps): RecordingAudio {
  let mic: DictationMic | null = null;

  // A failed selection never stops a dictation: it records from iOS's choice instead.
  const select = async () => {
    if (!mic || !deps.route) return;
    try {
      const report = await deps.route.prefer(mic);
      deps.log?.(describeRoute(report));
    } catch (error) {
      deps.log?.(`could not select the ${mic} microphone: ${String(error)}`);
    }
  };

  const release = async () => {
    const held = mic;
    mic = null;
    if (held && deps.route) {
      try {
        const report = await deps.route.release();
        deps.log?.(describeRoute(report));
      } catch {}
    }
    try {
      await deps.setAudioMode({ allowsRecording: false });
    } finally {
      // Expo does not deactivate AVAudioSession when recording stops or its
      // category changes. Explicit deactivation resumes interrupted app audio.
      await deps.setActive(false);
    }
  };

  return {
    async configure() {
      const chosen = deps.mic();
      try {
        await deps.setAudioMode(recordingAudioMode(chosen));
        await deps.setActive(true);
      } catch (error) {
        try {
          await release();
        } catch {}
        throw error;
      }
      mic = chosen;
      await select();
    },
    prepared: select,
    release,
  };
}
