import { FakeSocket } from '../__fixtures__/fake-socket';
import type { TraceInput } from '../conn-trace';
import {
  backoffDelay,
  ConnectionError,
  DEFAULT_TIMING,
  HostConnection,
  orderUrls,
  type ConnInfo,
  type HostConnectionOptions,
  type SocketLike,
} from '../connection';
import { HubError, type ServerFrame } from '../protocol';

const HUB = 'hub-abc';

function make(overrides: Partial<HostConnectionOptions> = {}) {
  const infos: ConnInfo[] = [];
  const frames: ServerFrame[] = [];
  const lives: string[] = [];
  const fetchInfo = jest.fn(async (_url: string) => ({ hubId: HUB }) as { hubId: string } | null);
  const conn = new HostConnection({
    hubId: HUB,
    token: 'tok-123',
    urls: ['http://192.0.2.10:7717', 'http://my-mac.local:7717'],
    app: { version: '0.1.0', build: '7' },
    deviceName: "Alex's iPhone",
    deps: { createSocket: FakeSocket.factory, fetchInfo, now: () => Date.now(), random: () => 0.5 },
    onFrame: (f) => frames.push(f),
    onInfo: (i) => infos.push(i),
    onLive: (_w, url) => lives.push(url),
    ...overrides,
  });
  return { conn, infos, frames, lives, fetchInfo };
}

beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.reset();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('helpers', () => {
  it('orders the preferred url first without duplicates', () => {
    expect(orderUrls(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(orderUrls(['a', 'b'], null)).toEqual(['a', 'b']);
  });

  it('backs off exponentially from 0.5 s to a 15 s cap with jitter', () => {
    const mid = () => 0.5;
    expect(backoffDelay(0, mid)).toBe(500);
    expect(backoffDelay(1, mid)).toBe(1000);
    expect(backoffDelay(4, mid)).toBe(8000);
    expect(backoffDelay(5, mid)).toBe(15000);
    expect(backoffDelay(20, mid)).toBe(15000);
    expect(backoffDelay(0, () => 0)).toBe(400);
    expect(backoffDelay(0, () => 1)).toBe(600);
    expect(backoffDelay(10, () => 1)).toBe(DEFAULT_TIMING.backoffMaxMs);
  });
});

describe('HostConnection', () => {
  it('sends hello first with token, app, device and features, then goes live on welcome', () => {
    const { conn, lives } = make();
    conn.start();
    const ws = FakeSocket.last();
    expect(ws.url).toBe('ws://192.0.2.10:7717/v1/ws');
    expect(conn.status).toBe('connecting');
    ws.open();
    expect(ws.frames()[0]).toEqual({
      t: 'hello',
      token: 'tok-123',
      protocol: 1,
      app: { version: '0.1.0', build: '7' },
      device: { name: "Alex's iPhone" },
      // Subagents (v1 addition): only clients that say so get subagent sessions.
      features: ['subagents'],
    });
    ws.receive({ t: 'welcome', host: { name: 'MY-MAC', hubId: HUB, hubVersion: '1', protocol: 1 }, deviceId: 'd' });
    expect(conn.status).toBe('live');
    expect(conn.getInfo().url).toBe('http://192.0.2.10:7717');
    expect(lives).toEqual(['http://192.0.2.10:7717']);
  });

  it('tries the preferred url first', () => {
    const { conn } = make({ preferredUrl: 'http://my-mac.local:7717' });
    conn.start();
    expect(FakeSocket.last().url).toBe('ws://my-mac.local:7717/v1/ws');
  });

  it('matches replies by id, queues requests until live, and passes unsolicited frames through', async () => {
    const { conn, frames } = make();
    conn.start();
    const ws = FakeSocket.last();
    const p = conn.request({ t: 'sessions.list' });
    ws.open();
    expect(ws.framesOf('sessions.list')).toHaveLength(0);
    ws.accept(HUB);
    const req = ws.lastOf('sessions.list');
    expect(typeof req.id).toBe('string');
    ws.receive({ t: 'session.remove', sessionId: 'x' });
    ws.receive({ t: 'sessions', re: req.id, sessions: [] });
    await expect(p).resolves.toEqual({ t: 'sessions', re: req.id, sessions: [] });
    expect(frames).toEqual([{ t: 'session.remove', sessionId: 'x' }]);
  });

  it('rejects with HubError on ack ok:false and on error frames', async () => {
    const { conn } = make();
    conn.start();
    const ws = FakeSocket.last();
    ws.accept(HUB);
    const a = conn.request({ t: 'session.abort', sessionId: 's' });
    ws.replyTo('session.abort', { t: 'ack', ok: false, error: { code: 'not_found', message: 'gone' } });
    await expect(a).rejects.toMatchObject({ name: 'HubError', code: 'not_found', message: 'gone' });
    const b = conn.request({ t: 'cwds.recent' });
    ws.replyTo('cwds.recent', { t: 'error', code: 'forbidden', message: 'no' });
    await expect(b).rejects.toBeInstanceOf(HubError);
  });

  it('times out requests after 15 s', async () => {
    const { conn } = make();
    conn.start();
    FakeSocket.last().accept(HUB);
    const p = conn.request({ t: 'models.list', sessionId: 's' });
    const assertion = expect(p).rejects.toMatchObject({ kind: 'timeout' });
    jest.advanceTimersByTime(14_999);
    await Promise.resolve();
    jest.advanceTimersByTime(1);
    await assertion;
  });

  it('falls back across urls, then backs off exponentially', () => {
    const { conn, infos } = make();
    conn.start();
    FakeSocket.last().fail();
    jest.advanceTimersByTime(250);
    jest.advanceTimersByTime(0);
    expect(FakeSocket.last().url).toBe('ws://my-mac.local:7717/v1/ws');
    FakeSocket.last().fail();
    // The first seconds of an outage read as Connecting…, with the next round scheduled.
    expect(conn.status).toBe('connecting');
    expect(conn.getInfo().retryAt).not.toBeNull();
    expect(infos[infos.length - 1].lastError).toBeTruthy();
    const count = FakeSocket.all.length;
    jest.advanceTimersByTime(499);
    expect(FakeSocket.all.length).toBe(count);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.all.length).toBe(count + 1);
    expect(FakeSocket.last().url).toBe('ws://192.0.2.10:7717/v1/ws');
    // second cycle fails → 1 s
    FakeSocket.last().fail();
    jest.advanceTimersByTime(0);
    FakeSocket.last().fail();
    const c2 = FakeSocket.all.length;
    jest.advanceTimersByTime(999);
    expect(FakeSocket.all.length).toBe(c2);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.all.length).toBe(c2 + 1);
  });

  it('caps backoff at 2 s while the outage is young, and at 15 s once it is two minutes old', () => {
    const { conn } = make({ urls: ['http://a:7717'] });
    conn.start();
    // Refused at once, round after round: the waits climb 0.5, 1, 2 s and stay at 2 s.
    const waits: number[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < DEFAULT_TIMING.fastWindowMs - 3_000) {
      FakeSocket.last().fail();
      const n = FakeSocket.all.length;
      let waited = 0;
      while (FakeSocket.all.length === n) {
        jest.advanceTimersByTime(100);
        waited += 100;
      }
      waits.push(waited);
    }
    expect(waits.slice(0, 3)).toEqual([500, 1000, 2000]);
    expect(Math.max(...waits)).toBe(DEFAULT_TIMING.backoffFastMaxMs);
    // Past the fast window the computer is likely really down: the wait grows to the 15 s cap.
    jest.advanceTimersByTime(5_000);
    for (let i = 0; i < 6; i++) {
      FakeSocket.last().fail();
      jest.advanceTimersByTime(DEFAULT_TIMING.backoffMaxMs);
    }
    const n = FakeSocket.all.length;
    FakeSocket.last().fail();
    jest.advanceTimersByTime(14_999);
    expect(FakeSocket.all.length).toBe(n);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.all.length).toBe(n + 1);
  });

  it('times out a socket that never opens, and reads offline only after the first 10 s', () => {
    const { conn } = make({ urls: ['http://a:7717'] });
    conn.start();
    const first = FakeSocket.last();
    jest.advanceTimersByTime(DEFAULT_TIMING.openTimeoutMs);
    expect(first.closedBy).not.toBeNull();
    expect(conn.status).toBe('connecting');
    jest.advanceTimersByTime(DEFAULT_TIMING.offlineAfterMs - DEFAULT_TIMING.openTimeoutMs);
    expect(conn.status).toBe('offline');
  });

  it('times out when the hub never sends welcome', () => {
    const { conn } = make({ urls: ['http://a:7717'] });
    conn.start();
    FakeSocket.last().open();
    jest.advanceTimersByTime(DEFAULT_TIMING.helloTimeoutMs);
    expect(FakeSocket.all[0].closedBy).not.toBeNull();
    jest.advanceTimersByTime(DEFAULT_TIMING.offlineAfterMs);
    expect(conn.status).toBe('offline');
  });

  it('marks the host unauthorized on 4401 from the right hub and stops retrying', async () => {
    const { conn, fetchInfo } = make();
    conn.start();
    const pending = conn.request({ t: 'sessions.list' });
    FakeSocket.last().open();
    FakeSocket.last().serverClose(4401, 'bad token');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchInfo).toHaveBeenCalledWith('http://192.0.2.10:7717');
    expect(conn.status).toBe('unauthorized');
    await expect(pending).rejects.toMatchObject({ kind: 'unauthorized' });
    const n = FakeSocket.all.length;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all.length).toBe(n);
    conn.resume();
    expect(FakeSocket.all.length).toBe(n);
    await expect(conn.request({ t: 'ping' })).rejects.toBeInstanceOf(ConnectionError);
  });

  it('treats 4401 from a different hub at that address as a url failure', async () => {
    const { conn, fetchInfo } = make();
    fetchInfo.mockResolvedValueOnce({ hubId: 'someone-else' });
    conn.start();
    FakeSocket.last().open();
    FakeSocket.last().serverClose(4401);
    await jest.advanceTimersByTimeAsync(0);
    expect(conn.status).not.toBe('unauthorized');
    expect(FakeSocket.last().url).toBe('ws://my-mac.local:7717/v1/ws');
  });

  it('stops on 4426 protocol mismatch', async () => {
    const { conn } = make();
    conn.start();
    FakeSocket.last().open();
    FakeSocket.last().serverClose(4426);
    expect(conn.status).toBe('incompatible');
    const n = FakeSocket.all.length;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all.length).toBe(n);
  });

  it('rejects a welcome from a different hub and tries the next url', () => {
    const { conn } = make();
    conn.start();
    FakeSocket.last().accept('other-hub');
    expect(conn.status).toBe('connecting');
    jest.advanceTimersByTime(0);
    expect(FakeSocket.last().url).toBe('ws://my-mac.local:7717/v1/ws');
    FakeSocket.last().accept(HUB);
    expect(conn.status).toBe('live');
    expect(conn.getInfo().url).toBe('http://my-mac.local:7717');
  });

  it('reconnects to the same url shortly after a live connection drops', async () => {
    const { conn, lives } = make();
    conn.start();
    FakeSocket.last().accept(HUB);
    const inflight = conn.request({ t: 'cwds.recent' });
    FakeSocket.last().serverClose(1006);
    await expect(inflight).rejects.toMatchObject({ kind: 'disconnected' });
    expect(conn.status).toBe('connecting');
    const n = FakeSocket.all.length;
    jest.advanceTimersByTime(500);
    expect(FakeSocket.all.length).toBe(n + 1);
    expect(FakeSocket.last().url).toBe('ws://192.0.2.10:7717/v1/ws');
    FakeSocket.last().accept(HUB);
    expect(lives).toHaveLength(2);
  });

  it('pings while live and reconnects when a ping goes unanswered', async () => {
    const { conn } = make();
    conn.start();
    const ws = FakeSocket.last();
    ws.accept(HUB);
    jest.advanceTimersByTime(DEFAULT_TIMING.pingIntervalMs);
    const ping = ws.lastOf('ping');
    ws.receive({ t: 'pong', re: ping.id as string });
    await jest.advanceTimersByTimeAsync(0);
    expect(conn.status).toBe('live');
    await jest.advanceTimersByTimeAsync(DEFAULT_TIMING.pingIntervalMs);
    expect(ws.framesOf('ping')).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(DEFAULT_TIMING.pingTimeoutMs);
    expect(ws.closedBy).not.toBeNull();
    expect(conn.status).toBe('connecting');
  });

  it('pauses without retrying and resumes immediately', () => {
    const { conn } = make();
    conn.start();
    const ws = FakeSocket.last();
    ws.accept(HUB);
    conn.pause();
    expect(ws.closedBy).toEqual({ code: 1000, reason: 'App in background' });
    expect(conn.status).toBe('paused');
    const n = FakeSocket.all.length;
    jest.advanceTimersByTime(60_000);
    expect(FakeSocket.all.length).toBe(n);
    conn.resume();
    expect(FakeSocket.all.length).toBe(n + 1);
    expect(conn.status).toBe('connecting');
  });

  it('ignores malformed and unknown frames', () => {
    const { conn, frames } = make();
    conn.start();
    const ws = FakeSocket.last();
    ws.accept(HUB);
    ws.receiveRaw('not json');
    ws.receiveRaw(42);
    ws.receive({ t: 'mystery', x: 1 });
    ws.receive({ t: 'session.upsert', session: { nope: true } });
    expect(frames).toEqual([]);
    expect(conn.status).toBe('live');
  });

  it('notify only sends while live', () => {
    const { conn } = make();
    conn.start();
    expect(conn.notify({ t: 'focus', sessionId: 's' })).toBe(false);
    FakeSocket.last().accept(HUB);
    expect(conn.notify({ t: 'focus', sessionId: 's' })).toBe(true);
    expect(FakeSocket.last().lastOf('focus')).toEqual({ t: 'focus', sessionId: 's' });
  });

  it('stop rejects queued requests and closes the socket', async () => {
    const { conn } = make();
    conn.start();
    const p = conn.request({ t: 'sessions.list' });
    conn.stop();
    await expect(p).rejects.toMatchObject({ kind: 'closed' });
    expect(FakeSocket.last().closedBy).not.toBeNull();
    expect(conn.status).toBe('idle');
  });
});

