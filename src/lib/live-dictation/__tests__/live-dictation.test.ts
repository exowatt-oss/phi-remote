import { resolveTranscriptCommit } from '@/lib/voice-input';

import { aneVerdict, MAX_SESSIONS, pushSession, summarizeSession, wordCount } from '../diagnostics';
import { chooseEngine, isEnglishLocale, liveGettingReady, liveWanted, type EngineInput } from '../engine';
import { median, percentile, PerfGuard, slowStillApplies, type SlowRecord } from '../perf-guard';
import { displayTail, livePreview, previewText } from '../preview';
import { downloadAllowed, nextAction, PREPARE_COLD_LABEL, statusLine, type LiveState } from '../status';

const engine = (patch: Partial<EngineInput> = {}): EngineInput => ({
  speechAvailable: true,
  phononSupported: true,
  enabled: false,
  slow: false,
  english: true,
  prepared: false,
  ...patch,
});

describe('engine selection', () => {
  it('toggle off (the default): always SpeechAnalyzer, no "getting ready" note', () => {
    expect(chooseEngine(engine())).toBe('speech');
    expect(chooseEngine(engine({ prepared: true }))).toBe('speech');
    expect(liveGettingReady(engine())).toBe(false);
  });
  it('toggle on: SpeechAnalyzer + the note until the model is prepared, then Phonon', () => {
    expect(chooseEngine(engine({ enabled: true }))).toBe('speech');
    expect(liveGettingReady(engine({ enabled: true }))).toBe(true);
    expect(chooseEngine(engine({ enabled: true, prepared: true }))).toBe('phonon');
    expect(liveGettingReady(engine({ enabled: true, prepared: true }))).toBe(false);
  });
  it('never Phonon when too slow, not English, unsupported (iOS < 18)', () => {
    expect(chooseEngine(engine({ enabled: true, prepared: true, slow: true }))).toBe('speech');
    expect(chooseEngine(engine({ enabled: true, prepared: true, english: false }))).toBe('speech');
    expect(chooseEngine(engine({ enabled: true, prepared: true, phononSupported: false }))).toBe('speech');
    expect(liveGettingReady(engine({ enabled: true, slow: true }))).toBe(false);
  });
  it('without SpeechAnalyzer (iOS 18–25): Phonon when ready, else no mic', () => {
    expect(chooseEngine(engine({ speechAvailable: false }))).toBeNull();
    expect(chooseEngine(engine({ speechAvailable: false, enabled: true }))).toBeNull();
    expect(chooseEngine(engine({ speechAvailable: false, enabled: true, prepared: true }))).toBe('phonon');
  });
  it('liveWanted and English locales', () => {
    expect(liveWanted({ phononSupported: true, enabled: true, slow: false, english: true })).toBe(true);
    expect(isEnglishLocale('en-US')).toBe(true);
    expect(isEnglishLocale('en_GB')).toBe(true);
    expect(isEnglishLocale('en')).toBe(true);
    expect(isEnglishLocale('es-ES')).toBe(false);
    expect(isEnglishLocale('eng')).toBe(false);
    expect(isEnglishLocale(null)).toBe(false);
  });
});

describe('performance guard', () => {
  it('Neural Engine speed passes after 3 fast updates', () => {
    const g = new PerfGuard();
    expect(g.observe(40)).toBe('pending');
    expect(g.observe(35)).toBe('pending');
    expect(g.observe(60)).toBe('ok');
    expect(g.observe(5000)).toBe('ok');
  });
  it('CPU fallback (median of the first 5 > 500 ms) trips as soon as 3 are slow', () => {
    const g = new PerfGuard();
    expect(g.observe(900)).toBe('pending');
    expect(g.observe(30)).toBe('pending');
    expect(g.observe(1200)).toBe('pending');
    expect(g.observe(700)).toBe('slow');
    expect(median(g.observed)).toBe(800);
  });
  it('matches the median rule on every 5-update window', () => {
    const windows = [
      [600, 600, 10, 10, 10],
      [10, 600, 10, 600, 600],
      [501, 499, 501, 499, 500],
      [500, 500, 500, 500, 500],
    ];
    for (const w of windows) {
      const g = new PerfGuard();
      let v = g.verdict;
      for (const ms of w) v = g.observe(ms);
      expect(v).toBe((median(w) ?? 0) > 500 ? 'slow' : 'ok');
    }
  });
  it('custom limit (QA launch argument)', () => {
    const g = new PerfGuard(5000);
    [900, 800, 1000].forEach((ms) => g.observe(ms));
    expect(g.verdict).toBe('ok');
  });
  it('the "too slow" verdict lasts until the app or iOS version changes', () => {
    const rec: SlowRecord = { at: 1, medianMs: 900, appVersion: '0.1.0', appBuild: '7', osVersion: 'Version 26.1 (Build 23B85)' };
    expect(slowStillApplies(rec, { appVersion: '0.1.0', appBuild: '7', osVersion: 'Version 26.1 (Build 23B85)' })).toBe(true);
    expect(slowStillApplies(rec, { appVersion: '0.1.0', appBuild: '8', osVersion: 'Version 26.1 (Build 23B85)' })).toBe(false);
    expect(slowStillApplies(rec, { appVersion: '0.1.0', appBuild: '7', osVersion: 'Version 26.2 (Build 23C5)' })).toBe(false);
    expect(slowStillApplies(null, { appVersion: '', appBuild: '', osVersion: '' })).toBe(false);
  });
  it('percentiles', () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
  });
});

