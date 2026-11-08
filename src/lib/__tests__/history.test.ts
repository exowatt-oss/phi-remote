import { FakeSocket, session } from '../__fixtures__/fake-socket';
import { RemoteClient, ResumeError } from '../client';
import {
  applyPage,
  cacheableTranscript,
  emptyHubHistory,
  historyView,
  matchesQuery,
  parseIndex,
  resumeErrorText,
  sectionize,
  sectionTitle,
  serializeIndex,
  touchManifest,
  transcriptFileName,
  type HubHistory,
} from '../history';
import { HistoryCache, MemoryFiles } from '../history-cache';
import { pastBlockReason, pastComposerNote, sendToPast } from '../past-session';
import type { FetchLike, PairedHost } from '../pairing';
import { parsePastSession, parseServerFrame, type PastSession, type TranscriptItem } from '../protocol';
import { HostStorage, MemoryKV } from '../storage';
import { selectTranscript, transcriptKey, type HostView } from '../store';
import { emptyTranscript, transcriptReducer } from '../transcript';

const NOW = new Date(2026, 10, 3, 12, 0, 0).getTime();
const H = 3_600_000;
const D = 24 * H;

function past(id: string, modifiedAt: number, extra: Partial<PastSession> = {}): PastSession {
  return {
    sessionId: id,
    title: `Session ${id}`,
    named: false,
    cwd: '/Users/f/ExampleCo/phi',
    createdAt: modifiedAt - H,
    modifiedAt,
    messageCount: 4,
    live: false,
    resumable: true,
    ...extra,
  };
}

const user = (id: string, text = id): TranscriptItem => ({ id, ts: 1, kind: 'user', text });
const reply = (id: string, text = id): TranscriptItem => ({ id, ts: 1, kind: 'assistant', text });

describe('protocol: session history frames', () => {
  it('parses PastSession defensively', () => {
    expect(parsePastSession({ sessionId: '' })).toBeNull();
    expect(parsePastSession({ sessionId: 'a', title: '  ', cwd: '/x/proj', createdAt: 5 })).toEqual({
      sessionId: 'a',
      title: 'proj',
      named: false,
      cwd: '/x/proj',
      createdAt: 5,
      modifiedAt: 5,
      messageCount: 0,
      live: false,
      resumable: true,
    });
    const s = parsePastSession({ sessionId: 'b', title: 'T', resumable: false, live: true, liveKind: 'weird', model: { provider: 'p', id: '' } });
    expect(s).toMatchObject({ resumable: false, live: true });
    expect(s).not.toHaveProperty('liveKind');
    expect(s).not.toHaveProperty('model');
  });

  it('parses sessions.past (dupes dropped) and session.transcript, and welcome features', () => {
    const f = parseServerFrame({ t: 'sessions.past', re: 'r1', sessions: [{ sessionId: 'a' }, { sessionId: 'a' }, 7], nextCursor: 'c', indexing: true });
    expect(f).toMatchObject({ t: 'sessions.past', re: 'r1', nextCursor: 'c', indexing: true });
    expect(f && f.t === 'sessions.past' && f.sessions.map((s) => s.sessionId)).toEqual(['a']);
    expect(parseServerFrame({ t: 'sessions.past', re: 'r1', sessions: [], nextCursor: '' })).not.toHaveProperty('nextCursor');
    expect(parseServerFrame({ t: 'session.transcript', re: 'r', sessionId: 's', items: [{ id: 'u', ts: 1, kind: 'user', text: 'hi' }], hasMore: true })).toMatchObject({
      hasMore: true,
      items: [{ id: 'u' }],
    });
    const w = parseServerFrame({ t: 'welcome', host: { name: 'n', hubId: 'h', hubVersion: '1', protocol: 1, features: ['history', 3] }, deviceId: 'd' });
    expect(w && w.t === 'welcome' && w.host.features).toEqual(['history']);
  });
});

