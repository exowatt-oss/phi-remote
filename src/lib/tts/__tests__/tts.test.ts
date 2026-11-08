import { PerfGuard } from '../../live-dictation/perf-guard';
import { speakableText } from '../../speech';
import { HostStorage, MemoryKV } from '../../storage';
import {
  canLoad,
  chooseEngine,
  countCrash,
  crashesStillApply,
  LOAD_TIMEOUT_MS,
  parseTimeouts,
  READ_WAIT_MS,
  REALTIME_MS_PER_SECOND,
  shortReason,
  shouldLoad,
  statusLine,
  systemNotice,
  type NaturalState,
} from '../engine';
import { formatTtsEvent, parseTtsLog, TTS_LOG_FILE, TtsLog } from '../tts-log';
import { handoverText, MAX_SCHEDULED, readPieces, type ReaderDeps, type SynthesizedPiece } from '../reader';
import {
  CLAUSE_PAUSE,
  FIRST_PIECE_CHARS,
  HARD_PIECE_CHARS,
  PIECE_CHARS,
  PRONUNCIATIONS,
  SENTENCE_PAUSE,
  speechPieces,
  splitSentences,
  spokenForm,
  type SpeechPiece,
} from '../spoken';
import { DEFAULT_NATURAL_VOICE, isTtsVoicePref, NATURAL_VOICES, resolveTtsVoice, SYSTEM_VOICE } from '../voices';

describe('spokenForm', () => {
  it.each([
    ['CPU at 12%', 'CPU at 12 percent'],
    ['It costs $40.', 'It costs 40 dollars.'],
    ['$1 and $2.5M', '1 dollar and 2.5 million dollars'],
    ['bumped to v0.18.2', 'bumped to version 0 point 18 point 2'],
    ['ships in 1.2.3 today', 'ships in 1 point 2 point 3 today'],
    ['a 2 GB file and 1 GB more', 'a 2 gigabytes file and 1 gigabyte more'],
    ['waits 2s, then 250 ms', 'waits 2 seconds, then 250 milliseconds'],
    ['in the 1990s', 'in the 1990s'],
    ['5 MW and 20 kWh', '5 megawatts and 20 kilowatt hours'],
    ['5x faster, 1.5x more', '5 times faster, 1.5 times more'],
    ['10-15 minutes', '10 to 15 minutes'],
    ['call 555-123-4567', 'call 555-123-4567'],
    ['on 2026-11-05', 'on November 5, 2026'],
    ['due Nov 5 and Dec. 12', 'due November 5 and December 12'],
    ['1,234,567 rows', '1234567 rows'],
    ['~227 MB', 'about 227 megabytes'],
    ['tests, e.g. this one', 'tests, for example, this one'],
    ['old vs. new', 'old versus new'],
    ['R&D', 'R and D'],
    ['edit remote.ts and alerts.yaml', 'edit remote dot T S and alerts dot yaml'],
    ['example.com stays', 'example.com stays'],
  ])('%s', (input, out) => {
    expect(spokenForm(input)).toBe(out);
  });

  it('keeps plain words, decimals and times for the model', () => {
    expect(spokenForm('It took 3.5 seconds at 10:30 am.')).toBe('It took 3.5 seconds at 10:30 am.');
  });

  it('works on what speakableText leaves of a reply (code, paths and links already gone)', () => {
    const md = 'Done: see `src/services/remote.ts` and https://github.com/x/y.\n\n```ts\nconst a = 1;\n```\n\nIt is 20% faster.';
    expect(spokenForm(speakableText(md))).toBe('Done: see remote dot T S and link to github.com. Code block omitted. It is 20 percent faster.');
  });
});

describe('pronunciations', () => {
  it('has lower-case keys in the model alphabet, phi rhyming with fly', () => {
    expect(PRONUNCIATIONS.phi).toBe('fˈI');
    for (const [word, ipa] of Object.entries(PRONUNCIATIONS)) {
      expect(word).toBe(word.toLowerCase());
      expect(ipa).toMatch(/ˈ/);
      expect(ipa).not.toMatch(/[A-Z]{2}/);
    }
  });
});