describe('live preview (committed / muted tail split)', () => {
  it('inserts at the caret with the same spacing ✓ uses', () => {
    const draft = 'Fix the build.then ship';
    const sel = { start: 14, end: 14 };
    const p = livePreview(draft, sel, 'Run the tests', 'and', 'en-US', { hideTrailingPeriod: false })!;
    expect(p).toMatchObject({ committed: 'Run the tests', gap: ' ', tail: 'and' });
    const commit = resolveTranscriptCommit(
      { ownerKey: 'k', text: draft, selection: sel, revision: 0 },
      { ownerKey: 'k', text: draft, selection: sel, revision: 0 },
      'Run the tests and',
      'en-US',
    );
    expect(commit.kind).toBe('commit');
    if (commit.kind === 'commit') {
      expect(previewText(p)).toBe(commit.text);
      expect(p.caret).toBe(commit.selection.start);
    }
  });
  it('appends to the end of a draft and to an empty draft', () => {
    const p = livePreview('Hello', { start: 5, end: 5 }, '', 'world', 'en-US')!;
    expect(previewText(p)).toBe('Hello world');
    expect(p.caret).toBe(11);
    const e = livePreview('', { start: 0, end: 0 }, 'One.', 'Two', 'en-US')!;
    expect(e).toMatchObject({ before: '', committed: 'One.', gap: ' ', tail: 'Two', after: '' });
  });
  it('replaces a selection', () => {
    const p = livePreview('keep THIS keep', { start: 5, end: 9 }, 'that', '', 'en-US')!;
    expect(previewText(p)).toBe('keep that keep');
  });
  it('hides the trailing period of the unstable tail only', () => {
    expect(displayTail('in the meantime.')).toBe('in the meantime');
    expect(displayTail('wait...')).toBe('wait...');
    const p = livePreview('', { start: 0, end: 0 }, 'Done.', 'next step.', 'en-US')!;
    expect(p.committed).toBe('Done.');
    expect(p.tail).toBe('next step');
  });
  it('nothing recognized yet: no preview (the draft shows as is)', () => {
    expect(livePreview('draft', { start: 5, end: 5 }, '', ' ', 'en-US')).toBeNull();
  });
});

const net = { wifi: { connected: true, expensive: false, constrained: false }, cell: { connected: true, expensive: true, constrained: false } };
const state = (patch: Partial<LiveState> = {}): LiveState => ({
  supported: true,
  enabled: false,
  cellular: false,
  english: true,
  slow: null,
  model: 'absent',
  fraction: 0,
  prepare: 'idle',
  coldPrepare: true,
  error: null,
  network: net.wifi,
  ...patch,
});

describe('download gating by network', () => {
  it('Wi-Fi only by default; cellular, hotspot and Low Data Mode wait', () => {
    expect(downloadAllowed(net.wifi, false)).toBe(true);
    expect(downloadAllowed(net.cell, false)).toBe(false);
    expect(downloadAllowed({ connected: true, expensive: false, constrained: true }, false)).toBe(false);
    expect(downloadAllowed({ connected: null, expensive: false, constrained: false }, false)).toBe(false);
  });
  it('"Download on cellular" allows any connected network', () => {
    expect(downloadAllowed(net.cell, true)).toBe(true);
    expect(downloadAllowed({ connected: true, expensive: false, constrained: true }, true)).toBe(true);
    expect(downloadAllowed({ connected: false, expensive: false, constrained: false }, true)).toBe(false);
  });
});

