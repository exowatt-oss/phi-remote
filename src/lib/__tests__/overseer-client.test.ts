/**
 * Overseers (v1 addition) through the client: the feature flag, `overseer.board`, spawn `name`,
 * the defaults saved with the prefs, and the board poller (every ~5 s, sooner on upserts, live
 * summaries on older hubs).
 */

import { FakeSocket, session } from '../__fixtures__/fake-socket';
import { BoardPoller, type BoardEntry } from '../board-poller';
import { RemoteClient } from '../client';
import type { FetchLike, PairedHost } from '../pairing';
import { HubError } from '../protocol';
import { HostStorage, MemoryKV } from '../storage';

const HUB = 'hub-1';
const OV = 'ov-1';
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

async function setup() {
  const kv = new MemoryKV();
  const storage = new HostStorage(kv);
  await storage.save(host);
  const client = new RemoteClient({
    storage,
    createSocket: FakeSocket.factory,
    fetch: fetchSameHub,
    app: { version: '0.1.0', build: '1' },
    deviceName: 'iPhone',
    random: () => 0.5,
  });
  await client.init();
  return { client, storage, state: () => client.store.getState() };
}

async function goLive(features: string[] | undefined, sessions: Record<string, unknown>[] = [session()]) {
  const ws = FakeSocket.last();
  ws.open();
  ws.receive({ t: 'welcome', host: { name: 'MY-MAC', hubId: HUB, hubVersion: '1.4.0-exo.12', protocol: 1, ...(features ? { features } : {}) }, deviceId: 'dev-1' });
  ws.replyTo('sessions.list', { t: 'sessions', sessions });
  await jest.advanceTimersByTimeAsync(0);
  return ws;
}

beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.reset();
});
afterEach(() => jest.useRealTimers());

describe('client', () => {
  it('knows which computers have overseers and asks for a board', async () => {
    const { client } = await setup();
    const ws = await goLive(['history', 'overseer']);
    expect(client.hasOverseer(HUB)).toBe(true);
    const board = client.overseerBoard(HUB, OV);
    expect(ws.lastOf('overseer.board')).toEqual({ t: 'overseer.board', id: expect.any(String), sessionId: OV });
    ws.replyTo('overseer.board', {
      t: 'overseer.board',
      sessionId: OV,
      name: 'Overseer · ship it',
      threads: [{ name: 'api', sessionId: 'a', backend: 'forca', cwd: '/x', state: 'running', live: true, status: 'idle', createdAt: 1 }],
    });
    await expect(board).resolves.toEqual({
      sessionId: OV,
      name: 'Overseer · ship it',
      threads: [{ name: 'api', sessionId: 'a', backend: 'forca', cwd: '/x', state: 'running', live: true, status: 'idle', createdAt: 1 }],
    });
    const missing = client.overseerBoard(HUB, 'nope');
    ws.replyTo('overseer.board', { t: 'error', code: 'not_found', message: 'no overseer nope' });
    await expect(missing).rejects.toMatchObject({ code: 'not_found' });
    client.dispose();
  });

  it('treats an older hub (no feature) as one without overseers, but keeps its thread links', async () => {
    const { client, state } = await setup();
    await goLive(['history'], [session({ sessionId: 't1', overseer: { sessionId: OV, thread: 'api' }, lastError: '429' })]);
    expect(client.hasOverseer(HUB)).toBe(false);
    expect(state().sessions[HUB].t1.overseer).toEqual({ sessionId: OV, thread: 'api' });
    expect(state().sessions[HUB].t1.lastError).toBe('429');
    client.dispose();
  });

  it('spawns with a one-line name (older hubs ignore it)', async () => {
    const { client } = await setup();
    const ws = await goLive(['overseer']);
    const sp = client.spawn(HUB, { cwd: '/Users/f/x', prompt: '/skill:overseer go', name: '  Overseer ·\nship   it ' });
    expect(ws.lastOf('session.spawn')).toEqual({ t: 'session.spawn', id: expect.any(String), cwd: '/Users/f/x', prompt: '/skill:overseer go', name: 'Overseer · ship it' });
    ws.replyTo('session.spawn', { t: 'ack', ok: true, sessionId: 'n1' });
    await expect(sp).resolves.toBe('n1');
    const blank = client.spawn(HUB, { cwd: '/Users/f/x', name: '   ' });
    expect(ws.lastOf('session.spawn')).not.toHaveProperty('name');
    ws.replyTo('session.spawn', { t: 'ack', ok: true, sessionId: 'n2' });
    await blank;
    client.dispose();
  });

  it('saves the overseer defaults with the other prefs and reads them back', async () => {
    const { client, storage, state } = await setup();
    await client.updatePrefs({ overseer: { threadModel: 'fast-max', window: 'headless', maxThreads: 6 } });
    expect(state().prefs.overseer).toEqual({ threadModel: 'fast-max', window: 'headless', maxThreads: 6 });
    expect(await storage.loadPrefs()).toEqual({ overseer: { threadModel: 'fast-max', window: 'headless', maxThreads: 6 } });
    client.dispose();
    const again = new RemoteClient({ storage, createSocket: FakeSocket.factory, fetch: fetchSameHub, app: { version: '0.1.0', build: '1' }, deviceName: 'iPhone' });
    await again.init();
    expect(again.store.getState().prefs.overseer).toEqual({ threadModel: 'fast-max', window: 'headless', maxThreads: 6 });
    again.dispose();
  });
});

