import { FakeSocket, session } from '../__fixtures__/fake-socket';
import { RemoteClient, type AppStateLike } from '../client';
import { ConnTrace } from '../conn-trace';
import type { FetchLike, PairedHost } from '../pairing';
import { HostStorage, MemoryKV } from '../storage';
import { commandsDonor, groupByProject, groupSessions, selectCommands, selectTranscript, transcriptKey } from '../store';

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

class FakeAppState implements AppStateLike {
  currentState = 'active';
  private listeners = new Set<(s: string) => void>();
  addEventListener(_type: 'change', listener: (s: string) => void) {
    this.listeners.add(listener);
    return { remove: () => this.listeners.delete(listener) };
  }
  set(state: string) {
    this.currentState = state;
    for (const l of this.listeners) l(state);
  }
}

const fetchSameHub: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ hubId: HUB, protocol: 1 }) });

async function setup(opts: { hosts?: PairedHost[]; appState?: FakeAppState } = {}) {
  const kv = new MemoryKV();
  const storage = new HostStorage(kv);
  for (const h of opts.hosts ?? [host]) await storage.save(h);
  const client = new RemoteClient({
    storage,
    createSocket: FakeSocket.factory,
    fetch: fetchSameHub,
    app: { version: '0.1.0', build: '1' },
    deviceName: 'iPhone',
    appState: opts.appState,
    random: () => 0.5,
  });
  await client.init();
  return { client, kv, storage, state: () => client.store.getState() };
}

/** Accepts the connection and answers sessions.list. */
async function goLive(sessions: Record<string, unknown>[] = [session()]) {
  const ws = FakeSocket.last();
  ws.accept(HUB);
  ws.replyTo('sessions.list', { t: 'sessions', sessions });
  await jest.advanceTimersByTimeAsync(0);
  return ws;
}

beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.reset();
});
afterEach(() => jest.useRealTimers());

