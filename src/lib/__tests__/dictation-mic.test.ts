import {
  createRecordingAudio,
  describeRoute,
  dictationMic,
  recordingAudioMode,
  type DictationMic,
  type MicRouteReportLike,
} from '../dictation-mic';
import { HostStorage, MemoryKV } from '../storage';

const report = (reason: string, action: string, input: string | null): MicRouteReportLike => ({
  reason,
  action,
  input: input ? { type: input, name: input === 'MicrophoneBuiltIn' ? 'iPhone Microphone' : 'AirPods' } : null,
  outputs: [{ type: 'BluetoothA2DPOutput', name: 'AirPods' }],
});

function harness(
  mic: DictationMic = 'iphone',
  opts: { preferFails?: boolean; modeFails?: boolean; noRoute?: boolean; noLog?: boolean } = {},
) {
  const calls: string[] = [];
  const logs: string[] = [];
  let chosen = mic;
  const audio = createRecordingAudio({
    setAudioMode: async (mode) => {
      calls.push(`mode ${JSON.stringify(mode)}`);
      if (opts.modeFails && mode.allowsRecording) throw new Error('category refused');
    },
    setActive: async (active) => {
      calls.push(`active ${active}`);
    },
    route: opts.noRoute
      ? null
      : {
          prefer: async (m) => {
            calls.push(`prefer ${m}`);
            if (opts.preferFails) throw new Error('no session');
            return report('prefer', 'selected', m === 'iphone' ? 'MicrophoneBuiltIn' : 'BluetoothHFP');
          },
          release: async () => {
            calls.push('route release');
            return report('release', 'cleared', null);
          },
        },
    mic: () => chosen,
    log: opts.noLog ? undefined : (line) => logs.push(line),
  });
  return { audio, calls, logs, choose: (m: DictationMic) => (chosen = m) };
}

const RECORD_IPHONE = {
  allowsRecording: true,
  interruptionMode: 'doNotMix',
  playsInSilentMode: true,
  shouldPlayInBackground: false,
  allowsBluetoothHFP: false,
};

describe('dictation microphone', () => {
  it('defaults to the iPhone microphone', () => {
    expect(dictationMic(undefined)).toBe('iphone');
    expect(dictationMic({})).toBe('iphone');
    expect(dictationMic({ dictationMic: 'iphone' })).toBe('iphone');
    expect(dictationMic({ dictationMic: 'headset' })).toBe('headset');
    expect(dictationMic({ dictationMic: 'airpods' as DictationMic })).toBe('iphone');
  });

  it('allows Bluetooth HFP only for the headset', () => {
    expect(recordingAudioMode('iphone')).toEqual(RECORD_IPHONE);
    expect(recordingAudioMode('headset')).toEqual({ ...RECORD_IPHONE, allowsBluetoothHFP: true });
  });

  it('configures the category, activates, then selects the iPhone mic; selects it again after prepare', async () => {
    const { audio, calls } = harness('iphone');
    await audio.configure();
    expect(calls).toEqual([`mode ${JSON.stringify(RECORD_IPHONE)}`, 'active true', 'prefer iphone']);
    await audio.prepared();
    expect(calls.slice(3)).toEqual(['prefer iphone']);
  });

  it('asks for the headset mic with HFP allowed when Headset is chosen', async () => {
    const { audio, calls } = harness('headset');
    await audio.configure();
    expect(calls).toEqual([
      `mode ${JSON.stringify({ ...RECORD_IPHONE, allowsBluetoothHFP: true })}`,
      'active true',
      'prefer headset',
    ]);
  });

  it('reads the choice when each dictation starts', async () => {
    const { audio, calls, choose } = harness('iphone');
    await audio.configure();
    await audio.release();
    choose('headset');
    calls.length = 0;
    await audio.configure();
    expect(calls).toContain('prefer headset');
    expect(calls).not.toContain('prefer iphone');
  });

  it('release stops selecting, leaves play-and-record, then deactivates', async () => {
    const { audio, calls } = harness('iphone');
    await audio.configure();
    calls.length = 0;
    await audio.release();
    expect(calls).toEqual(['route release', 'mode {"allowsRecording":false}', 'active false']);
    // Nothing is selected after release (a stray prepared() is a no-op).
    calls.length = 0;
    await audio.prepared();
    expect(calls).toEqual([]);
  });

  it('selects and releases the mic in release builds too (no logger)', async () => {
    const { audio, calls } = harness('iphone', { noLog: true });
    await audio.configure();
    await audio.prepared();
    await audio.release();
    expect(calls).toEqual([
      `mode ${JSON.stringify(RECORD_IPHONE)}`,
      'active true',
      'prefer iphone',
      'prefer iphone',
      'route release',
      'mode {"allowsRecording":false}',
      'active false',
    ]);
  });

  it('a failed selection never stops the dictation', async () => {
    const { audio, calls, logs } = harness('iphone', { preferFails: true });
    await expect(audio.configure()).resolves.toBeUndefined();
    expect(calls).toEqual([`mode ${JSON.stringify(RECORD_IPHONE)}`, 'active true', 'prefer iphone']);
    expect(logs[0]).toMatch(/could not select the iphone microphone/);
  });

  it('a refused category releases the session and fails the start', async () => {
    const { audio, calls } = harness('iphone', { modeFails: true });
    await expect(audio.configure()).rejects.toThrow('category refused');
    expect(calls).toEqual([`mode ${JSON.stringify(RECORD_IPHONE)}`, 'mode {"allowsRecording":false}', 'active false']);
  });

  it('works without the native module (Android, Expo Go)', async () => {
    const { audio, calls } = harness('iphone', { noRoute: true });
    await audio.configure();
    await audio.prepared();
    await audio.release();
    expect(calls).toEqual([`mode ${JSON.stringify(RECORD_IPHONE)}`, 'active true', 'mode {"allowsRecording":false}', 'active false']);
  });

  it('logs the active route', () => {
    expect(describeRoute(report('prefer', 'selected', 'MicrophoneBuiltIn'))).toBe(
      'prefer selected: input MicrophoneBuiltIn "iPhone Microphone" · output BluetoothA2DPOutput "AirPods"',
    );
    expect(describeRoute({ ...report('release', 'cleared', null), outputs: [], error: 'x' })).toBe(
      'release cleared: input none · output none · x',
    );
    expect(describeRoute({ ...report('prefer', 'kept', 'MicrophoneBuiltIn'), options: ['allowBluetoothA2DP', 'defaultToSpeaker'] })).toBe(
      'prefer kept: input MicrophoneBuiltIn "iPhone Microphone" · output BluetoothA2DPOutput "AirPods" · allowBluetoothA2DP,defaultToSpeaker',
    );
  });

  it('persists the choice in Prefs', async () => {
    const kv = new MemoryKV();
    const s = new HostStorage(kv);
    await s.savePrefs({ dictationMic: 'headset', autoRead: true });
    expect(await s.loadPrefs()).toEqual({ dictationMic: 'headset', autoRead: true });
    await s.savePrefs({ dictationMic: 'iphone' });
    expect(await s.loadPrefs()).toEqual({ dictationMic: 'iphone' });
    await kv.set('phiremote.prefs.v1', JSON.stringify({ dictationMic: 'airpods', speechRate: 1 }));
    expect(await s.loadPrefs()).toEqual({ speechRate: 1 });
  });
});