describe('applyPage (cursor paging)', () => {
  it('appends pages newest first and keeps the last cursor', () => {
    let h = applyPage(emptyHubHistory, { sessions: [past('a', 50), past('b', 40)], nextCursor: 'c1' }, 'refresh');
    expect(h.order).toEqual(['a', 'b']);
    expect(h.nextCursor).toBe('c1');
    expect(h.support).toBe('history');
    h = applyPage(h, { sessions: [past('c', 30), past('b', 40)] }, 'more');
    expect(h.order).toEqual(['a', 'b', 'c']);
    expect(h.nextCursor).toBeNull();
  });

  it('a refresh replaces the range it covers and keeps the older cached tail with its cursor', () => {
    let h = applyPage(emptyHubHistory, { sessions: [past('a', 50), past('b', 40)], nextCursor: 'c1' }, 'refresh');
    h = applyPage(h, { sessions: [past('c', 30), past('d', 20)], nextCursor: 'c2' }, 'more');
    // 'b' was deleted on the computer; 'n' is new; the first page now ends at 'c'.
    h = applyPage(h, { sessions: [past('n', 60), past('a', 55), past('c', 30)], nextCursor: 'x1' }, 'refresh');
    expect(h.order).toEqual(['n', 'a', 'c', 'd']);
    expect(h.nextCursor).toBe('c2');
    expect(h.byId.a.modifiedAt).toBe(55);
  });

  it('a refresh that fits in one page is the whole list', () => {
    let h = applyPage(emptyHubHistory, { sessions: [past('a', 50), past('b', 40)], nextCursor: 'c1' }, 'refresh');
    h = applyPage(h, { sessions: [past('a', 50)] }, 'refresh');
    expect(h.order).toEqual(['a']);
    expect(h.nextCursor).toBeNull();
  });

  it('remembers indexing', () => {
    expect(applyPage(emptyHubHistory, { sessions: [], indexing: true }, 'refresh').indexing).toBe(true);
  });
});

describe('historyView (merge, live, offline, search)', () => {
  const live = (id: string, extra: Record<string, unknown> = {}) => session({ sessionId: id, lastActivityAt: NOW, ...extra }) as never;

  it('merges computers newest first, folds live sessions in, and stops at the computer that is behind', () => {
    const a: HubHistory = applyPage(emptyHubHistory, { sessions: [past('a1', NOW - 1 * H), past('a2', NOW - 5 * H)], nextCursor: 'more' }, 'refresh');
    const b: HubHistory = applyPage(emptyHubHistory, { sessions: [past('b1', NOW - 2 * H), past('b2', NOW - 3 * D), past('b3', NOW - 9 * D)] }, 'refresh');
    const v = historyView({
      hosts: [
        { hubId: 'A', name: 'laptop', connected: true },
        { hubId: 'B', name: 'devbox', connected: true },
      ],
      history: { A: a, B: b },
      live: { A: { a2: live('a2', { status: 'working' }), x: live('x') }, B: {} },
      hubId: null,
      query: '',
      search: null,
    });
    // A has more (oldest loaded 5 h ago): B's older rows wait for A's next page.
    expect(v.rows.map((r) => r.session.sessionId)).toEqual(['a2', 'x', 'a1', 'b1']);
    expect(v.loadMore).toEqual(['A']);
    const a2 = v.rows[0];
    expect(a2).toMatchObject({ running: true, working: true, hostName: 'laptop', at: NOW });
    expect(v.rows[1]).toMatchObject({ running: true, session: { title: 'Fix the build' } });
  });

  it('an offline computer lists its cached rows, not running, and asks for no pages', () => {
    const a = applyPage(emptyHubHistory, { sessions: [past('a1', NOW - H)], nextCursor: 'more' }, 'refresh');
    const v = historyView({
      hosts: [{ hubId: 'A', name: 'devbox', connected: false }],
      history: { A: a },
      live: { A: { a1: live('a1') } },
      hubId: null,
      query: '',
      search: null,
    });
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0]).toMatchObject({ offline: true, running: false });
    expect(v.loadMore).toEqual([]);
  });

  it('filters by computer', () => {
    const a = applyPage(emptyHubHistory, { sessions: [past('a1', NOW - H)] }, 'refresh');
    const b = applyPage(emptyHubHistory, { sessions: [past('b1', NOW - H)] }, 'refresh');
    const v = historyView({
      hosts: [
        { hubId: 'A', name: 'a', connected: true },
        { hubId: 'B', name: 'b', connected: true },
      ],
      history: { A: a, B: b },
      live: {},
      hubId: 'B',
      query: '',
      search: null,
    });
    expect(v.rows.map((r) => r.session.sessionId)).toEqual(['b1']);
  });

  it('search: instant matches from the phone copy plus each computer’s hits', () => {
    const a = applyPage(emptyHubHistory, { sessions: [past('a1', NOW - H, { title: 'Fix flaky retries' }), past('a2', NOW - 2 * H)] }, 'refresh');
    // a3 is only known from the computer's search (matched in message text).
    const withHit = { ...a, byId: { ...a.byId, a3: past('a3', NOW - 30 * D) } };
    const base = { hosts: [{ hubId: 'A', name: 'laptop', connected: true }], history: { A: withHit }, live: {}, hubId: null };
    expect(historyView({ ...base, query: 'RETRIES', search: null }).rows.map((r) => r.session.sessionId)).toEqual(['a1']);
    const v = historyView({ ...base, query: 'retries', search: { query: 'retries', hubs: { A: { ids: ['a3'], nextCursor: 'n', loading: false, error: null } } } });
    expect(v.rows.map((r) => r.session.sessionId)).toEqual(['a1', 'a3']);
    expect(v.loadMore).toEqual(['A']);
    // Results for a different query are ignored.
    expect(historyView({ ...base, query: 'retries', search: { query: 'other', hubs: { A: { ids: ['a3'], nextCursor: null, loading: false, error: null } } } }).rows).toHaveLength(1);
    expect(matchesQuery(past('z', 1, { cwd: '/srv/devbox/thing' }), 'mini', ['devbox', 'thing'])).toBe(true);
    expect(matchesQuery(past('z', 1), 'devbox', ['devbox'])).toBe(true);
    expect(matchesQuery(past('z', 1), 'mini', ['nope'])).toBe(false);
  });
});