describe('settings state machine', () => {
  it('toggle off (default): nothing downloads or prepares', () => {
    expect(nextAction(state())).toBe('none');
    expect(nextAction(state({ model: 'downloaded' }))).toBe('none');
    expect(statusLine(state()).label).toBe('Not downloaded');
  });
  it('toggle on: download on Wi-Fi, wait on cellular, then prepare', () => {
    expect(nextAction(state({ enabled: true }))).toBe('download');
    expect(nextAction(state({ enabled: true, network: net.cell }))).toBe('none');
    expect(statusLine(state({ enabled: true, network: net.cell })).label).toBe('Not downloaded · waiting for Wi-Fi');
    expect(nextAction(state({ enabled: true, network: net.cell, cellular: true }))).toBe('download');
    expect(nextAction(state({ enabled: true, model: 'downloading' }))).toBe('none');
    expect(nextAction(state({ enabled: true, model: 'downloaded' }))).toBe('prepare');
    expect(nextAction(state({ enabled: true, model: 'downloaded', prepare: 'prepared' }))).toBe('none');
    expect(nextAction(state({ enabled: true, model: 'downloaded', prepare: 'failed' }))).toBe('none');
  });
  it('never starts when too slow, not English or unsupported', () => {
    const slow: SlowRecord = { at: 1, medianMs: 900, appVersion: '1', appBuild: '1', osVersion: 'x' };
    expect(nextAction(state({ enabled: true, slow }))).toBe('none');
    expect(nextAction(state({ enabled: true, english: false }))).toBe('none');
    expect(nextAction(state({ enabled: true, supported: false }))).toBe('none');
  });
  it('status lines', () => {
    expect(statusLine(state({ enabled: true, model: 'downloading', fraction: 0.423 })).label).toBe('Downloading 42%');
    expect(statusLine(state({ enabled: true, model: 'downloading', fraction: 0.5, network: net.cell })).label).toBe(
      'Downloading 50% · waiting for Wi-Fi',
    );
    expect(statusLine(state({ enabled: true, model: 'compiling' })).label).toBe(PREPARE_COLD_LABEL);
    expect(statusLine(state({ enabled: true, model: 'downloaded', prepare: 'preparing' })).label).toBe('Preparing (one time, about 2 min)');
    expect(statusLine(state({ enabled: true, model: 'downloaded', prepare: 'preparing', coldPrepare: false })).label).toBe('Preparing…');
    expect(statusLine(state({ enabled: true, model: 'downloaded', prepare: 'prepared' }))).toEqual({ label: 'Ready', tone: 'success' });
    expect(statusLine(state({ model: 'downloaded' })).label).toBe('Downloaded · off');
    const slow: SlowRecord = { at: 1, medianMs: 900, appVersion: '1', appBuild: '1', osVersion: 'x' };
    expect(statusLine(state({ enabled: true, slow, model: 'downloaded' })).label).toBe('Off (too slow on this iPhone)');
    expect(statusLine(state({ supported: false })).label).toBe('Needs iOS 18 or later');
    expect(statusLine(state({ enabled: true, fraction: 0.3, network: { connected: false, expensive: false, constrained: false } })).label).toBe(
      'Not downloaded (30%) · offline',
    );
  });
});

describe('diagnostics', () => {
  it('summarizes a session without any text', () => {
    const d = summarizeSession({ at: 1, outcome: 'inserted', decodeMs: [30, 40, 35, 120, 33], finalMs: 41.6, audioSeconds: 12.34, words: 20 });
    expect(d).toMatchObject({ updates: 5, medianMs: 35, p95Ms: 120, maxMs: 120, finalMs: 42, audioSeconds: 12.3, words: 20 });
    expect(Object.values(d).some((v) => typeof v === 'string' && v.length > 20)).toBe(false);
  });
  it('keeps the last 5 sessions, newest first', () => {
    let list: ReturnType<typeof pushSession> = [];
    for (let i = 0; i < 7; i++) list = pushSession(list, summarizeSession({ at: i, outcome: 'inserted', decodeMs: [] }));
    expect(list).toHaveLength(MAX_SESSIONS);
    expect(list[0].at).toBe(6);
  });
  it('Neural Engine verdict from the median update time', () => {
    expect(aneVerdict(40).tone).toBe('success');
    expect(aneVerdict(300).tone).toBe('warning');
    expect(aneVerdict(900).tone).toBe('danger');
    expect(aneVerdict(null).tone).toBe('secondary');
    expect(wordCount(' a  b c ')).toBe(3);
  });
});