describe('BoardPoller', () => {
  const board = (n: number) => ({ sessionId: OV, threads: Array.from({ length: n }, (_, i) => ({ name: `t${i}`, sessionId: `t${i}`, backend: 'headless' as const, cwd: '/x', state: 'running' as const, live: true, createdAt: i })) });

  function poller(fetch: () => Promise<ReturnType<typeof board>>, supported = true) {
    const updates: Partial<BoardEntry>[] = [];
    const p = new BoardPoller({ fetch: jest.fn(fetch), supported: () => supported, onUpdate: (u) => updates.push(u), now: () => 42 });
    return { p, updates, fetch: (p as unknown as { opts: { fetch: jest.Mock } }).opts.fetch };
  }

  it('polls every 5 s while started and stops when hidden', async () => {
    const { p, updates, fetch } = poller(async () => board(2));
    p.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(updates[0]).toMatchObject({ source: 'hub', error: null, updatedAt: 42 });
    expect(updates[0].board?.threads).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(4_900);
    expect(fetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    p.stop();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refreshes soon after an upsert, once per burst', async () => {
    const { p, fetch } = poller(async () => board(1));
    p.start();
    await jest.advanceTimersByTimeAsync(0);
    p.poke();
    p.poke();
    p.poke();
    await jest.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(2);
    // the regular cadence resumes from there
    await jest.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it('a poke during a request asks once more right after it', async () => {
    let resolve: (b: ReturnType<typeof board>) => void = () => {};
    const { p, fetch } = poller(() => new Promise((r) => (resolve = r)));
    p.start();
    await jest.advanceTimersByTimeAsync(0);
    p.poke();
    resolve(board(1));
    await jest.advanceTimersByTimeAsync(450);
    expect(fetch).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('falls back to live summaries on an older hub, and never asks it', async () => {
    const { p, updates, fetch } = poller(async () => board(1), false);
    p.start();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(updates).toEqual([{ source: 'live', error: null }]);
  });

  it('stops asking after bad_request (a hub without the request)', async () => {
    const { p, updates, fetch } = poller(async () => {
      throw new HubError('bad_request', 'unknown frame type "overseer.board"');
    });
    p.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([{ board: null, source: 'live', error: null, updatedAt: 42 }]);
    p.stop();
    p.start(); // remembers
    await jest.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps polling through not_found (no registry yet) and transient errors, keeping the last board', async () => {
    let n = 0;
    const { p, updates, fetch } = poller(async () => {
      n += 1;
      if (n === 1) throw new HubError('not_found', 'no overseer');
      if (n === 2) throw new Error('timed out');
      return board(3);
    });
    p.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(updates[0]).toEqual({ board: null, source: 'live', error: null, updatedAt: 42 });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(updates[1]).toEqual({ error: 'timed out' }); // no board key: the last board stays
    await jest.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(updates[2].board?.threads).toHaveLength(3);
    p.stop();
  });
});