describe('speechPieces', () => {
  it('never splits inside a decimal or a version', () => {
    expect(splitSentences('It took 3.5 s. Then v1.2 shipped! Done')).toEqual(['It took 3.5 s.', 'Then v1.2 shipped!', 'Done']);
  });

  it('merges short sentences, keeps the first piece short and later sentences whole', () => {
    const text =
      'Done. All 42 tests pass. ' +
      'The socket now waits two seconds before it retries, which stops the reconnect storm we saw on the train this morning. ' +
      'Want me to push it?';
    const pieces = speechPieces(text);
    expect(pieces[0].text).toBe('Done. All 42 tests pass.');
    expect(pieces[1].text).toBe(
      'The socket now waits two seconds before it retries, which stops the reconnect storm we saw on the train this morning. Want me to push it?',
    );
    expect(pieces).toHaveLength(2);
    expect(pieces[0].pause).toBe(SENTENCE_PAUSE);
    expect(pieces[1].pause).toBe(0);
  });

  it('splits a long first sentence at a comma, with a shorter pause there', () => {
    const pieces = speechPieces(
      'I looked at the reconnect logic in the client, and the socket retries immediately when the network changes, so it floods the hub.',
    );
    expect(pieces[0].text).toBe('I looked at the reconnect logic in the client,');
    expect(pieces[0].pause).toBe(CLAUSE_PAUSE);
    expect(pieces.map((p) => p.text).join(' ')).toBe(
      'I looked at the reconnect logic in the client, and the socket retries immediately when the network changes, so it floods the hub.',
    );
  });

  it('keeps every piece within its limit and loses no words', () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
    const text = `${words.slice(0, 120).join(' ')}. ${words.slice(120, 200).join(', ')}. ${words.slice(200).join(' ')}.`;
    const pieces = speechPieces(text);
    expect(pieces[0].text.length).toBeLessThanOrEqual(FIRST_PIECE_CHARS);
    for (const p of pieces) expect(p.text.length).toBeLessThanOrEqual(HARD_PIECE_CHARS);
    expect(pieces.map((p) => p.text).join(' ').replace(/[,.]/g, '').split(/\s+/)).toEqual(words);
  });

  it('fits more words per piece when reading faster, and pauses less', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const normal = speechPieces(text, 1);
    const fast = speechPieces(text, 1.5);
    expect(fast.length).toBeLessThan(normal.length);
    for (const p of fast.slice(1)) expect(p.text.length).toBeLessThanOrEqual(PIECE_CHARS * 1.5);
    expect(fast[0].pause).toBeCloseTo(SENTENCE_PAUSE / 1.5);
  });

  it('returns nothing for empty text', () => {
    expect(speechPieces('   ')).toEqual([]);
  });
});