describe('sections', () => {
  it('names date sections', () => {
    expect(sectionTitle(NOW - H, NOW)).toBe('Today');
    expect(sectionTitle(NOW - D, NOW)).toBe('Yesterday');
    expect(sectionTitle(NOW - 4 * D, NOW)).toBe('Previous 7 days');
    expect(sectionTitle(NOW - 20 * D, NOW)).toBe('Previous 30 days');
    expect(sectionTitle(new Date(2026, 5, 2).getTime(), NOW)).toBe('June');
    expect(sectionTitle(new Date(2025, 11, 30).getTime(), NOW)).toBe('December 2025');
  });

  it('puts a header before each section', () => {
    const rows = [NOW - H, NOW - 2 * H, NOW - D, NOW - 40 * D].map((at, i) => ({
      key: `k${i}`,
      hubId: 'A',
      hostName: 'a',
      session: past(`s${i}`, at),
      running: false,
      working: false,
      offline: false,
      at,
    }));
    const out = sectionize(rows, NOW);
    expect(out.map((r) => (r.type === 'section' ? r.title : r.type === 'row' ? `${r.row.session.sessionId}${r.first ? '*' : ''}` : ''))).toEqual([
      'Today',
      's0*',
      's1',
      'Yesterday',
      's2*',
      'September',
      's3*',
    ]);
  });
});

