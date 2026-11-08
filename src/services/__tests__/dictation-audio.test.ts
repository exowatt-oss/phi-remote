/**
 * The dictation wiring: the voice-input controller starts a recording through
 * `recordingAudio` (src/services/dictation-audio.ts), which reads the saved microphone and asks
 * the native mic-route module for it, before and after the recorder is prepared (as
 * src/services/dictation.ts wires it), and releases it when the recording ends.
 */
import { resetVoiceInputGlobalsForTests } from '@/lib/voice-input/controller';
import { createVoiceInputTarget, VoiceInputSession } from '@/lib/voice-input/session';
import type { Prefs } from '@/lib/storage';

const mockCalls: string[] = [];
let mockPrefs: Prefs = {};

jest.mock('expo-audio', () => ({
  setAudioModeAsync: jest.fn(async (mode: { allowsRecording?: boolean; allowsBluetoothHFP?: boolean }) => {
    mockCalls.push(mode.allowsRecording ? `category play-and-record hfp=${mode.allowsBluetoothHFP}` : 'category off');
  }),
  setIsAudioActiveAsync: jest.fn(async (active: boolean) => {
    mockCalls.push(`active ${active}`);
  }),
}));

jest.mock('../../../modules/mic-route', () => ({
  __esModule: true,
  default: {
    addListener: jest.fn(),
    prefer: jest.fn(async (mic: string) => {
      mockCalls.push(`prefer ${mic}`);
      const input = mic === 'iphone' ? { type: 'MicrophoneBuiltIn', name: 'iPhone Microphone', uid: 'b' } : { type: 'BluetoothHFP', name: 'AirPods', uid: 'h' };
      return { mic, reason: 'prefer', action: 'selected', input, outputs: [], preferred: input, available: [input], category: 'AVAudioSessionCategoryPlayAndRecord', options: [] };
    }),
    release: jest.fn(async () => {
      mockCalls.push('release mic');
      return { mic: null, reason: 'release', action: 'cleared', input: null, outputs: [], preferred: null, available: [], category: '', options: [] };
    }),
  },
}));

jest.mock('../remote', () => ({ remote: { store: { getState: () => ({ prefs: mockPrefs }) } } }));

// eslint-disable-next-line import/first
import { recordingAudio } from '../dictation-audio';

function startSession() {
  // The recorder as dictation.ts wraps it: prepare, then select the chosen microphone again.
  const recorder = {
    uri: 'file:///voice.m4a',
    prepareToRecordAsync: async () => {
      mockCalls.push('recorder prepare');
      await recordingAudio.prepared();
    },
    record: () => mockCalls.push('record'),
    stop: async () => {
      mockCalls.push('recorder stop');
    },
  };
  const session = new VoiceInputSession({
    recorder,
    getTranscriber: () => ({ prepare: async () => ({ locale: 'en-US', transcribe: async () => 'hello' }) }),
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: recordingAudio.configure,
    releaseRecording: recordingAudio.release,
    deleteRecording: () => {},
    onStateChange: () => {},
  });
  const target = createVoiceInputTarget('draft', () => '', () => {}, { start: 0, end: 0 }, () => () => {});
  return { session, start: () => session.start(target) };
}

describe('dictation asks for the chosen microphone', () => {
  beforeEach(() => {
    resetVoiceInputGlobalsForTests();
    mockCalls.length = 0;
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('records from the iPhone mic by default, then releases it', async () => {
    mockPrefs = {};
    const { session, start } = startSession();
    await start();
    expect(session.controller.currentState.phase).toBe('recording');
    expect(mockCalls).toEqual([
      'category play-and-record hfp=false',
      'active true',
      'prefer iphone',
      'recorder prepare',
      'prefer iphone',
      'record',
    ]);
    mockCalls.length = 0;
    await session.controller.stop();
    expect(mockCalls).toEqual(['recorder stop', 'release mic', 'category off', 'active false']);
  });

  it('records from the headset mic when Headset is chosen', async () => {
    mockPrefs = { dictationMic: 'headset' };
    const { start } = startSession();
    await start();
    expect(mockCalls).toEqual([
      'category play-and-record hfp=true',
      'active true',
      'prefer headset',
      'recorder prepare',
      'prefer headset',
      'record',
    ]);
  });

  it('cancel releases the microphone too', async () => {
    mockPrefs = { dictationMic: 'iphone' };
    const { session, start } = startSession();
    await start();
    mockCalls.length = 0;
    session.controller.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockCalls).toEqual(expect.arrayContaining(['release mic', 'category off', 'active false']));
    expect(mockCalls.indexOf('release mic')).toBeLessThan(mockCalls.indexOf('category off'));
  });
});