/** A fake engine: synthesis and playback resolve when the test says so, every call is logged. */
function fakeEngine(opts: { audioSeconds?: number; synthMs?: number; failAt?: number } = {}) {
  const events: string[] = [];
  const plays: { id: number; resolve: (heard: boolean) => void }[] = [];
  let cancelled = false;
  let nextId = 0;
  const deps: ReaderDeps = {
    synthesize: async (p: SpeechPiece): Promise<SynthesizedPiece> => {
      const id = ++nextId;
      events.push(`synth ${p.text}`);
      if (opts.failAt === id) throw new Error('boom');
      return { id, audioSeconds: opts.audioSeconds ?? 2, synthMs: opts.synthMs ?? 200 };
    },
    play: (id) =>
      new Promise<boolean>((resolve) => {
        events.push(`play ${id}`);
        plays.push({ id, resolve });
      }),
    cancelled: () => cancelled,
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  /** The oldest scheduled piece finishes (heard or not). */
  const finish = async (heard = true) => {
    plays.shift()?.resolve(heard);
    await flush();
  };
  const stop = async () => {
    cancelled = true;
    for (const p of plays.splice(0)) p.resolve(false);
    await flush();
  };
  return { deps, events, plays, finish, stop, flush };
}

const pieces = (n: number): SpeechPiece[] => Array.from({ length: n }, (_, i) => ({ text: `p${i}`, pause: 0.3 }));

describe('readPieces', () => {
  it('streams: synthesizes ahead while pieces play, never more than MAX_SCHEDULED at once', async () => {
    const e = fakeEngine();
    const done = readPieces(pieces(5), e.deps);
    await e.flush();
    // p0..p2 synthesized and scheduled at once (the first words do not wait for the rest).
    expect(e.events).toEqual(['synth p0', 'play 1', 'synth p1', 'play 2', 'synth p2', 'play 3']);
    expect(e.plays).toHaveLength(MAX_SCHEDULED);
    await e.finish();
    expect(e.events.slice(-2)).toEqual(['synth p3', 'play 4']);
    expect(e.plays).toHaveLength(MAX_SCHEDULED);
    await e.finish();
    await e.finish();
    await e.finish();
    await e.finish();
    await expect(done).resolves.toEqual({ outcome: 'done', next: 5 });
  });

  it('stop: nothing more is synthesized or played', async () => {
    const e = fakeEngine();
    const done = readPieces(pieces(6), e.deps);
    await e.flush();
    await e.finish();
    const before = e.events.length;
    await e.stop();
    await expect(done).resolves.toMatchObject({ outcome: 'stopped' });
    expect(e.events).toHaveLength(before);
  });

  it('an interruption (a call, Siri) ends the read without stop()', async () => {
    const e = fakeEngine();
    const done = readPieces(pieces(4), e.deps);
    await e.flush();
    await e.finish(false);
    await expect(done).resolves.toMatchObject({ outcome: 'interrupted' });
  });

  it('a synthesis error lets the scheduled pieces finish, then hands over from the failed piece', async () => {
    const e = fakeEngine({ failAt: 2 });
    const done = readPieces(pieces(4), e.deps);
    await e.flush();
    expect(e.events).toEqual(['synth p0', 'play 1', 'synth p1']);
    let settled = false;
    void done.then(() => (settled = true));
    await e.flush();
    expect(settled).toBe(false);
    await e.finish();
    const result = await done;
    expect(result).toMatchObject({ outcome: 'error', next: 1 });
    expect(handoverText(pieces(4), result)).toBe('p1 p2 p3');
  });

  it('too slow: the perf guard trips, the rest goes to the system voice', async () => {
    const e = fakeEngine({ audioSeconds: 2, synthMs: 2600 });
    const guard = new PerfGuard(REALTIME_MS_PER_SECOND, 5);
    e.deps.timing = (ms, s) => guard.observe(ms / s) === 'slow';
    const done = readPieces(pieces(8), e.deps);
    await e.flush();
    for (let i = 0; i < 3; i++) await e.finish();
    const result = await done;
    expect(result).toEqual({ outcome: 'slow', next: 3 });
    expect(handoverText(pieces(8), result)).toBe('p3 p4 p5 p6 p7');
  });

  it('faster than real time: the guard says ok and stays out of the way', async () => {
    const guard = new PerfGuard(REALTIME_MS_PER_SECOND, 5);
    for (const ratio of [300, 250, 900]) guard.observe(ratio);
    expect(guard.verdict).toBe('ok');
  });

  it('done and stopped hand nothing over', () => {
    expect(handoverText(pieces(3), { outcome: 'done', next: 3 })).toBe('');
    expect(handoverText(pieces(3), { outcome: 'stopped', next: 1 })).toBe('');
  });
});

const ready: NaturalState = {
  supported: true,
  model: 'ready',
  fraction: 1,
  damaged: false,
  loaded: true,
  loading: false,
  loadUnits: 'ane',
  loadStartedAt: null,
  loadStage: null,
  loadFailure: null,
  slow: null,
  crashed: false,
  broken: false,
  waitingForWifi: false,
  error: null,
};
const stamp = { appVersion: '0.1.0', appBuild: '42', osVersion: '27.1' };

describe('engine choice (fallback to the system voice)', () => {
  it('reads with the natural voice only when it is loaded', () => {
    expect(chooseEngine('af_heart', ready)).toEqual({ engine: 'natural' });
    expect(chooseEngine(SYSTEM_VOICE, ready)).toEqual({ engine: 'system', reason: 'chosen' });
    expect(chooseEngine('af_heart', { ...ready, supported: false })).toEqual({ engine: 'system', reason: 'unsupported' });
    expect(chooseEngine('af_heart', { ...ready, model: 'absent', loaded: false })).toEqual({ engine: 'system', reason: 'not-downloaded' });
    expect(chooseEngine('af_heart', { ...ready, model: 'downloading', loaded: false })).toEqual({ engine: 'system', reason: 'downloading' });
    expect(chooseEngine('af_heart', { ...ready, model: 'compiling', loaded: false })).toEqual({ engine: 'system', reason: 'downloading' });
    expect(chooseEngine('af_heart', { ...ready, loaded: false })).toEqual({ engine: 'system', reason: 'preparing' });
    expect(chooseEngine('af_heart', { ...ready, loaded: false, loading: true })).toEqual({ engine: 'system', reason: 'preparing' });
    expect(chooseEngine('af_heart', { ...ready, loaded: false, loadFailure: 'CPU: boom' })).toEqual({
      engine: 'system',
      reason: 'load-failed',
      detail: 'CPU: boom',
    });
    expect(chooseEngine('af_heart', { ...ready, slow: { ...stamp, at: 1, medianMs: 1400 } })).toEqual({ engine: 'system', reason: 'slow' });
    expect(chooseEngine('af_heart', { ...ready, crashed: true })).toEqual({ engine: 'system', reason: 'crashed' });
    expect(chooseEngine('af_heart', { ...ready, broken: true })).toEqual({ engine: 'system', reason: 'broken' });
  });

  it('says why once, and nothing when the system voice was chosen', () => {
    expect(systemNotice('chosen')).toBeNull();
    expect(systemNotice('unsupported')).toBeNull();
    expect(systemNotice('preparing')).toBe('Preparing the natural voice (the first time can take a minute). Using the system voice.');
    expect(systemNotice('load-failed', 'Neural Engine: E5RT error 11')).toBe(
      "The natural voice couldn't load on this iPhone: Neural Engine: E5RT error 11. Using the system voice.",
    );
    expect(systemNotice('broken')).toMatch(/no usable audio/);
    expect(systemNotice('slow')).toMatch(/too slow/);
    expect(systemNotice('not-downloaded')).toMatch(/Settings › Voice/);
    expect(systemNotice('failed')).toMatch(/could not read this reply/);
  });

  it('loads only when it would read', () => {
    expect(shouldLoad('af_heart', { ...ready, loaded: false })).toBe(true);
    expect(shouldLoad(SYSTEM_VOICE, { ...ready, loaded: false })).toBe(false);
    expect(shouldLoad('af_heart', { ...ready, loaded: false, loading: true })).toBe(false);
    expect(shouldLoad('af_heart', { ...ready, loaded: false, model: 'absent' })).toBe(false);
    expect(shouldLoad('af_heart', { ...ready, loaded: false, crashed: true })).toBe(false);
    expect(shouldLoad('af_heart', { ...ready, loaded: false, broken: true })).toBe(false);
    expect(shouldLoad('af_heart', { ...ready, loaded: false, loadFailure: 'x' })).toBe(false);
    expect(canLoad({ ...ready, loaded: false })).toBe(true);
    expect(canLoad({ ...ready, loaded: false, model: 'compiling' })).toBe(false);
  });

  it('crash guard: two crashes on the same app and iOS version turn it off; an update starts over', () => {
    const one = countCrash(null, stamp, 1);
    expect(crashesStillApply(one, stamp)).toBe(false);
    const two = countCrash(one, stamp, 2);
    expect(two.count).toBe(2);
    expect(crashesStillApply(two, stamp)).toBe(true);
    const updated = { ...stamp, osVersion: '27.2' };
    expect(crashesStillApply(two, updated)).toBe(false);
    expect(countCrash(two, updated, 3).count).toBe(1);
  });

  it('status line for Settings', () => {
    expect(statusLine({ ...ready, loaded: false, loadUnits: null }).label).toBe('Ready');
    expect(statusLine(ready)).toEqual({ label: 'Loaded · Neural Engine', tone: 'success' });
    expect(statusLine({ ...ready, loadUnits: 'cpu' }).label).toBe('Loaded · CPU');
    expect(statusLine({ ...ready, loaded: false, loading: true, loadStartedAt: 1_000 }, 35_500).label).toBe(
      'Preparing the voice (the first time can take a minute)… 34 s',
    );
    expect(statusLine({ ...ready, loaded: false, loading: true, loadUnits: 'gpu', loadStartedAt: 1_000 }, 5_000).label).toBe(
      'Preparing the voice on the GPU… 4 s',
    );
    expect(statusLine({ ...ready, loaded: false, loadFailure: 'timed out (Neural Engine 120 s)' })).toEqual({
      label: 'Failed: timed out (Neural Engine 120 s)',
      tone: 'danger',
    });
    expect(statusLine({ ...ready, loaded: false, model: 'absent', damaged: true, fraction: 0.8 }).label).toBe('Needs repair · some files are missing');
    expect(statusLine({ ...ready, loaded: false, model: 'downloading', damaged: true, fraction: 0.8 }).label).toBe('Repairing 80%');
    expect(statusLine({ ...ready, model: 'absent', fraction: 0 }).label).toBe('Not downloaded');
    expect(statusLine({ ...ready, model: 'absent', fraction: 0.4 }).label).toBe('Not downloaded (40%)');
    expect(statusLine({ ...ready, model: 'downloading', fraction: 0.425 }).label).toBe('Downloading 42%');
    expect(statusLine({ ...ready, model: 'downloading', fraction: 0.1, waitingForWifi: true }).label).toBe('Downloading 10% · waiting for Wi-Fi');
    expect(statusLine({ ...ready, model: 'compiling' }).label).toBe('Preparing the files…');
    expect(statusLine({ ...ready, model: 'absent', error: 'Not enough space: free up 40 MB on this iPhone.' }).label).toMatch(/Not enough space/);
    expect(statusLine({ ...ready, slow: { ...stamp, at: 1, medianMs: 1200 } })).toEqual({ label: 'Off · too slow on this iPhone', tone: 'warning' });
    expect(statusLine({ ...ready, supported: false }).label).toBe('Needs iOS 18 or later');
    expect(statusLine({ ...ready, broken: true }).label).toBe('Off · no usable audio on this iPhone');
    expect(statusLine({ ...ready, loaded: false, error: 'last reply used the system voice (boom)' })).toEqual({
      label: 'Ready · last reply used the system voice (boom)',
      tone: 'warning',
    });
  });

  it('load timeouts: generous for the first Neural Engine compile; overridable for QA', () => {
    expect(LOAD_TIMEOUT_MS).toEqual({ ane: 120_000, gpu: 60_000, cpu: 60_000 });
    expect(READ_WAIT_MS).toBe(3_000);
    expect(parseTimeouts(null)).toEqual(LOAD_TIMEOUT_MS);
    expect(parseTimeouts('ane=8, cpu=1.5,gpu=-1,xyz=3,gpu')).toEqual({ ane: 8_000, gpu: 60_000, cpu: 1_500 });
  });

  it('short reasons: no paths, no Expo wrapper, one line, bounded', () => {
    expect(shortReason("Calling the 'load' function has failed\n→ Caused by: Missing model at /var/mobile/Containers/Data/x/KokoroAlbert.mlmodelc.")).toBe(
      'Missing model at …/KokoroAlbert.mlmodelc',
    );
    expect(shortReason('a\n  b')).toBe('a b');
    expect(shortReason('')).toBe('unknown error');
    expect(shortReason('x'.repeat(300)).length).toBe(140);
  });
});

describe('voice preference', () => {
  it('defaults to Heart, keeps "system", ignores unknown ids', () => {
    expect(DEFAULT_NATURAL_VOICE).toBe('af_heart');
    expect(NATURAL_VOICES.length).toBeGreaterThanOrEqual(4);
    expect(NATURAL_VOICES.length).toBeLessThanOrEqual(6);
    expect(resolveTtsVoice(undefined)).toBe('af_heart');
    expect(resolveTtsVoice('am_michael')).toBe('am_michael');
    expect(resolveTtsVoice('system')).toBe('system');
    expect(resolveTtsVoice('zf_001')).toBe('af_heart');
    expect(isTtsVoicePref('af_bella')).toBe(true);
    expect(isTtsVoicePref('nope')).toBe(false);
  });

  it('persists in Prefs; a stored unknown voice is dropped', async () => {
    const kv = new MemoryKV();
    const s = new HostStorage(kv);
    await s.savePrefs({ ttsVoice: 'am_michael', speechRate: 1.15 });
    expect(await s.loadPrefs()).toEqual({ ttsVoice: 'am_michael', speechRate: 1.15 });
    await s.savePrefs({ ttsVoice: 'system', voiceId: 'com.apple.voice.premium.en-US.Zoe' });
    expect(await s.loadPrefs()).toEqual({ ttsVoice: 'system', voiceId: 'com.apple.voice.premium.en-US.Zoe' });
    await kv.set('phiremote.prefs.v1', JSON.stringify({ ttsVoice: 'bf_emma', autoRead: true }));
    expect(await s.loadPrefs()).toEqual({ autoRead: true });
  });
});

describe('read-aloud log (ring buffer)', () => {
  function memFiles() {
    const m = new Map<string, string>();
    return {
      m,
      files: {
        read: async (n: string) => m.get(n) ?? null,
        write: async (n: string, d: string) => void m.set(n, d),
        remove: async (n: string) => void m.delete(n),
      },
    };
  }

  it('keeps the newest events, persists them, and reads back what it wrote', async () => {
    let t = 1_000;
    const { m, files } = memFiles();
    const log = new TtsLog({ files, limit: 3, now: () => t++ });
    await log.load();
    for (const k of ['a', 'b', 'c', 'd']) log.record('attempt', k, 1500);
    expect(log.events().map((e) => e.text)).toEqual(['b', 'c', 'd']);
    expect(log.events(2).map((e) => e.text)).toEqual(['c', 'd']);
    await log.flush();
    const again = new TtsLog({ files, limit: 3 });
    again.record('launch', 'new');
    await again.load();
    expect(again.events().map((e) => e.text)).toEqual(['c', 'd', 'new']);
    await again.flush();
    expect(parseTtsLog(m.get(TTS_LOG_FILE) ?? null)).toHaveLength(3);
    expect(formatTtsEvent({ at: new Date(2026, 10, 5, 12, 0, 1, 5).getTime(), kind: 'loaded', text: 'ane', ms: 17_700 })).toBe(
      '2026-11-05 12:00:01.005 loaded ane · 17.7 s',
    );
  });

  it('drops anything malformed', () => {
    expect(parseTtsLog('nope')).toEqual([]);
    expect(parseTtsLog(JSON.stringify({ v: 2, events: [] }))).toEqual([]);
    expect(parseTtsLog(JSON.stringify({ v: 1, events: [{ at: 1, kind: 'bogus', text: 'x' }, { at: 2, kind: 'read', text: 'ok' }] }))).toEqual([
      { at: 2, kind: 'read', text: 'ok' },
    ]);
  });
});
