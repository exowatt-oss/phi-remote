/**
 * The dictionary service: transcripts corrected through `withDictionary`, your words saved to and
 * read back from Documents/dictionary.json, and a computer's vocabulary picked up when it connects.
 */

import { createStore } from 'zustand/vanilla';

import type { VoiceTranscriber } from '@/lib/voice-input';

import { correctTranscript, deleteWord, dictionaryStore, initDictionary, livePreviewCorrector, saveWord, withDictionary } from '../dictionary';

const mockFiles = new Map<string, string>();
const mockRemote = {
  store: createStore<Record<string, unknown>>()(() => ({
    ready: false,
    hostOrder: [] as string[],
    hosts: {},
    sessions: {},
    history: {},
    commands: {},
  })),
  listModels: jest.fn(async () => ({ models: [{ provider: 'example', id: 'fast', name: 'Example Fast', reasoning: true }], thinkingLevels: [] })),
  recentCwds: jest.fn(async () => ['/Users/f/projects/sample-project']),
  ensureCommands: jest.fn(),
};

// A getter: jest.mock factories run before this file's constants exist.
jest.mock('../remote', () => ({
  get remote() {
    return mockRemote;
  },
}));
jest.mock('expo-file-system', () => ({
  Paths: { document: '/docs' },
  File: class {
    private readonly path: string;
    constructor(dir: string, name: string) {
      this.path = `${dir}/${name}`;
    }
    get exists() {
      return mockFiles.has(this.path);
    }
    create() {
      mockFiles.set(this.path, '');
    }
    write(text: string) {
      mockFiles.set(this.path, text);
    }
    async text() {
      return mockFiles.get(this.path) ?? '';
    }
  },
}));


const engine = (text: string, locale = 'en-US'): VoiceTranscriber => ({
  prepare: async () => ({ locale, transcribe: async () => text }),
});

beforeAll(() => jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }));
afterAll(() => jest.useRealTimers());

/** Let pending timers (debounced harvest and save) and the promises behind them run. */
async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await jest.runOnlyPendingTimersAsync();
    for (let j = 0; j < 5; j += 1) await Promise.resolve();
  }
}

describe('dictionary service', () => {
  beforeAll(async () => {
    mockFiles.set('/docs/dictionary.json', JSON.stringify({ version: 1, words: [{ text: 'Alex', heardAs: ['pure on jay'] }], hubs: {} }));
    initDictionary();
    await settle();
  });

  it('reads your words from Documents/dictionary.json at start', () => {
    expect(dictionaryStore.getState().loaded).toBe(true);
    expect(dictionaryStore.getState().file.words).toEqual([{ text: 'Alex', heardAs: ['pure on jay'] }]);
    expect(correctTranscript('ask pure on jay', 'en-US')).toBe('ask Alex');
  });

  it('corrects what a transcriber returns; other languages get "heard as" spellings only', async () => {
    const signal = new AbortController().signal;
    const en = await withDictionary(engine('on deep seek deep seek site'))!.prepare({ signal });
    await expect(en.transcribe('file:///a.m4a', { signal })).resolves.toBe('on DeepSeek DeepSeek site');
    const es = await withDictionary(engine('el deep seek y deepseek', 'es-ES'))!.prepare({ signal });
    await expect(es.transcribe('file:///a.m4a', { signal })).resolves.toBe('el DeepSeek y deepseek');
    expect(withDictionary(null)).toBeNull();
  });

  it('saves your words to the file (and removes them)', async () => {
    saveWord({ text: 'Jev', heardAs: ['Jeff'] });
    await settle();
    expect(JSON.parse(mockFiles.get('/docs/dictionary.json')!).words).toEqual([
      { text: 'Alex', heardAs: ['pure on jay'] },
      { text: 'Jev', heardAs: ['Jeff'] },
    ]);
    expect(correctTranscript('we should have Jeff in there', 'en-US')).toBe('we should have Jev in there');
    deleteWord('jev');
    await settle();
    expect(JSON.parse(mockFiles.get('/docs/dictionary.json')!).words).toEqual([{ text: 'Alex', heardAs: ['pure on jay'] }]);
    expect(correctTranscript('we should have Jeff in there', 'en-US')).toBe('we should have Jeff in there');
  });

  it('learns a computer’s models and folders when it connects, and keeps them in the file', async () => {
    mockRemote.store.setState({
      ready: true,
      hostOrder: ['h1'],
      hosts: { h1: { hubId: 'h1', name: 'MY-MAC', conn: { status: 'live' } } },
      sessions: { h1: { s1: { sessionId: 's1', kind: 'interactive', cwd: '/Users/f/ExampleCo/phi-remote', lastActivityAt: 1 } } },
      commands: { 'h1\ns1': { status: 'ready', commands: [{ name: 'skill:jev-mobile', source: 'skill' }] } },
    });
    await settle();
    expect(mockRemote.ensureCommands).toHaveBeenCalledWith('h1', 's1');
    mockRemote.ensureCommands.mockClear();
    const hub = dictionaryStore.getState().file.hubs.h1;
    expect(hub).toMatchObject({ name: 'MY-MAC', models: ['Example Fast'], commands: [{ name: 'skill:jev-mobile', source: 'skill' }] });
    expect(hub.folders).toEqual(['phi-remote', 'sample-project']);
    expect(correctTranscript('forward slash Jeff mobile', 'en-US')).toBe('/jev-mobile');
    expect(JSON.parse(mockFiles.get('/docs/dictionary.json')!).hubs.h1.name).toBe('MY-MAC');

    // Commands never fetched (sessions arrived after the computer connected): asked for once harvested.
    mockRemote.store.setState({ commands: {}, sessions: { h1: { s2: { sessionId: 's2', kind: 'interactive', cwd: '/x/example', lastActivityAt: 2 } } } });
    await settle();
    expect(mockRemote.ensureCommands).toHaveBeenCalledWith('h1', 's2');

    // Unpaired: its words go.
    mockRemote.store.setState({ hostOrder: [], hosts: {}, sessions: {}, commands: {} });
    await settle();
    expect(dictionaryStore.getState().file.hubs).toEqual({});
  });

  it('remembers the last live updates it corrected', () => {
    const correct = livePreviewCorrector();
    expect(correct('the deep seek')).toBe('the DeepSeek');
    expect(correct('the deep seek')).toBe('the DeepSeek');
    expect(correct('')).toBe('');
  });
});