describe('the phone copy (bounded)', () => {
  it('serializes the newest entries per computer and keeps cached-transcript sessions', () => {
    const sessions = Array.from({ length: 12 }, (_, i) => past(`s${i}`, NOW - i * H));
    const h = applyPage(emptyHubHistory, { sessions, nextCursor: 'c' }, 'refresh');
    const extra = { ...h, byId: { ...h.byId, old: past('old', NOW - 90 * D) } };
    const out = serializeIndex({ A: extra }, new Set([transcriptKey('A', 'old')]), NOW, 10);
    expect(out.hubs.A.sessions).toHaveLength(10);
    // Cut: the cursor no longer continues from the last kept entry.
    expect(out.hubs.A.nextCursor).toBeUndefined();
    expect(out.hubs.A.known.map((s) => s.sessionId)).toEqual(['old']);
    const back = parseIndex(JSON.stringify(out));
    expect(back.A.order).toEqual(sessions.slice(0, 10).map((s) => s.sessionId));
    expect(back.A.byId.old).toBeTruthy();
    expect(back.A.support).toBe('history');
    expect(parseIndex('{bad')).toEqual({});
    expect(parseIndex(JSON.stringify({ v: 2, hubs: {} }))).toEqual({});
  });

  it('keeps the newest items of a transcript, without streaming marks', () => {
    const items: TranscriptItem[] = Array.from({ length: 130 }, (_, i) => user(`u${i}`));
    items.push({ id: 'r', ts: 1, kind: 'assistant', text: 'partial', streaming: true });
    const c = cacheableTranscript(items, false);
    expect(c.items).toHaveLength(120);
    expect(c.hasMore).toBe(true);
    expect(c.items[c.items.length - 1]).not.toHaveProperty('streaming');
  });

  it('evicts the least recently opened transcripts past the bound', async () => {
    const files = new MemoryFiles();
    const cache = new HistoryCache(files, { maxTranscripts: 3 });
    await cache.load();
    for (const id of ['a', 'b', 'c', 'd']) await cache.saveTranscript('H', id, [user(`${id}1`)], false, NOW);
    expect([...cache.cachedKeys()].sort()).toEqual(['H\nb', 'H\nc', 'H\nd']);
    expect(files.data.has(transcriptFileName('H\na'))).toBe(false);
    // Re-opening 'b' makes it the newest; 'c' goes next.
    await cache.saveTranscript('H', 'b', [user('b2')], false, NOW);
    await cache.saveTranscript('H', 'e', [user('e1')], false, NOW);
    expect([...cache.cachedKeys()].sort()).toEqual(['H\nb', 'H\nd', 'H\ne']);
    const again = new HistoryCache(files, { maxTranscripts: 3 });
    await again.load();
    expect((await again.loadTranscript('H', 'b'))?.items.map((i) => i.id)).toEqual(['b2']);
    expect(await again.loadTranscript('H', 'c')).toBeNull();
    await again.removeHub('H');
    expect(again.cachedKeys().size).toBe(0);
    expect([...files.data.keys()].filter((k) => k.startsWith('t-'))).toEqual([]);
  });

  it('touchManifest and file names', () => {
    const r = touchManifest(
      [
        { key: 'a', file: 'fa', savedAt: 1 },
        { key: 'b', file: 'fb', savedAt: 1 },
      ],
      { key: 'c', file: 'fc', savedAt: 2 },
      2,
    );
    expect(r.manifest.map((m) => m.key)).toEqual(['c', 'a']);
    expect(r.evicted.map((m) => m.key)).toEqual(['b']);
    expect(transcriptFileName('hub\nsession')).toMatch(/^t-[0-9a-f]{16}\.json$/);
    expect(transcriptFileName('hub\nsession')).toBe(transcriptFileName('hub\nsession'));
    expect(transcriptFileName('hub\nsession')).not.toBe(transcriptFileName('hub\nsession2'));
  });
});

describe('transcript: stored → live swap', () => {
  it('a live snapshot after the stored transcript keeps the older pages and repeats nothing', () => {
    let t = transcriptReducer(emptyTranscript, { type: 'stored', items: [user('u3'), reply('a3'), user('u4'), reply('a4')], hasMore: true });
    t = transcriptReducer(t, { type: 'history', items: [user('u1'), reply('a1'), user('u2'), reply('a2')], hasMore: false });
    expect(t.order).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4']);
    // Resumed: the snapshot's newest page starts inside what is shown, plus the new prompt.
    t = transcriptReducer(t, {
      type: 'snapshot',
      items: [user('u3'), reply('a3'), user('u4'), reply('a4', 'a4 (same)'), user('u5', 'continue')],
      hasMore: true,
      state: { status: 'working' },
    });
    expect(t.order).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5']);
    expect(t.source).toBe('live');
    expect(t.hasMore).toBe(false);
    // A later resubscribe of the live session starts over (live → live).
    t = transcriptReducer(t, { type: 'snapshot', items: [user('u4'), reply('a4'), user('u5')], hasMore: true, state: { status: 'idle' } });
    expect(t.order).toEqual(['u4', 'a4', 'u5']);
  });

  it('a snapshot that does not overlap replaces; the cache only fills an empty transcript', () => {
    let t = transcriptReducer(emptyTranscript, { type: 'cached', items: [user('c1')], hasMore: true });
    expect(t).toMatchObject({ source: 'cache', order: ['c1'], phase: 'ready' });
    t = transcriptReducer(t, { type: 'cached', items: [user('zz')], hasMore: false });
    expect(t.order).toEqual(['c1']);
    t = transcriptReducer(t, { type: 'stored', items: [user('n1'), user('n2')], hasMore: false });
    expect(t.order).toEqual(['n1', 'n2']);
    t = transcriptReducer(t, { type: 'detach' });
    expect(t).toMatchObject({ source: 'stored', live: null, phase: 'ready' });
  });
});