describe('RemoteClient', () => {
  it('loads paired hosts, connects, and fills sessions on welcome', async () => {
    const { client, state } = await setup();
    expect(state().ready).toBe(true);
    expect(state().hostOrder).toEqual([HUB]);
    expect(state().hosts[HUB].conn.status).toBe('connecting');
    await goLive([session(), session({ sessionId: 's2', status: 'working', lastActivityAt: 1 })]);
    expect(state().hosts[HUB].conn.status).toBe('live');
    const groups = groupSessions(state());
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(['s2', 's1']);
    client.dispose();
  });

  it('applies session.upsert and session.remove', async () => {
    const { client, state } = await setup();
    const ws = await goLive();
    ws.receive({ t: 'session.upsert', session: session({ sessionId: 's3', name: 'New one' }) });
    expect(state().sessions[HUB].s3.name).toBe('New one');
    ws.receive({ t: 'session.remove', sessionId: 's1' });
    expect(Object.keys(state().sessions[HUB])).toEqual(['s3']);
    client.dispose();
  });

  it('groups threads by project across hosts', async () => {
    const { client, state } = await setup();
    await goLive([
      session({ sessionId: 'a', cwd: '/Users/f/ExampleCo/phi', lastActivityAt: 10 }),
      session({ sessionId: 'b', cwd: '/Users/f/ExampleCo/phi/', lastActivityAt: 30, status: 'working' }),
      session({ sessionId: 'c', cwd: '/Users/f/ExampleCo/site', lastActivityAt: 20 }),
    ]);
    const projects = groupByProject(state());
    expect(projects.map((p) => [p.title, p.path, p.sessions.map((s) => s.sessionId), p.working])).toEqual([
      ['phi', '~/ExampleCo/phi', ['b', 'a'], 1],
      ['site', '~/ExampleCo/site', ['c'], 0],
    ]);
    client.dispose();
  });

  it('subscribes once per session, streams events, and resubscribes on reset', async () => {
    const { client, state } = await setup();
    const ws = await goLive();
    const release1 = client.subscribe(HUB, 's1');
    const release2 = client.subscribe(HUB, 's1');
    expect(ws.framesOf('session.subscribe')).toEqual([expect.objectContaining({ sessionId: 's1', limit: 120 })]);
    ws.replyTo('session.subscribe', {
      t: 'session.snapshot',
      sessionId: 's1',
      items: [{ id: 'u1', ts: 1, kind: 'user', text: 'hi' }],
      hasMore: false,
      state: { status: 'working' },
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(selectTranscript(state(), HUB, 's1').order).toEqual(['u1']);

    ws.receive({
      t: 'session.event',
      sessionId: 's1',
      event: { type: 'item.upsert', item: { id: 'a1', ts: 2, kind: 'assistant', text: 'Hel', streaming: true } },
    });
    ws.receive({
      t: 'session.event',
      sessionId: 's1',
      event: { type: 'item.upsert', item: { id: 'a1', ts: 2, kind: 'assistant', text: 'Hello' } },
    });
    ws.receive({ t: 'session.event', sessionId: 's1', event: { type: 'state', state: { status: 'idle' } } });
    let t = selectTranscript(state(), HUB, 's1');
    expect(t.order).toEqual(['u1', 'a1']);
    expect(t.byId.a1).toEqual({ id: 'a1', ts: 2, kind: 'assistant', text: 'Hello' });
    expect(t.live).toEqual({ status: 'idle' });

    ws.receive({ t: 'session.event', sessionId: 's1', event: { type: 'reset' } });
    expect(ws.framesOf('session.subscribe')).toHaveLength(2);
    ws.replyTo('session.subscribe', {
      t: 'session.snapshot',
      sessionId: 's1',
      items: [{ id: 'n1', ts: 5, kind: 'note', text: 'compacted' }],
      hasMore: true,
      state: { status: 'idle' },
    });
    await jest.advanceTimersByTimeAsync(0);
    t = selectTranscript(state(), HUB, 's1');
    expect(t.order).toEqual(['n1']);
    expect(t.phase).toBe('ready');

    release1();
    expect(ws.framesOf('session.unsubscribe')).toHaveLength(0);
    release2();
    release2();
    expect(ws.framesOf('session.unsubscribe')).toEqual([{ t: 'session.unsubscribe', sessionId: 's1' }]);
    client.dispose();
  });

  it('loads older history before the oldest item', async () => {
    const { client, state } = await setup();
    const ws = await goLive();
    client.subscribe(HUB, 's1');
    ws.replyTo('session.subscribe', {
      t: 'session.snapshot',
      sessionId: 's1',
      items: [{ id: 'm5', ts: 5, kind: 'user', text: 'x' }],
      hasMore: true,
      state: { status: 'idle' },
    });
    await jest.advanceTimersByTimeAsync(0);
    const p = client.loadOlder(HUB, 's1');
    expect(ws.lastOf('session.history')).toEqual(expect.objectContaining({ sessionId: 's1', before: 'm5' }));
    expect(selectTranscript(state(), HUB, 's1').loadingOlder).toBe(true);
    ws.replyTo('session.history', {
      t: 'session.history',
      sessionId: 's1',
      items: [{ id: 'm4', ts: 4, kind: 'user', text: 'w' }],
      hasMore: false,
    });
    await p;
    const t = selectTranscript(state(), HUB, 's1');
    expect(t.order).toEqual(['m4', 'm5']);
    expect(t.hasMore).toBe(false);
    client.dispose();
  });

  it('resubscribes and reloads sessions after a reconnect', async () => {
    const { client, state } = await setup();
    const ws = await goLive();
    client.subscribe(HUB, 's1');
    ws.replyTo('session.subscribe', { t: 'session.snapshot', sessionId: 's1', items: [], hasMore: false, state: { status: 'idle' } });
    await jest.advanceTimersByTimeAsync(0);
    ws.serverClose(1006);
    expect(state().hosts[HUB].conn.status).toBe('connecting');
    await jest.advanceTimersByTimeAsync(500);
    const ws2 = FakeSocket.last();
    expect(ws2).not.toBe(ws);
    ws2.accept(HUB);
    expect(ws2.framesOf('sessions.list')).toHaveLength(1);
    expect(ws2.framesOf('session.subscribe')).toEqual([expect.objectContaining({ sessionId: 's1' })]);
    client.dispose();
  });

  it('marks a session that no longer exists', async () => {
    const { client, state } = await setup();
    const ws = await goLive();
    client.subscribe(HUB, 'gone');
    ws.replyTo('session.subscribe', { t: 'error', code: 'not_found', message: 'no such session' });
    await jest.advanceTimersByTimeAsync(0);
    const t = selectTranscript(state(), HUB, 'gone');
    expect(t.phase).toBe('error');
    expect(t.error).toBe('That session is no longer running.');
    client.dispose();
  });

  it('sends prompt, abort, setModel, setThinking, spawn and surfaces hub errors', async () => {
    const { client } = await setup();
    const ws = await goLive();
    const p = client.prompt(HUB, 's1', 'go', [{ mimeType: 'image/jpeg', data: 'AAAA' }], 'steer');
    expect(ws.lastOf('session.prompt')).toEqual(
      expect.objectContaining({ sessionId: 's1', text: 'go', mode: 'steer', images: [{ mimeType: 'image/jpeg', data: 'AAAA' }] }),
    );
    ws.replyTo('session.prompt', { t: 'ack', ok: true });
    await expect(p).resolves.toBeUndefined();

    const a = client.abort(HUB, 's1');
    ws.replyTo('session.abort', { t: 'ack', ok: false, error: { code: 'session_offline', message: 'x' } });
    await expect(a).rejects.toMatchObject({ code: 'session_offline' });

    const m = client.setModel(HUB, 's1', { provider: 'anthropic', id: 'opus' });
    expect(ws.lastOf('session.setModel')).toEqual(expect.objectContaining({ provider: 'anthropic', modelId: 'opus' }));
    ws.replyTo('session.setModel', { t: 'ack', ok: true });
    await m;

    const th = client.setThinking(HUB, 's1', 'high');
    ws.replyTo('session.setThinking', { t: 'ack', ok: true });
    await th;

    const sp = client.spawn(HUB, { cwd: '/Users/f/x', prompt: 'hello', provider: 'anthropic', modelId: 'opus' });
    expect(ws.lastOf('session.spawn')).toEqual(
      expect.objectContaining({ cwd: '/Users/f/x', prompt: 'hello', provider: 'anthropic', modelId: 'opus' }),
    );
    ws.replyTo('session.spawn', { t: 'ack', ok: true, sessionId: 'new-1' });
    await expect(sp).resolves.toBe('new-1');

    const c = client.recentCwds(HUB);
    ws.replyTo('cwds.recent', { t: 'cwds', cwds: ['/a'] });
    await expect(c).resolves.toEqual(['/a']);

    const ml = client.listModels(HUB, 's1');
    ws.replyTo('models.list', { t: 'models', models: [], thinkingLevels: ['off'] });
    await expect(ml).resolves.toEqual({ models: [], thinkingLevels: ['off'] });
    client.dispose();
  });

  it('spawn sends thinkingLevel only when given', async () => {
    const { client } = await setup();
    const ws = await goLive();
    const plain = client.spawn(HUB, { cwd: '/Users/f/x' });
    expect(ws.lastOf('session.spawn')).toEqual({ t: 'session.spawn', id: expect.any(String), cwd: '/Users/f/x' });
    ws.replyTo('session.spawn', { t: 'ack', ok: true, sessionId: 'n1' });
    await expect(plain).resolves.toBe('n1');

    const full = client.spawn(HUB, { cwd: '/Users/f/x', prompt: 'go', provider: 'anthropic', modelId: 'claude-opus-5-5', thinkingLevel: 'high' });
    expect(ws.lastOf('session.spawn')).toEqual({
      t: 'session.spawn',
      id: expect.any(String),
      cwd: '/Users/f/x',
      prompt: 'go',
      provider: 'anthropic',
      modelId: 'claude-opus-5-5',
      thinkingLevel: 'high',
    });
    ws.receive({ t: 'session.upsert', session: session({ sessionId: 'n2', kind: 'headless', thinkingLevel: 'high' }) });
    ws.replyTo('session.spawn', { t: 'ack', ok: true, sessionId: 'n2' });
    await expect(full).resolves.toBe('n2');
    await jest.advanceTimersByTimeAsync(10_000);
    // the hub honoured it: no follow-up
    expect(ws.framesOf('session.setThinking')).toHaveLength(0);
    client.dispose();
  });

  it('spawn sets the level once when an older hub ignored thinkingLevel (summary before the ack)', async () => {
    const { client } = await setup();
    const ws = await goLive();
    const sp = client.spawn(HUB, { cwd: '/Users/f/x', thinkingLevel: 'xhigh' });
    ws.receive({ t: 'session.upsert', session: session({ sessionId: 'n3', kind: 'headless', thinkingLevel: 'medium' }) });
    ws.replyTo('session.spawn', { t: 'ack', ok: true, sessionId: 'n3' });
    await expect(sp).resolves.toBe('n3');
    await jest.advanceTimersByTimeAsync(0);
    expect(ws.framesOf('session.setThinking')).toEqual([{ t: 'session.setThinking', id: expect.any(String), sessionId: 'n3', level: 'xhigh' }]);
    ws.replyTo('session.setThinking', { t: 'ack', ok: true });
    // a later upsert still reporting the old level does not trigger another one
    ws.receive({ t: 'session.upsert', session: session({ sessionId: 'n3', kind: 'headless', thinkingLevel: 'medium' }) });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(ws.framesOf('session.setThinking')).toHaveLength(1);
    client.dispose();
  });

  it('spawn waits for a summary that arrives after the ack, and gives up quietly', async () => {
    const { client } = await setup();
    const ws = await goLive();
    const sp = client.spawn(HUB, { cwd: '/Users/f/x', thinkingLevel: 'low' });
    ws.replyTo('session.spawn', { t: 'ack', ok: true, sessionId: 'n4' });
    await expect(sp).resolves.toBe('n4');
    await jest.advanceTimersByTimeAsync(300);
    expect(ws.framesOf('session.setThinking')).toHaveLength(0);
    ws.receive({ t: 'session.upsert', session: session({ sessionId: 'n4', kind: 'headless', thinkingLevel: 'medium' }) });
    await jest.advanceTimersByTimeAsync(0);
    expect(ws.lastOf('session.setThinking')).toEqual(expect.objectContaining({ sessionId: 'n4', level: 'low' }));
    // A failed follow-up is logged, never thrown at the caller (the thread already started).
    ws.replyTo('session.setThinking', { t: 'ack', ok: false, error: { code: 'bad_request', message: 'nope' } });
    await jest.advanceTimersByTimeAsync(0);

    // No summary at all within the wait: nothing is sent.
    const quiet = client.spawn(HUB, { cwd: '/Users/f/x', thinkingLevel: 'low' });
    ws.replyTo('session.spawn', { t: 'ack', ok: true, sessionId: 'n5' });
    await expect(quiet).resolves.toBe('n5');
    await jest.advanceTimersByTimeAsync(6_000);
    ws.receive({ t: 'session.upsert', session: session({ sessionId: 'n5', kind: 'headless', thinkingLevel: 'medium' }) });
    await jest.advanceTimersByTimeAsync(0);
    expect(ws.framesOf('session.setThinking')).toHaveLength(1);
    client.dispose();
  });

  it('persists the new-thread default with the other prefs', async () => {
    const { client, storage, state } = await setup();
    await client.updatePrefs({ newThread: { model: { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoning: true }, thinkingLevel: 'high' } });
    await client.updatePrefs({ speechRate: 1.3 });
    expect(state().prefs.newThread?.thinkingLevel).toBe('high');
    expect(await storage.loadPrefs()).toEqual({
      speechRate: 1.3,
      newThread: { model: { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoning: true }, thinkingLevel: 'high' },
    });
    client.dispose();

    // Relaunch: a fresh client over the same storage starts with it.
    const again = new RemoteClient({
      storage,
      createSocket: FakeSocket.factory,
      fetch: fetchSameHub,
      app: { version: '0.1.0', build: '1' },
      deviceName: 'iPhone',
    });
    await again.init();
    expect(again.store.getState().prefs.newThread).toEqual({
      model: { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoning: true },
      thinkingLevel: 'high',
    });
    await again.updatePrefs({ newThread: undefined });
    expect(await storage.loadPrefs()).toEqual({ speechRate: 1.3 });
    again.dispose();
  });

  it('sends focus while foregrounded and clears it in the background', async () => {
    const appState = new FakeAppState();
    const { client } = await setup({ appState });
    const ws = await goLive();
    client.setFocus({ hubId: HUB, sessionId: 's1' });
    client.setFocus({ hubId: HUB, sessionId: 's1' });
    expect(ws.framesOf('focus')).toEqual([{ t: 'focus', sessionId: 's1' }]);
    appState.set('background');
    expect(ws.framesOf('focus')).toEqual([
      { t: 'focus', sessionId: 's1' },
      { t: 'focus', sessionId: null },
    ]);
    // after the grace period sockets close
    await jest.advanceTimersByTimeAsync(30_000);
    expect(ws.closedBy).not.toBeNull();
    appState.set('active');
    const ws2 = FakeSocket.last();
    expect(ws2).not.toBe(ws);
    ws2.accept(HUB);
    expect(ws2.framesOf('focus')).toEqual([{ t: 'focus', sessionId: 's1' }]);
    client.dispose();
  });

  it('reconnects on foreground after a long suspension even if the timer never fired', async () => {
    const appState = new FakeAppState();
    let now = 1_000_000;
    const kv = new MemoryKV();
    const storage = new HostStorage(kv);
    await storage.save(host);
    const client = new RemoteClient({
      storage,
      createSocket: FakeSocket.factory,
      fetch: fetchSameHub,
      app: { version: '0', build: '0' },
      deviceName: 'p',
      appState,
      now: () => now,
      random: () => 0.5,
    });
    await client.init();
    const ws = await goLive();
    appState.set('background');
    now += 120_000; // suspended: no timers ran
    appState.set('active');
    expect(ws.closedBy).not.toBeNull();
    expect(FakeSocket.last()).not.toBe(ws);
    client.dispose();
  });

  it('marks the host unauthorized on 4401', async () => {
    const { client, state } = await setup();
    const ws = FakeSocket.last();
    ws.open();
    ws.serverClose(4401);
    await jest.advanceTimersByTimeAsync(0);
    expect(state().hosts[HUB].conn.status).toBe('unauthorized');
    client.dispose();
  });

  it('registers and unregisters push on live hosts and persists the choice', async () => {
    const { client, storage, state } = await setup();
    const ws = await goLive();
    const reg = { apnsToken: 'abc', env: 'production' as const, bundleId: 'com.example.phiremote' };
    const on = client.setPush(reg);
    await jest.advanceTimersByTimeAsync(0);
    expect(ws.lastOf('push.register')).toEqual(expect.objectContaining(reg));
    ws.replyTo('push.register', { t: 'ack', ok: true });
    await expect(on).resolves.toEqual({ ok: 1, failed: 0 });
    expect(state().prefs.notifications).toBe('on');
    expect(await storage.loadPrefs()).toEqual({ notifications: 'on' });

    const off = client.setPush(null);
    await jest.advanceTimersByTimeAsync(0);
    ws.replyTo('push.unregister', { t: 'ack', ok: true });
    await off;
    expect(await storage.loadPrefs()).toEqual({ notifications: 'off' });
    client.dispose();
  });

  it('adds and removes hosts, persisting tokens only in storage', async () => {
    const { client, storage, state } = await setup({ hosts: [] });
    expect(state().hostOrder).toEqual([]);
    await client.addHost(host);
    expect(state().hostOrder).toEqual([HUB]);
    expect(JSON.stringify(state())).not.toContain('"token"');
    expect((await storage.loadAll())[0].token).toBe('tok');
    const ws = await goLive();
    client.subscribe(HUB, 's1');
    const removing = client.removeHost(HUB);
    await jest.advanceTimersByTimeAsync(0);
    ws.replyTo('push.unregister', { t: 'ack', ok: true });
    await removing;
    expect(state().hostOrder).toEqual([]);
    expect(state().sessions[HUB]).toBeUndefined();
    expect(state().transcripts[transcriptKey(HUB, 's1')]).toBeUndefined();
    expect(await storage.loadAll()).toEqual([]);
    client.dispose();
  });

  it('remembers the url that worked and the hub name', async () => {
    const { client, storage, state } = await setup({
      hosts: [{ ...host, urls: ['http://a:7717', 'http://b:7717'], preferredUrl: 'http://a:7717' }],
    });
    FakeSocket.last().fail();
    await jest.advanceTimersByTimeAsync(0);
    const ws = FakeSocket.last();
    expect(ws.url).toBe('ws://b:7717/v1/ws');
    ws.open();
    ws.receive({ t: 'welcome', host: { name: 'renamed', hubId: HUB, hubVersion: '1', protocol: 1 }, deviceId: 'd' });
    await jest.advanceTimersByTimeAsync(0);
    expect(state().hosts[HUB].name).toBe('renamed');
    expect((await storage.loadAll())[0]).toEqual(expect.objectContaining({ preferredUrl: 'http://b:7717', name: 'renamed' }));
    client.dispose();
  });
});

describe('slash commands', () => {
  const LIST = [
    { name: 'new', source: 'builtin', description: 'Start a new session' },
    { name: 'skill:use-subs', source: 'skill', description: 'Mixed subagent swarm' },
  ];
  const listsSent = (ws: FakeSocket) => ws.framesOf('commands.list');

  it('fetches once per session, caches, and refetches when commandsVersion changes', async () => {
    const { client, state } = await setup();
    const ws = await goLive([session({ commandsVersion: 'v1' })]);
    expect(selectCommands(state(), HUB, 's1')).toEqual([]);
    client.ensureCommands(HUB, 's1');
    client.ensureCommands(HUB, 's1'); // in flight: no second request
    expect(listsSent(ws)).toEqual([expect.objectContaining({ t: 'commands.list', sessionId: 's1' })]);
    expect(state().commands[transcriptKey(HUB, 's1')].status).toBe('loading');
    ws.replyTo('commands.list', { t: 'commands', sessionId: 's1', commands: LIST });
    await jest.advanceTimersByTimeAsync(0);
    expect(selectCommands(state(), HUB, 's1').map((c) => c.name)).toEqual(['new', 'skill:use-subs']);
    client.ensureCommands(HUB, 's1'); // cached
    expect(listsSent(ws)).toHaveLength(1);

    // same version: nothing; new version: refetch right away, old list stays visible meanwhile
    ws.receive({ t: 'session.upsert', session: session({ commandsVersion: 'v1', status: 'working' }) });
    expect(listsSent(ws)).toHaveLength(1);
    ws.receive({ t: 'session.upsert', session: session({ commandsVersion: 'v2' }) });
    expect(listsSent(ws)).toHaveLength(2);
    expect(state().commands[transcriptKey(HUB, 's1')]).toEqual({ status: 'ready', commands: expect.any(Array) });
    ws.replyTo('commands.list', { t: 'commands', sessionId: 's1', commands: [LIST[0]] });
    await jest.advanceTimersByTimeAsync(0);
    expect(selectCommands(state(), HUB, 's1').map((c) => c.name)).toEqual(['new']);
    client.ensureCommands(HUB, 's1');
    expect(listsSent(ws)).toHaveLength(2);
    client.dispose();
  });

  it('refetches after a reset and drops the list when the session goes away', async () => {
    const { client, state } = await setup();
    const ws = await goLive();
    client.subscribe(HUB, 's1');
    client.ensureCommands(HUB, 's1');
    ws.replyTo('commands.list', { t: 'commands', sessionId: 's1', commands: LIST });
    await jest.advanceTimersByTimeAsync(0);
    ws.receive({ t: 'session.event', sessionId: 's1', event: { type: 'reset' } });
    expect(listsSent(ws)).toHaveLength(2);
    ws.replyTo('commands.list', { t: 'commands', sessionId: 's1', commands: LIST });
    await jest.advanceTimersByTimeAsync(0);
    ws.receive({ t: 'session.remove', sessionId: 's1' });
    expect(state().commands[transcriptKey(HUB, 's1')]).toBeUndefined();
    client.dispose();
  });

  it('treats an older hub (bad_request) as no commands and stops asking until it reconnects', async () => {
    const { client, state } = await setup();
    const ws = await goLive();
    client.ensureCommands(HUB, 's1');
    ws.replyTo('commands.list', { t: 'error', code: 'bad_request', message: 'unknown frame type "commands.list"' });
    await jest.advanceTimersByTimeAsync(0);
    expect(state().commands[transcriptKey(HUB, 's1')]).toEqual({ status: 'unavailable', commands: [] });
    await jest.advanceTimersByTimeAsync(60_000);
    client.ensureCommands(HUB, 's1');
    expect(listsSent(ws)).toHaveLength(1);
    // the hub restarted (maybe upgraded): ask again
    ws.serverClose(1006);
    await jest.advanceTimersByTimeAsync(500);
    const ws2 = FakeSocket.last();
    ws2.accept(HUB);
    ws2.replyTo('sessions.list', { t: 'sessions', sessions: [session()] });
    await jest.advanceTimersByTimeAsync(0);
    client.ensureCommands(HUB, 's1');
    expect(listsSent(ws2)).toHaveLength(1);
    client.dispose();
  });

  it('retries a transient failure only after a pause', async () => {
    const { client, state } = await setup();
    const ws = await goLive();
    client.ensureCommands(HUB, 's1');
    await jest.advanceTimersByTimeAsync(10_000); // request timeout
    expect(state().commands[transcriptKey(HUB, 's1')].status).toBe('unavailable');
    client.ensureCommands(HUB, 's1');
    expect(listsSent(ws)).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(15_000);
    client.ensureCommands(HUB, 's1');
    expect(listsSent(ws)).toHaveLength(2);
    client.dispose();
  });

  it('does nothing while the host is not connected', async () => {
    const { client } = await setup();
    client.ensureCommands(HUB, 's1');
    const ws = await goLive();
    expect(listsSent(ws)).toHaveLength(0);
    client.ensureCommands(HUB, 's1');
    expect(listsSent(ws)).toHaveLength(1);
    client.dispose();
  });

  it('borrows the most recent session on the computer for the new-thread composer', async () => {
    const { client, state } = await setup();
    await goLive([session({ sessionId: 'old', lastActivityAt: 5 }), session({ sessionId: 'recent', lastActivityAt: 9 })]);
    expect(commandsDonor(state(), HUB)).toBe('recent');
    expect(commandsDonor(state(), 'nope')).toBeNull();
    expect(commandsDonor(state(), null)).toBeNull();
    client.dispose();
  });
});

describe('session replacement (/new, /resume, /fork)', () => {
  it('follows reset { replacedBy } and session.remove { replacedBy } without ending the thread', async () => {
    const { client, state } = await setup();
    const ws = await goLive([session({ commandsVersion: 'v1' })]);
    client.subscribe(HUB, 's1');
    ws.replyTo('session.subscribe', {
      t: 'session.snapshot',
      sessionId: 's1',
      items: [{ id: 'u1', ts: 1, kind: 'user', text: 'hi' }],
      hasMore: false,
      state: { status: 'idle' },
    });
    client.ensureCommands(HUB, 's1');
    ws.replyTo('commands.list', { t: 'commands', sessionId: 's1', commands: [{ name: 'new', source: 'builtin' }] });
    await jest.advanceTimersByTimeAsync(0);

    ws.receive({ t: 'session.event', sessionId: 's1', event: { type: 'reset', replacedBy: 's2' } });
    ws.receive({ t: 'session.remove', sessionId: 's1', replacedBy: 's2' });
    ws.receive({ t: 'session.upsert', session: session({ sessionId: 's2', commandsVersion: 'v1' }) });

    expect(state().replacements[transcriptKey(HUB, 's1')]).toBe('s2');
    expect(Object.keys(state().sessions[HUB])).toEqual(['s2']);
    // the old transcript stays readable (no "thread has ended"), no resubscribe to the old id
    expect(selectTranscript(state(), HUB, 's1').phase).toBe('ready');
    expect(ws.framesOf('session.subscribe')).toHaveLength(1);
    expect(ws.lastOf('session.unsubscribe')).toEqual({ t: 'session.unsubscribe', sessionId: 's1' });
    // the command list carries over to the new id (same machine) and refreshes on the next '/'
    expect(selectCommands(state(), HUB, 's2').map((c) => c.name)).toEqual(['new']);
    expect(state().commands[transcriptKey(HUB, 's1')]).toBeUndefined();
    client.ensureCommands(HUB, 's2');
    expect(ws.lastOf('commands.list')).toEqual(expect.objectContaining({ sessionId: 's2' }));
    client.dispose();
  });

  it('a removal with replacedBy alone (not subscribed) only swaps the home list', async () => {
    const { client, state } = await setup();
    const ws = await goLive([session(), session({ sessionId: 'other' })]);
    ws.receive({ t: 'session.remove', sessionId: 's1', replacedBy: 's9' });
    ws.receive({ t: 'session.upsert', session: session({ sessionId: 's9' }) });
    expect(Object.keys(state().sessions[HUB]).sort()).toEqual(['other', 's9']);
    expect(state().replacements[transcriptKey(HUB, 's1')]).toBe('s9');
    expect(ws.framesOf('session.unsubscribe')).toHaveLength(0);
    client.dispose();
  });

  it('a plain reset still resubscribes the same id', async () => {
    const { client, state } = await setup();
    const ws = await goLive();
    client.subscribe(HUB, 's1');
    ws.receive({ t: 'session.event', sessionId: 's1', event: { type: 'reset' } });
    expect(ws.framesOf('session.subscribe')).toHaveLength(2);
    expect(state().replacements).toEqual({});
    client.dispose();
  });
});

describe('subagents (v1 addition)', () => {
  const child = (id: string, over: Record<string, unknown> = {}) =>
    session({
      sessionId: `s1~sa~${id}`,
      name: id,
      kind: 'subagent',
      status: 'working',
      parentSessionId: 's1',
      subagent: { runId: id, toolCallId: 'call-1', index: 0, name: id, task: 'Map the registry', status: 'running', startedAt: 1_500 },
      ...over,
    });

  it('keeps subagent sessions out of the thread list, counts and command donor', async () => {
    const { client, state } = await setup();
    const ws = await goLive([session({ subagents: { running: 1, total: 1 }, tmux: { session: 'phi', window: '2' } }), child('ws-a', { lastActivityAt: 99_999 })]);
    expect(Object.keys(state().sessions[HUB]).sort()).toEqual(['s1', 's1~sa~ws-a']);
    expect(groupByProject(state()).flatMap((p) => p.sessions.map((s) => s.sessionId))).toEqual(['s1']);
    expect(groupSessions(state())[0].sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(commandsDonor(state(), HUB)).toBe('s1');
    expect(state().sessions[HUB].s1.subagents).toEqual({ running: 1, total: 1 });
    expect(state().sessions[HUB].s1.tmux).toEqual({ session: 'phi', window: '2' });
    ws.receive({ t: 'session.upsert', session: child('ws-a', { status: 'idle', subagent: { runId: 'ws-a', task: 't', status: 'done', startedAt: 1_500, endedAt: 9_000, toolCalls: 4 } }) });
    expect(state().sessions[HUB]['s1~sa~ws-a'].subagent).toEqual({ runId: 'ws-a', task: 't', status: 'done', startedAt: 1_500, endedAt: 9_000, toolCalls: 4 });
    client.dispose();
  });

  it('drops a subagent summary without a parent or run', async () => {
    const { client, state } = await setup();
    await goLive([session(), child('a', { parentSessionId: undefined }), child('b', { subagent: undefined }), child('c')]);
    expect(Object.keys(state().sessions[HUB]).sort()).toEqual(['s1', 's1~sa~c']);
    client.dispose();
  });

  it('removes a subagent on session.remove and ends its open thread', async () => {
    const { client, state } = await setup();
    const ws = await goLive([session(), child('ws-a')]);
    client.subscribe(HUB, 's1~sa~ws-a');
    ws.replyTo('session.subscribe', { t: 'session.snapshot', sessionId: 's1~sa~ws-a', items: [], hasMore: false, state: { status: 'working' } });
    await jest.advanceTimersByTimeAsync(0);
    ws.receive({ t: 'session.remove', sessionId: 's1~sa~ws-a' });
    expect(state().sessions[HUB]['s1~sa~ws-a']).toBeUndefined();
    expect(state().sessions[HUB].s1).toBeDefined();
    expect(selectTranscript(state(), HUB, 's1~sa~ws-a').phase).toBe('error');
    client.dispose();
  });

  it('a parent that ends or is replaced takes its subagents along', async () => {
    const { client, state } = await setup();
    const ws = await goLive([session(), child('a'), child('b'), session({ sessionId: 's2' }), child('c', { sessionId: 's2~sa~c', parentSessionId: 's2' })]);
    client.subscribe(HUB, 's1~sa~a');
    ws.receive({ t: 'session.remove', sessionId: 's1' });
    expect(Object.keys(state().sessions[HUB]).sort()).toEqual(['s2', 's2~sa~c']);
    expect(selectTranscript(state(), HUB, 's1~sa~a').phase).toBe('error');
    ws.receive({ t: 'session.remove', sessionId: 's2', replacedBy: 's3' });
    expect(Object.keys(state().sessions[HUB])).toEqual([]);
    client.dispose();
  });
});

describe('reconnect triggers and the connection log', () => {
  const HUB_B = 'hub-2';
  const HUB_C = 'hub-3';
  const hostB: PairedHost = { ...host, hubId: HUB_B, name: 'laptop-test', urls: ['http://192.0.2.11:7717'], preferredUrl: 'http://192.0.2.11:7717' };
  const hostC: PairedHost = { ...host, hubId: HUB_C, name: 'mac-mini', urls: ['http://192.0.2.12:7717'], preferredUrl: 'http://192.0.2.12:7717' };
  const socketsFor = (ip: string) => FakeSocket.all.filter((s) => s.url.includes(ip));
  const lastFor = (ip: string) => socketsFor(ip)[socketsFor(ip).length - 1];

  async function three(opts: { appState?: FakeAppState; trace?: ConnTrace } = {}) {
    const storage = new HostStorage(new MemoryKV());
    for (const h of [host, hostB, hostC]) await storage.save(h);
    const client = new RemoteClient({
      storage,
      createSocket: FakeSocket.factory,
      fetch: async (url) => ({ ok: true, status: 200, json: async () => ({ hubId: url.includes('100.2') ? HUB_B : url.includes('100.3') ? HUB_C : HUB, protocol: 1 }) }),
      app: { version: '0.1.0', build: '42' },
      deviceName: 'iPhone',
      appState: opts.appState,
      random: () => 0.5,
      trace: opts.trace,
    });
    await client.init();
    return { client, state: () => client.store.getState() };
  }

  /** Every open attempt fails at once (the network is down). */
  function failAll() {
    for (const ws of FakeSocket.all) if (!ws.closedBy && !(ws as unknown as { failed?: boolean }).failed) {
      (ws as unknown as { failed?: boolean }).failed = true;
      ws.fail();
    }
  }

  it('a network change retries every computer that is not live at once, backoff reset', async () => {
    const { client, state } = await three();
    // 20 s of failures: every computer waits between rounds.
    for (let t = 0; t < 20_000; t += 100) {
      failAll();
      jest.advanceTimersByTime(100);
    }
    failAll();
    expect(state().hosts[HUB].conn.status).toBe('offline');
    const before = FakeSocket.all.length;
    client.networkChanged({ type: 'CELLULAR', connected: true });
    expect(FakeSocket.all.length).toBe(before + 3);
    expect(state().hosts[HUB].conn.status).toBe('connecting');
    for (const ip of ['192.0.2.10', '192.0.2.11', '192.0.2.12']) lastFor(ip).accept(ip === '192.0.2.10' ? HUB : ip === '192.0.2.11' ? HUB_B : HUB_C);
    expect(Object.values(state().hosts).map((h) => h.conn.status)).toEqual(['live', 'live', 'live']);
    client.dispose();
  });

  it('the path at launch and a lost connection only get logged', async () => {
    const trace = new ConnTrace();
    const { client } = await three({ trace });
    const before = FakeSocket.all.length;
    client.networkChanged({ type: 'WIFI', connected: true }, true);
    client.networkChanged({ type: 'NONE', connected: false });
    expect(FakeSocket.all.length).toBe(before);
    expect(trace.events(HUB).filter((e) => e.kind === 'network').map((e) => e.text)).toEqual(['wifi · at launch', 'none · no connection']);
    client.dispose();
  });

  it('a network change checks live connections with a ping', async () => {
    const { client } = await three();
    const ws = FakeSocket.all[0];
    ws.accept(HUB);
    client.networkChanged({ type: 'WIFI', connected: true });
    expect(ws.framesOf('ping')).toHaveLength(1);
    client.dispose();
  });

  it('one computer reconnecting makes the others retry now instead of waiting out their backoff', async () => {
    const { client, state } = await three();
    for (let t = 0; t < 20_000; t += 100) {
      failAll();
      jest.advanceTimersByTime(100);
    }
    failAll();
    // The network is back. MY-MAC's next round comes first; devbox's and mac-mini's attempts
    // of this round were still lost, so they are waiting out their backoff.
    let guard = 0;
    const open = (ip: string) => socketsFor(ip).some((s) => !s.closedBy && !(s as unknown as { failed?: boolean }).failed);
    while (!open('192.0.2.10') && guard++ < 100) jest.advanceTimersByTime(50);
    for (const ip of ['192.0.2.11', '192.0.2.12']) {
      const ws = lastFor(ip);
      if (!ws.closedBy && !(ws as unknown as { failed?: boolean }).failed) ws.fail();
    }
    expect(open('192.0.2.11') || open('192.0.2.12')).toBe(false);
    const waitingB = socketsFor('192.0.2.11').length;
    const waitingC = socketsFor('192.0.2.12').length;
    lastFor('192.0.2.10').accept(HUB);
    expect(state().hosts[HUB].conn.status).toBe('live');
    // Neither waits any longer: each has a new attempt open right now.
    expect(socketsFor('192.0.2.11').length).toBe(waitingB + 1);
    expect(socketsFor('192.0.2.12').length).toBe(waitingC + 1);
    lastFor('192.0.2.11').accept(HUB_B);
    lastFor('192.0.2.12').accept(HUB_C);
    expect(Object.values(state().hosts).map((h) => h.conn.status)).toEqual(['live', 'live', 'live']);
    client.dispose();
  });

  it('foreground restarts attempts that began before the app went to the background', async () => {
    const appState = new FakeAppState();
    const { client } = await three({ appState });
    appState.set('background');
    jest.advanceTimersByTime(5_000);
    const before = FakeSocket.all.slice();
    appState.set('active');
    // Every attempt older than a second is closed, and each computer starts a fresh one now.
    const created = FakeSocket.all.slice(before.length);
    expect(created.map((ws) => ws.url).sort()).toEqual(['ws://192.0.2.10:7717/v1/ws', 'ws://192.0.2.11:7717/v1/ws', 'ws://192.0.2.12:7717/v1/ws']);
    expect(before.filter((ws) => !ws.closedBy).length).toBeLessThanOrEqual(3);
    expect(before[0].closedBy).not.toBeNull();
    client.dispose();
  });

  it('Reconnect (and pull to refresh) start a fresh attempt even while one hangs', async () => {
    const { client } = await three();
    const hanging = lastFor('192.0.2.10');
    jest.advanceTimersByTime(500);
    client.retryHost(HUB);
    expect(hanging.closedBy).not.toBeNull();
    expect(lastFor('192.0.2.10')).not.toBe(hanging);
    const others = [lastFor('192.0.2.11'), lastFor('192.0.2.12')];
    jest.advanceTimersByTime(1_200);
    await client.refresh();
    for (const ws of others) expect(ws.closedBy).not.toBeNull();
    client.dispose();
  });

  it('logs the launch, every attempt and the foreground per computer', async () => {
    const appState = new FakeAppState();
    const trace = new ConnTrace();
    const { client } = await three({ appState, trace });
    FakeSocket.all[0].accept(HUB);
    appState.set('background');
    appState.set('active');
    const kinds = trace.events(HUB).map((e) => e.kind);
    expect(kinds.slice(0, 4)).toEqual(['launch', 'attempt', 'open', 'welcome']);
    expect(kinds).toContain('background');
    expect(kinds).toContain('foreground');
    expect(trace.events(HUB)[0].text).toContain('phi 0.1.0 (42)');
    expect(trace.events(HUB_B).map((e) => e.kind).slice(0, 2)).toEqual(['launch', 'attempt']);
    await client.removeHost(HUB_B);
    expect(trace.hubIds()).not.toContain(HUB_B);
    client.dispose();
  });
});