describe('reconnecting after an outage', () => {
  const two = ['http://192.0.2.10:7717', 'http://my-mac.local:7717'];

  it('tries the next address after the stagger while the first hangs, and the first welcome wins', () => {
    const { conn, lives } = make({ urls: two });
    conn.start();
    expect(FakeSocket.all.map((s) => s.url)).toEqual(['ws://192.0.2.10:7717/v1/ws']);
    jest.advanceTimersByTime(DEFAULT_TIMING.urlStaggerMs - 1);
    expect(FakeSocket.all).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.all.map((s) => s.url)).toEqual(['ws://192.0.2.10:7717/v1/ws', 'ws://my-mac.local:7717/v1/ws']);
    // The second address answers; the hanging first one is closed.
    FakeSocket.all[1].accept(HUB);
    expect(conn.status).toBe('live');
    expect(lives).toEqual(['http://my-mac.local:7717']);
    expect(FakeSocket.all[0].closedBy).not.toBeNull();
    // A late welcome on the closed socket changes nothing.
    FakeSocket.all[0].accept(HUB);
    expect(lives).toHaveLength(1);
  });

  it('regression: a dead first address costs the stagger, not the 8 s open timeout per address', () => {
    // Before: addresses were tried one after another, each waiting out openTimeoutMs (8 s),
    // so a stale preferred address delayed every round by 8 s.
    const { conn } = make({ urls: two, preferredUrl: 'http://192.0.2.10:7717' });
    conn.start();
    jest.advanceTimersByTime(DEFAULT_TIMING.urlStaggerMs);
    FakeSocket.last().accept(HUB);
    expect(conn.status).toBe('live');
    expect(DEFAULT_TIMING.urlStaggerMs).toBeLessThan(DEFAULT_TIMING.openTimeoutMs / 4);
  });

  it('regression: the network back after 45 s of refused connections is live within 2.5 s at any moment', () => {
    // Before: the backoff had climbed to its 15 s cap by then, so recovery waited up to 15 s (the
    // Simulator measured 11-15 s for 2 of 3 computers). Now the cap is 2 s while the outage is young.
    for (let offset = 0; offset < 4_000; offset += 250) {
      FakeSocket.reset();
      const { conn } = make({ urls: two });
      conn.start();
      let up = false;
      let backAt = 0;
      let liveAt = 0;
      const step = () => {
        for (const ws of FakeSocket.all) {
          if (ws.closedBy || (ws as unknown as { done?: boolean }).done) continue;
          (ws as unknown as { done?: boolean }).done = true;
          if (up) ws.accept(HUB);
          else ws.fail();
        }
      };
      const t0 = Date.now();
      while (!liveAt) {
        step();
        if (!up && Date.now() - t0 >= 45_000 + offset) {
          up = true;
          backAt = Date.now();
        }
        if (conn.status === 'live') liveAt = Date.now();
        else jest.advanceTimersByTime(50);
      }
      expect(liveAt - backAt).toBeLessThanOrEqual(2_500);
      conn.stop();
    }
  });

  it('regression: an attempt stuck on the dead path never blocks recovery for more than the stagger', () => {
    // A connection begun while the path was dead may never complete once it is back (seen with
    // VPN tunnels). Before: each such attempt held the round for its 8 s open timeout, then the
    // backoff waited; now a fresh attempt starts every urlStaggerMs while nothing answers.
    for (let offset = 0; offset < 3_000; offset += 300) {
      const born = new Map<SocketLike, number>();
      const createSocket = (url: string) => {
        const ws = FakeSocket.factory(url);
        born.set(ws, Date.now());
        return ws;
      };
      const { conn } = make({ urls: two, deps: { createSocket, fetchInfo: async () => null, now: () => Date.now(), random: () => 0.5 } });
      conn.start();
      const backAt = Date.now() + 45_000 + offset;
      while (conn.status !== 'live') {
        jest.advanceTimersByTime(50);
        // Only sockets made after the path came back connect; older ones hang until closed.
        const ok = [...born].find(([ws, at]) => at >= backAt && !(ws as FakeSocket).closedBy);
        if (ok) (ok[0] as FakeSocket).accept(HUB);
      }
      expect(Date.now() - backAt).toBeLessThanOrEqual(DEFAULT_TIMING.urlStaggerMs + 50);
      conn.stop();
    }
  });

  it('stops hedging once the outage is old: a really-down computer does not spin', () => {
    const { conn } = make({ urls: two });
    conn.start();
    // Nothing ever answers (every attempt hangs until its timeout).
    jest.advanceTimersByTime(DEFAULT_TIMING.fastWindowMs);
    const early = FakeSocket.all.length;
    jest.advanceTimersByTime(10 * 60_000);
    const late = FakeSocket.all.length - early;
    // Ten more minutes: at most one round (2 addresses) per 15 s backoff + 9.5 s round.
    expect(late).toBeLessThanOrEqual(Math.ceil((10 * 60_000) / (DEFAULT_TIMING.backoffMaxMs * 0.8 + DEFAULT_TIMING.openTimeoutMs)) * 2);
    // And never more than maxParallelAttempts sockets open at once.
    expect(FakeSocket.all.filter((ws) => !ws.closedBy).length).toBeLessThanOrEqual(DEFAULT_TIMING.maxParallelAttempts);
    // In the fast window a fresh attempt every 1.5 s: ~80 over two minutes, bounded.
    expect(early).toBeLessThanOrEqual(Math.ceil(DEFAULT_TIMING.fastWindowMs / DEFAULT_TIMING.urlStaggerMs) + 2);
  });

  it('reconnect() (network change) resets the backoff and starts a round now', () => {
    // (No hedging here: one attempt at a time keeps the counting simple.)
    const { conn } = make({ urls: ['http://a:7717'], timing: { urlStaggerMs: 60_000 } });
    conn.start();
    for (let i = 0; i < 6; i++) {
      FakeSocket.last().fail();
      jest.advanceTimersByTime(DEFAULT_TIMING.backoffFastMaxMs);
    }
    FakeSocket.last().fail();
    const n = FakeSocket.all.length;
    conn.reconnect('network changed', { fresh: true });
    expect(FakeSocket.all).toHaveLength(n + 1);
    // The ladder starts over: the next failure waits 0.5 s again.
    jest.advanceTimersByTime(DEFAULT_TIMING.kickMinIntervalMs);
    FakeSocket.last().fail();
    jest.advanceTimersByTime(499);
    expect(FakeSocket.all).toHaveLength(n + 1);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(n + 2);
  });

  it('reconnect() closes attempts that began before the trigger, keeps young ones and starts a fresh one', () => {
    const { conn } = make({ urls: ['http://a:7717'] });
    conn.start();
    const old = FakeSocket.last();
    jest.advanceTimersByTime(DEFAULT_TIMING.urlStaggerMs + 300);
    // No answer after the stagger: a second attempt is already on the way.
    const young = FakeSocket.last();
    expect(young).not.toBe(old);
    // Another computer just connected: the path is back now.
    conn.reconnect('mac-mini connected', { restartOlderThanMs: 1_000 });
    expect(old.closedBy).not.toBeNull();
    expect(young.closedBy).toBeNull();
    const fresh = FakeSocket.last();
    expect(fresh).not.toBe(young);
    fresh.accept(HUB);
    expect(conn.status).toBe('live');
    expect(young.closedBy).not.toBeNull();
  });

  it('reconnect() leaves an open socket waiting for welcome alone, however old', () => {
    const { conn } = make({ urls: ['http://a:7717'] });
    conn.start();
    const ws = FakeSocket.last();
    jest.advanceTimersByTime(1_000);
    ws.open();
    jest.advanceTimersByTime(3_000);
    const n = FakeSocket.all.length;
    conn.reconnect('devbox connected', { restartOlderThanMs: 2_000 });
    expect(ws.closedBy).toBeNull();
    expect(FakeSocket.all).toHaveLength(n);
    ws.receive({ t: 'welcome', host: { name: 'MY-MAC', hubId: HUB, hubVersion: '1', protocol: 1 }, deviceId: 'd' });
    expect(conn.status).toBe('live');
  });

  it('coalesces a storm of triggers: at most one round per kickMinIntervalMs', () => {
    const { conn } = make({ urls: ['http://a:7717'], timing: { urlStaggerMs: 60_000 } });
    conn.start();
    FakeSocket.last().fail();
    const n = FakeSocket.all.length;
    for (let i = 0; i < 20; i++) {
      conn.reconnect('network changed', { fresh: true, restartOlderThanMs: 0 });
      jest.advanceTimersByTime(100);
    }
    // 2 s of triggers every 100 ms: one immediate round and one at the end of the interval.
    expect(FakeSocket.all.length - n).toBeLessThanOrEqual(2);
  });

  it('a fresh reconnect shows Connecting… again for the first seconds', () => {
    const { conn } = make({ urls: ['http://a:7717'] });
    conn.start();
    FakeSocket.last().fail();
    jest.advanceTimersByTime(DEFAULT_TIMING.offlineAfterMs);
    expect(conn.status).toBe('offline');
    conn.reconnect('foreground', { fresh: true });
    expect(conn.status).toBe('connecting');
    FakeSocket.last().fail();
    expect(conn.status).toBe('connecting');
    jest.advanceTimersByTime(DEFAULT_TIMING.offlineAfterMs);
    expect(conn.status).toBe('offline');
    // A trigger that is not fresh (another computer connected) keeps it offline while it retries.
    jest.advanceTimersByTime(DEFAULT_TIMING.kickMinIntervalMs);
    conn.reconnect('mac-mini connected', { restartOlderThanMs: 2_000 });
    expect(conn.status).toBe('offline');
  });

  it('reconnect() with probe checks a live connection with a ping and drops it when it does not answer', async () => {
    const { conn } = make({ urls: ['http://a:7717'] });
    conn.start();
    const ws = FakeSocket.last();
    ws.accept(HUB);
    conn.reconnect('network changed', { probe: true });
    const ping = ws.lastOf('ping');
    ws.receive({ t: 'pong', re: ping.id as string });
    await jest.advanceTimersByTimeAsync(0);
    expect(conn.status).toBe('live');
    jest.advanceTimersByTime(DEFAULT_TIMING.kickMinIntervalMs);
    conn.reconnect('network changed', { probe: true });
    expect(ws.framesOf('ping')).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(DEFAULT_TIMING.probeTimeoutMs);
    expect(ws.closedBy).not.toBeNull();
    expect(conn.status).toBe('connecting');
    await jest.advanceTimersByTimeAsync(500);
    expect(FakeSocket.last()).not.toBe(ws);
  });

  it('does nothing while paused or after unpairing', async () => {
    const { conn } = make({ urls: ['http://a:7717'] });
    conn.start();
    conn.pause();
    const n = FakeSocket.all.length;
    conn.reconnect('network changed', { fresh: true });
    expect(FakeSocket.all).toHaveLength(n);
    conn.resume();
    FakeSocket.last().open();
    FakeSocket.last().serverClose(4401);
    await jest.advanceTimersByTimeAsync(0);
    expect(conn.status).toBe('unauthorized');
    const m = FakeSocket.all.length;
    conn.reconnect('network changed', { fresh: true });
    expect(FakeSocket.all).toHaveLength(m);
  });

  it('logs every step with its timing', () => {
    const traces: TraceInput[] = [];
    const { conn } = make({ urls: two, onTrace: (e) => traces.push(e) });
    conn.start();
    jest.advanceTimersByTime(120);
    FakeSocket.all[0].fail();
    jest.advanceTimersByTime(0);
    const second = FakeSocket.last();
    jest.advanceTimersByTime(80);
    second.open();
    jest.advanceTimersByTime(40);
    second.receive({ t: 'welcome', host: { name: 'MY-MAC', hubId: HUB, hubVersion: '1.4.0', protocol: 1 }, deviceId: 'd' });
    second.serverClose(1006);
    expect(traces.map((t) => t.kind)).toEqual(['attempt', 'fail', 'attempt', 'open', 'welcome', 'drop', 'retry']);
    expect(traces[1]).toMatchObject({ url: two[0], ms: 120, code: 1006 });
    expect(traces[3]).toMatchObject({ url: two[1], ms: 80, text: 'hello sent' });
    expect(traces[4]).toMatchObject({ url: two[1], ms: 120 });
    expect(traces[4].text).toContain('phi 1.4.0');
    expect(traces[6]).toMatchObject({ kind: 'retry', ms: 500 });
  });
});