describe('resume error words', () => {
  it('maps hub errors to plain sentences', () => {
    expect(resumeErrorText('bad_request', 'folder no longer exists: /Users/f/old', 'devbox')).toBe('The folder /Users/f/old no longer exists on devbox.');
    expect(resumeErrorText('forbidden', 'x', 'devbox')).toBe('x');
    expect(resumeErrorText('forbidden', '', 'devbox')).toBe('devbox refused to resume this session.');
    expect(resumeErrorText('not_found', 'x', 'devbox')).toBe('devbox no longer has this session.');
    expect(resumeErrorText('bad_request', 'unknown frame type "session.resume"', 'mini')).toBe('Update phi on mini to resume sessions.');
  });
});

// ---------------------------------------------------------------------------
// RemoteClient against a fake hub
// ---------------------------------------------------------------------------

const HUB = 'hub-1';
const host: PairedHost = {
  hubId: HUB,
  name: 'MY-MAC',
  urls: ['http://192.0.2.10:7717'],
  preferredUrl: 'http://192.0.2.10:7717',
  deviceId: 'dev-1',
  token: 'tok',
  pairedAt: 1,
};
const fetchSameHub: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ hubId: HUB, protocol: 1 }) });

async function setup(files = new MemoryFiles()) {
  const storage = new HostStorage(new MemoryKV());
  await storage.save(host);
  const cache = new HistoryCache(files);
  const client = new RemoteClient({
    storage,
    createSocket: FakeSocket.factory,
    fetch: fetchSameHub,
    app: { version: '0.1.0', build: '1' },
    deviceName: 'iPhone',
    random: () => 0.5,
    historyCache: cache,
    now: () => NOW,
  });
  await client.init();
  return { client, files, state: () => client.store.getState() };
}

function welcome(ws: FakeSocket, features: string[] | undefined) {
  ws.open();
  ws.receive({ t: 'welcome', host: { name: 'MY-MAC', hubId: HUB, hubVersion: '1.4.0-exo.7', protocol: 1, ...(features ? { features } : {}) }, deviceId: 'dev-1' });
}

beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.reset();
});
afterEach(() => jest.useRealTimers());

describe('RemoteClient session history', () => {
  it('an old hub (no "history") gets no history requests; resume says to update phi', async () => {
    const { client, state } = await setup();
    const ws = FakeSocket.last();
    welcome(ws, undefined);
    ws.replyTo('sessions.list', { t: 'sessions', sessions: [session()] });
    await jest.advanceTimersByTimeAsync(0);
    expect(ws.framesOf('sessions.past')).toHaveLength(0);
    expect(state().history[HUB].support).toBe('legacy');
    expect(state().hosts[HUB].features).toEqual([]);
    await expect(client.resume(HUB, 'old')).rejects.toMatchObject({ code: 'legacy', message: 'Update phi on MY-MAC to resume sessions.' });
    // Its live threads still open live.
    client.subscribe(HUB, 's1');
    await jest.advanceTimersByTimeAsync(0);
    expect(ws.framesOf('session.subscribe')).toHaveLength(1);
    client.dispose();
  });

  it('loads the index on connect, pages, searches (debounced) and persists the index', async () => {
    const { client, state, files } = await setup();
    const ws = FakeSocket.last();
    welcome(ws, ['history']);
    ws.replyTo('sessions.list', { t: 'sessions', sessions: [session({ sessionId: 'live1', lastActivityAt: NOW })] });
    expect(ws.lastOf('sessions.past')).toMatchObject({ limit: 50 });
    expect(ws.lastOf('sessions.past')).not.toHaveProperty('cursor');
    ws.replyTo('sessions.past', { t: 'sessions.past', sessions: [past('live1', NOW, { live: true }), past('p1', NOW - H)], nextCursor: 'c1' });
    await jest.advanceTimersByTimeAsync(0);
    expect(state().history[HUB].order).toEqual(['live1', 'p1']);

    const more = client.loadMorePast([HUB]);
    await jest.advanceTimersByTimeAsync(0);
    expect(ws.lastOf('sessions.past')).toMatchObject({ cursor: 'c1' });
    ws.replyTo('sessions.past', { t: 'sessions.past', sessions: [past('p2', NOW - 2 * D)] });
    await more;
    expect(state().history[HUB].order).toEqual(['live1', 'p1', 'p2']);
    expect(state().history[HUB].nextCursor).toBeNull();

    client.search('mod');
    client.search('retries');
    expect(state().search).toEqual({ query: 'retries', hubs: {} });
    await jest.advanceTimersByTimeAsync(300);
    const q = ws.framesOf('sessions.past').filter((f) => f.query);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ query: 'retries' });
    ws.replyTo('sessions.past', { t: 'sessions.past', sessions: [past('deep', NOW - 60 * D)] });
    await jest.advanceTimersByTimeAsync(0);
    expect(state().search?.hubs[HUB]).toMatchObject({ ids: ['deep'], nextCursor: null, loading: false });
    // Search hits are known, not part of the browse index.
    expect(state().history[HUB].byId.deep).toBeTruthy();
    expect(state().history[HUB].order).not.toContain('deep');
    client.search('');
    expect(state().search).toBeNull();

    await jest.advanceTimersByTimeAsync(2000);
    const saved = parseIndex(files.data.get('history-index.json') ?? null);
    expect(saved[HUB].order).toEqual(['live1', 'p1', 'p2']);
    client.dispose();
  });

  it('shows the phone copy at launch, then reads the stored transcript and pages it with before', async () => {
    const files = new MemoryFiles();
    const seed = new HistoryCache(files);
    await seed.load();
    await seed.saveIndex({ [HUB]: applyPage(emptyHubHistory, { sessions: [past('p1', NOW - H)] }, 'refresh') }, NOW);
    await seed.saveTranscript(HUB, 'p1', [user('u3'), reply('a3')], true, NOW);

    const { client, state } = await setup(files);
    // Listed before any connection.
    expect(state().history[HUB].order).toEqual(['p1']);
    const ws = FakeSocket.last();
    client.subscribe(HUB, 'p1');
    await jest.advanceTimersByTimeAsync(0);
    expect(selectTranscript(state(), HUB, 'p1')).toMatchObject({ source: 'cache', order: ['u3', 'a3'] });
    // No paging from the cache before the computer answers.
    await client.loadOlder(HUB, 'p1');
    expect(ws.framesOf('session.transcript')).toHaveLength(0);

    welcome(ws, ['history']);
    ws.replyTo('sessions.list', { t: 'sessions', sessions: [] });
    await jest.advanceTimersByTimeAsync(0);
    expect(ws.lastOf('session.transcript')).toMatchObject({ sessionId: 'p1', limit: 120 });
    expect(ws.framesOf('session.subscribe')).toHaveLength(0);
    ws.replyTo('session.transcript', { t: 'session.transcript', sessionId: 'p1', items: [user('u3'), reply('a3'), user('u4'), reply('a4')], hasMore: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(selectTranscript(state(), HUB, 'p1')).toMatchObject({ source: 'stored', order: ['u3', 'a3', 'u4', 'a4'], hasMore: true });

    const older = client.loadOlder(HUB, 'p1');
    expect(ws.lastOf('session.transcript')).toMatchObject({ before: 'u3', limit: 80 });
    ws.replyTo('session.transcript', { t: 'session.transcript', sessionId: 'p1', items: [user('u1'), reply('a1')], hasMore: false });
    await older;
    expect(selectTranscript(state(), HUB, 'p1').order).toEqual(['u1', 'a1', 'u3', 'a3', 'u4', 'a4']);
    client.dispose();
  });

  it('resume with a prompt: sends only what was chosen, then swaps to live in place without dupes', async () => {
    const { client, state } = await setup();
    const ws = FakeSocket.last();
    welcome(ws, ['history']);
    ws.replyTo('sessions.list', { t: 'sessions', sessions: [] });
    ws.replyTo('sessions.past', { t: 'sessions.past', sessions: [past('p1', NOW - H)] });
    await jest.advanceTimersByTimeAsync(0);
    client.subscribe(HUB, 'p1');
    await jest.advanceTimersByTimeAsync(0);
    ws.replyTo('session.transcript', { t: 'session.transcript', sessionId: 'p1', items: [user('u1'), reply('a1'), user('u2'), reply('a2')], hasMore: false });
    await jest.advanceTimersByTimeAsync(0);

    const done = client.resume(HUB, 'p1', { prompt: '  keep going  ' });
    expect(state().resuming[transcriptKey(HUB, 'p1')]).toBeTruthy();
    const req = ws.lastOf('session.resume');
    expect(req).toEqual({ t: 'session.resume', id: req.id, sessionId: 'p1', prompt: 'keep going' });
    // A second resume joins the first (one request).
    const joined = client.resume(HUB, 'p1');
    // The hub registers the child (upsert) and acks.
    ws.receive({ t: 'session.upsert', session: session({ sessionId: 'p1', status: 'working', kind: 'headless', lastActivityAt: NOW }) });
    ws.replyTo('session.resume', { t: 'ack', ok: true, sessionId: 'p1' });
    await expect(done).resolves.toBe('p1');
    await expect(joined).resolves.toBe('p1');
    expect(ws.framesOf('session.resume')).toHaveLength(1);
    expect(state().resuming).toEqual({});
    // Exactly one live subscribe.
    expect(ws.framesOf('session.subscribe')).toHaveLength(1);
    ws.replyTo('session.subscribe', {
      t: 'session.snapshot',
      sessionId: 'p1',
      items: [user('u1'), reply('a1'), user('u2'), reply('a2'), user('u3', 'keep going')],
      hasMore: false,
      state: { status: 'working' },
    });
    await jest.advanceTimersByTimeAsync(0);
    const t = selectTranscript(state(), HUB, 'p1');
    expect(t.source).toBe('live');
    expect(t.order).toEqual(['u1', 'a1', 'u2', 'a2', 'u3']);
    ws.receive({ t: 'session.event', sessionId: 'p1', event: { type: 'item.upsert', item: reply('a3', 'on it') } });
    expect(selectTranscript(state(), HUB, 'p1').order).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
    client.dispose();
  });

  it('resume sends a picked model and effort; errors are worded; ended live threads stay readable', async () => {
    const { client, state } = await setup();
    const ws = FakeSocket.last();
    welcome(ws, ['history']);
    ws.replyTo('sessions.list', { t: 'sessions', sessions: [session({ sessionId: 'l1' })] });
    ws.replyTo('sessions.past', { t: 'sessions.past', sessions: [past('p1', NOW - H)] });
    await jest.advanceTimersByTimeAsync(0);

    const r = client.resume(HUB, 'p1', { model: { provider: 'anthropic', id: 'claude-opus-5-5' }, thinkingLevel: 'high' });
    expect(ws.lastOf('session.resume')).toMatchObject({ provider: 'anthropic', modelId: 'claude-opus-5-5', thinkingLevel: 'high' });
    ws.replyTo('session.resume', { t: 'ack', ok: false, error: { code: 'bad_request', message: 'folder no longer exists: /Users/f/gone' } });
    await expect(r).rejects.toBeInstanceOf(ResumeError);
    await expect(r).rejects.toThrow('The folder /Users/f/gone no longer exists on MY-MAC.');

    // A live thread that ends on a computer with history is kept as a stored session.
    client.subscribe(HUB, 'l1');
    await jest.advanceTimersByTimeAsync(0);
    ws.replyTo('session.subscribe', { t: 'session.snapshot', sessionId: 'l1', items: [user('x1')], hasMore: false, state: { status: 'idle' } });
    await jest.advanceTimersByTimeAsync(0);
    ws.receive({ t: 'session.remove', sessionId: 'l1' });
    expect(selectTranscript(state(), HUB, 'l1')).toMatchObject({ source: 'stored', order: ['x1'], phase: 'ready' });
    expect(state().history[HUB].byId.l1).toMatchObject({ live: false, title: 'Fix the build' });

    // Offline: resume refuses at once.
    ws.fail();
    await expect(client.resume(HUB, 'p1')).rejects.toMatchObject({ code: 'offline' });
    client.dispose();
  });
});

describe('stored sessions are never read only', () => {
  const live = { name: 'MY-MAC', conn: { status: 'live' } } as Pick<HostView, 'name' | 'conn'>;
  const offline = { name: 'devbox', conn: { status: 'offline' } } as Pick<HostView, 'name' | 'conn'>;

  it('the composer only stops for an unpaired computer, never for resumable or offline', () => {
    expect(pastBlockReason(live)).toBeNull();
    expect(pastBlockReason(offline)).toBeNull();
    expect(pastBlockReason({ name: 'mini', conn: { status: 'connecting' } } as Pick<HostView, 'name' | 'conn'>)).toBeNull();
    expect(pastBlockReason(undefined)).toBe('This computer is no longer paired');
    expect(pastComposerNote({ host: live, legacy: false, fromPhoneCopy: false, ago: '2h ago' })).toBe('Not running \u00b7 last active 2h ago. Send a message to resume it.');
    expect(pastComposerNote({ host: offline, legacy: false, fromPhoneCopy: false, ago: '' })).toBe('devbox is offline.');
    expect(pastComposerNote({ host: live, legacy: true, fromPhoneCopy: false, ago: '' })).toBe('Update phi on MY-MAC to resume its sessions.');
  });

  it('a failed send reports false (the composer keeps the draft) and shows the error', async () => {
    const shown: string[] = [];
    const ok = await sendToPast(
      async () => {
        throw new ResumeError('forbidden', 'nope');
      },
      (m) => shown.push(m),
      (e) => (e as Error).message,
    );
    expect(ok).toBe(false);
    expect(shown).toEqual(['nope']);
    await expect(sendToPast(async () => 'p1', (m) => shown.push(m), String)).resolves.toBe(true);
  });

  it('the phone copy drops stale resumable:false flags', () => {
    const raw = JSON.stringify({ v: 1, savedAt: NOW, hubs: { A: { support: 'history', sessions: [{ ...past('x', NOW), resumable: false }], known: [] } } });
    expect(parseIndex(raw).A.byId.x.resumable).toBe(true);
  });

  it('resume of a resumable:false session still asks the hub; a refusal is the hub words; offline keeps it simple', async () => {
    const { client } = await setup();
    const ws = FakeSocket.last();
    welcome(ws, ['history']);
    ws.replyTo('sessions.list', { t: 'sessions', sessions: [] });
    ws.replyTo('sessions.past', { t: 'sessions.past', sessions: [past('p1', NOW - H, { resumable: false })] });
    await jest.advanceTimersByTimeAsync(0);
    const r = client.resume(HUB, 'p1', { prompt: 'go' });
    expect(ws.lastOf('session.resume')).toMatchObject({ sessionId: 'p1', prompt: 'go' });
    ws.replyTo('session.resume', { t: 'ack', ok: false, error: { code: 'forbidden', message: 'session file is unreadable' } });
    await expect(r).rejects.toThrow('session file is unreadable');
    ws.fail();
    await expect(client.resume(HUB, 'p1')).rejects.toThrow('MY-MAC is offline.');
    client.dispose();
  });

  it('a resume whose folder is gone leaves one quiet note', async () => {
    const { client, state } = await setup();
    const ws = FakeSocket.last();
    welcome(ws, ['history']);
    ws.replyTo('sessions.list', { t: 'sessions', sessions: [] });
    ws.replyTo('sessions.past', {
      t: 'sessions.past',
      sessions: [past('p1', NOW - H, { cwd: '/Users/f/scratch/old-spike' }), past('p2', NOW - 2 * H)],
    });
    await jest.advanceTimersByTimeAsync(0);
    const r = client.resume(HUB, 'p1');
    ws.replyTo('session.resume', { t: 'ack', ok: true, sessionId: 'p1', cwd: '/Users/f', cwdFallback: true });
    await expect(r).resolves.toBe('p1');
    expect(state().resumeNotes[transcriptKey(HUB, 'p1')]).toBe('Folder ~/scratch/old-spike is gone; resumed in ~.');
    const r2 = client.resume(HUB, 'p2');
    ws.replyTo('session.resume', { t: 'ack', ok: true, sessionId: 'p2', cwd: '/Users/f/ExampleCo/phi' });
    await expect(r2).resolves.toBe('p2');
    expect(state().resumeNotes[transcriptKey(HUB, 'p2')]).toBeUndefined();
    expect(parseServerFrame({ t: 'ack', re: 'x', ok: true, sessionId: 'p1', cwd: '/a', cwdFallback: true })).toEqual({ t: 'ack', re: 'x', ok: true, sessionId: 'p1', cwd: '/a', cwdFallback: true });
    client.dispose();
  });
});
