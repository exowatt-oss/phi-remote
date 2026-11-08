/**
 * One WebSocket connection to one hub (docs/PROTOCOL.md): `hello` first, request/response by
 * id with timeouts, app-level ping, the 4401 / 4426 close codes, and reconnecting:
 *
 *   - A round tries the host's urls, the last one that worked first; the next url starts
 *     alongside after `urlStaggerMs` (or at once when one fails), so a dead address never costs
 *     a full open timeout before a working one is tried.
 *   - While the outage is young (`fastWindowMs`) and no socket has opened, a fresh attempt starts
 *     every `urlStaggerMs` even if older ones still hang (at most `maxParallelAttempts`): an
 *     attempt begun on a dead path may never complete when the path comes back (a VPN tunnel
 *     re-keying), and this bounds the wait for one that will.
 *   - Between failed rounds: exponential backoff with jitter, capped at `backoffFastMaxMs` while
 *     the outage is young (the network is usually coming back) and `backoffMaxMs` after.
 *   - `reconnect()` resets the backoff and retries now (network change, foreground, another
 *     computer reconnecting), restarting attempts that began before the trigger; triggers closer
 *     than `kickMinIntervalMs` coalesce, so a storm of them never spins.
 *   - For the first `offlineAfterMs` of an outage (launch, foreground, a drop) the status is
 *     `connecting`; only then `offline`.
 *
 * Every step is reported to `onTrace` (the connection log). UI-independent; every platform
 * dependency (socket factory, clock, randomness, info probe) is injected so it can be unit-tested.
 */

import type { TraceInput } from './conn-trace';
import { wsUrlFor } from './pairing';
import {
  CLIENT_FEATURES,
  CLOSE_PROTOCOL_MISMATCH,
  CLOSE_UNAUTHORIZED,
  HubError,
  PROTOCOL_VERSION,
  parseServerFrame,
  type ClientNotice,
  type ClientRequest,
  type HelloFrame,
  type ReplyFor,
  type ServerFrame,
  type ServerFrameOf,
} from './protocol';

export interface SocketLike {
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data?: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type ConnectionDeps = {
  createSocket: (url: string) => SocketLike;
  /** GET /v1/info on a base url; used to tell a revoked token from a different hub on 4401. */
  fetchInfo: (baseUrl: string) => Promise<{ hubId: string } | null>;
  now: () => number;
  random: () => number;
};

export type ConnectionTiming = {
  requestTimeoutMs: number;
  openTimeoutMs: number;
  helloTimeoutMs: number;
  pingIntervalMs: number;
  pingTimeoutMs: number;
  backoffInitialMs: number;
  /** Backoff cap once an outage is older than `fastWindowMs` (the computer is really down). */
  backoffMaxMs: number;
  /** Backoff cap while the outage is younger than `fastWindowMs`. */
  backoffFastMaxMs: number;
  fastWindowMs: number;
  /** Not live this long into an outage: `offline` (before that: `connecting`). */
  offlineAfterMs: number;
  /** The next url of a round starts this long after the previous one if neither has finished. */
  urlStaggerMs: number;
  /** Ping timeout when checking a live connection after a network change or foreground. */
  probeTimeoutMs: number;
  /** `reconnect()` calls closer together than this coalesce into one. */
  kickMinIntervalMs: number;
  /** Attempts in flight at once per computer (the oldest is closed for a fresh one). */
  maxParallelAttempts: number;
};

export const DEFAULT_TIMING: ConnectionTiming = {
  requestTimeoutMs: 15_000,
  openTimeoutMs: 8_000,
  helloTimeoutMs: 8_000,
  pingIntervalMs: 25_000,
  pingTimeoutMs: 10_000,
  backoffInitialMs: 500,
  backoffMaxMs: 15_000,
  backoffFastMaxMs: 2_000,
  fastWindowMs: 120_000,
  offlineAfterMs: 10_000,
  urlStaggerMs: 1_500,
  probeTimeoutMs: 4_000,
  kickMinIntervalMs: 2_000,
  maxParallelAttempts: 4,
};

export type ConnStatus =
  /** Not started, or stopped. */
  | 'idle'
  /** Trying: the first `offlineAfterMs` of an outage (launch, foreground, after a drop). */
  | 'connecting'
  | 'live'
  /** Still not live after the first attempts; retrying in the background. */
  | 'offline'
  /** Closed on purpose while the app is in the background. */
  | 'paused'
  /** Token rejected (close 4401). Terminal until re-paired. */
  | 'unauthorized'
  /** Protocol mismatch (close 4426). Terminal until someone updates. */
  | 'incompatible';

export type ConnInfo = {
  status: ConnStatus;
  url: string | null;
  lastError: string | null;
  /** When the next round starts (while waiting between rounds). */
  retryAt: number | null;
  lastSeenAt: number | null;
  hubVersion: string | null;
  /** When the current outage began (null while live / idle). */
  since?: number | null;
};

export type ConnectionErrorKind = 'timeout' | 'disconnected' | 'unauthorized' | 'incompatible' | 'closed';

export class ConnectionError extends Error {
  readonly kind: ConnectionErrorKind;
  constructor(kind: ConnectionErrorKind, message: string) {
    super(message);
    this.name = 'ConnectionError';
    this.kind = kind;
  }
}

export type HostConnectionOptions = {
  hubId: string;
  token: string;
  urls: string[];
  preferredUrl?: string | null;
  app: { version: string; build: string };
  deviceName?: string;
  deps: ConnectionDeps;
  timing?: Partial<ConnectionTiming>;
  /** Unsolicited frames, plus replies that arrive after their request timed out. */
  onFrame: (frame: ServerFrame) => void;
  onInfo: (info: ConnInfo) => void;
  /** After `welcome`, with the url that worked. */
  onLive: (welcome: ServerFrameOf<'welcome'>, url: string) => void;
  /** The connection log. */
  onTrace?: (event: TraceInput) => void;
};

export type ReconnectOptions = {
  /** Start a new "Connecting…" window (launch, foreground, network change). */
  fresh?: boolean;
  /** Attempts in flight that began at least this long ago are restarted (default: never). */
  restartOlderThanMs?: number;
  /** While live, check the connection with a ping (it may have died with the old network). */
  probe?: boolean;
};

const EXPECTED_REPLY: Partial<Record<ClientRequest['t'], ServerFrame['t']>> = {
  ping: 'pong',
  'sessions.list': 'sessions',
  'session.subscribe': 'session.snapshot',
  'session.history': 'session.history',
  'models.list': 'models',
  'cwds.recent': 'cwds',
  'commands.list': 'commands',
  'sessions.past': 'sessions.past',
  'session.transcript': 'session.transcript',
  'overseer.board': 'overseer.board',
};

type Timer = ReturnType<typeof setTimeout>;

type Pending = {
  id: string;
  frame: ClientRequest & { id: string };
  expect: ServerFrame['t'];
  resolve: (frame: ServerFrame) => void;
  reject: (err: Error) => void;
  timer: Timer;
};

/** One socket: racing to welcome (in `attempts`), then the live one. */
type Attempt = {
  url: string;
  ws: SocketLike;
  startedAt: number;
  openedAt: number | null;
  openTimer: Timer | null;
  helloTimer: Timer | null;
  errorTimer: Timer | null;
};

/** Orders urls with the preferred one first, de-duplicated. */
export function orderUrls(urls: string[], preferred?: string | null): string[] {
  const out: string[] = [];
  if (preferred) out.push(preferred);
  for (const u of urls) if (!out.includes(u)) out.push(u);
  return out;
}

/** Exponential backoff with ±20% jitter: 0.5 s, 1 s, 2 s … capped at `maxMs`. */
export function backoffDelay(attempt: number, random: () => number, timing = DEFAULT_TIMING, maxMs = timing.backoffMaxMs): number {
  const base = Math.min(maxMs, timing.backoffInitialMs * 2 ** Math.max(0, attempt));
  const jittered = base * (0.8 + 0.4 * random());
  return Math.round(Math.min(maxMs, jittered));
}

export class HostConnection {
  readonly hubId: string;
  private readonly opts: HostConnectionOptions;
  private readonly timing: ConnectionTiming;
  private readonly urls: string[];
  private preferred: string;

  /** Racing for welcome, oldest first. */
  private attempts: Attempt[] = [];
  /** The live socket (after welcome). */
  private live: Attempt | null = null;
  private liveSince = 0;
  /** Bumps whenever the live socket goes (guards ping/probe callbacks). */
  private gen = 0;
  /** urls of the current round, and how many have started. */
  private round: string[] = [];
  private roundNext = 0;
  private rounds = 0;
  /** Failed rounds in a row (the backoff step). */
  private attempt = 0;
  /** Start of the current outage (drives connecting → offline and the fast backoff window). */
  private outageStart: number | null = null;
  private lastKickAt = Number.NEGATIVE_INFINITY;
  private pendingKick: ReconnectOptions | null = null;
  private probing = false;
  /** 4401 answers being checked with /v1/info (the round cannot end before they are). */
  private verifying = 0;
  private stopped = false;
  private paused = false;
  private nextId = 1;

  private retryTimer: Timer | null = null;
  private staggerTimer: Timer | null = null;
  private pingTimer: Timer | null = null;
  private offlineTimer: Timer | null = null;
  private kickTimer: Timer | null = null;

  /** Sent and awaiting a reply. */
  private readonly inflight = new Map<string, Pending>();
  /** Waiting for the connection to go live. */
  private queue: Pending[] = [];

  private info: ConnInfo = {
    status: 'idle',
    url: null,
    lastError: null,
    retryAt: null,
    lastSeenAt: null,
    hubVersion: null,
    since: null,
  };

  constructor(opts: HostConnectionOptions) {
    this.opts = opts;
    this.hubId = opts.hubId;
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.urls = orderUrls(opts.urls, opts.preferredUrl);
    if (this.urls.length === 0) throw new Error('HostConnection needs at least one url');
    this.preferred = this.urls[0];
  }

  get status(): ConnStatus {
    return this.info.status;
  }

  getInfo(): ConnInfo {
    return this.info;
  }

  /** Starts connecting (no-op when already trying/live or in a terminal state). */
  start(): void {
    if (this.stopped) return;
    this.paused = false;
    if (this.isTerminal() || this.live || this.attempts.length) return;
    if (this.outageStart === null) this.beginOutage();
    this.beginRound('start');
  }

  /** Reconnects now if not live (paused, offline, waiting), resetting backoff. */
  resume(): void {
    if (this.stopped) return;
    const wasPaused = this.paused;
    this.paused = false;
    if (this.isTerminal() || this.live) return;
    if (this.attempts.length && !wasPaused) return;
    this.attempt = 0;
    this.beginOutage();
    this.beginRound(wasPaused ? 'resume' : 'reconnect');
  }

  /**
   * Something says the network may be back (path change, foreground, another computer just
   * connected): reset the backoff and start a round now, closing attempts older than
   * `restartOlderThanMs`. While live, `probe` checks the connection with a ping.
   */
  reconnect(reason: string, options: ReconnectOptions = {}): void {
    if (this.stopped || this.paused || this.isTerminal()) return;
    if (this.live) {
      if (options.probe) this.probe(reason);
      return;
    }
    const now = this.opts.deps.now();
    const wait = this.lastKickAt + this.timing.kickMinIntervalMs - now;
    if (wait > 0) {
      // Coalesce: one more round at the end of the interval covers every trigger meanwhile.
      const p = this.pendingKick;
      this.pendingKick = {
        fresh: !!(p?.fresh || options.fresh),
        probe: !!(p?.probe || options.probe),
        restartOlderThanMs: Math.min(p?.restartOlderThanMs ?? Infinity, options.restartOlderThanMs ?? Infinity),
      };
      if (!this.kickTimer) {
        this.kickTimer = setTimeout(() => {
          this.kickTimer = null;
          const o = this.pendingKick ?? {};
          this.pendingKick = null;
          this.reconnect(reason, o);
        }, wait);
      }
      return;
    }
    this.lastKickAt = now;
    this.attempt = 0;
    if (options.fresh || this.outageStart === null) this.beginOutage();
    // Attempts that began before the trigger may be stuck on the old path: close them. Younger
    // ones, and any whose socket already opened (waiting for welcome), keep going beside the fresh
    // round (whichever answers first wins).
    const restartAfter = options.restartOlderThanMs ?? Infinity;
    const old = this.attempts.filter((a) => a.openedAt === null && now - a.startedAt >= restartAfter);
    if (old.length) {
      this.attempts = this.attempts.filter((a) => !old.includes(a));
      for (const a of old) {
        this.closeSocket(a, 1000, 'Restarted');
        this.trace({ kind: 'fail', url: a.url, ms: now - a.startedAt, text: `restarted: ${reason}` });
      }
    }
    if (this.attempts.some((a) => a.openedAt !== null)) {
      // A socket is open and waiting for welcome: the path works; let it finish.
      this.setInfo({ status: this.statusWhileTrying(), since: this.outageStart });
      return;
    }
    this.trace({ kind: 'kick', text: reason });
    this.beginRound(reason);
  }

  /** Closes the socket without retrying (app in background). */
  pause(): void {
    if (this.stopped || this.paused) return;
    this.paused = true;
    this.clearTimer('retry');
    this.clearTimer('kick');
    this.clearTimer('offline');
    this.pendingKick = null;
    this.abortAttempts();
    if (this.live) this.teardownLive('App in background', 1000);
    this.outageStart = null;
    this.trace({ kind: 'pause' });
    if (!this.isTerminal()) this.setInfo({ status: 'paused', retryAt: null, since: null });
  }

  /** Permanently stops this connection and rejects everything outstanding. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of ['retry', 'kick', 'offline', 'stagger'] as const) this.clearTimer(t);
    this.abortAttempts();
    if (this.live) this.teardownLive('Stopped', 1000);
    this.rejectQueue(new ConnectionError('closed', 'Connection closed'));
    this.setInfo({ status: 'idle', retryAt: null, since: null });
  }

  /** Sends a request and resolves with its reply. Waits for the connection while connecting. */
  request<R extends ClientRequest>(frame: R, opts?: { timeoutMs?: number }): Promise<ReplyFor<R>> {
    if (this.stopped) return Promise.reject(new ConnectionError('closed', 'Connection closed'));
    if (this.info.status === 'unauthorized') {
      return Promise.reject(new ConnectionError('unauthorized', 'This phone is no longer paired with that computer.'));
    }
    if (this.info.status === 'incompatible') {
      return Promise.reject(new ConnectionError('incompatible', 'This computer runs an incompatible phi remote.'));
    }
    const id = `r${this.nextId++}`;
    const timeoutMs = opts?.timeoutMs ?? this.timing.requestTimeoutMs;
    return new Promise<ReplyFor<R>>((resolve, reject) => {
      const entry: Pending = {
        id,
        frame: { ...frame, id },
        expect: EXPECTED_REPLY[frame.t] ?? 'ack',
        resolve: resolve as (f: ServerFrame) => void,
        reject,
        timer: setTimeout(() => {
          this.inflight.delete(id);
          this.queue = this.queue.filter((p) => p !== entry);
          reject(new ConnectionError('timeout', 'The computer did not answer in time.'));
        }, timeoutMs),
      };
      if (this.info.status === 'live' && this.live) this.transmit(entry);
      else this.queue.push(entry);
    });
  }

  /** Fire-and-forget frame; dropped (returns false) unless live. */
  notify(frame: ClientNotice): boolean {
    if (this.info.status !== 'live' || !this.live) return false;
    try {
      this.live.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private isTerminal(): boolean {
    return this.info.status === 'unauthorized' || this.info.status === 'incompatible';
  }

  private trace(e: TraceInput): void {
    this.opts.onTrace?.(e);
  }

  private setInfo(patch: Partial<ConnInfo>): void {
    const next = { ...this.info, ...patch };
    const changed = (Object.keys(next) as (keyof ConnInfo)[]).some((k) => next[k] !== this.info[k]);
    if (!changed) return;
    this.info = next;
    this.opts.onInfo(next);
  }

  private clearTimer(which: 'retry' | 'stagger' | 'ping' | 'offline' | 'kick'): void {
    const key = `${which}Timer` as const;
    const t = this[key];
    if (t !== null) clearTimeout(t);
    this[key] = null;
  }

  /** Not live this long into the outage yet: still "Connecting…". */
  private trying(now = this.opts.deps.now()): boolean {
    return this.outageStart !== null && now - this.outageStart < this.timing.offlineAfterMs;
  }

  /** A new outage window: `connecting` for `offlineAfterMs`, then `offline` unless live by then. */
  private beginOutage(): void {
    const now = this.opts.deps.now();
    this.outageStart = now;
    this.clearTimer('offline');
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      if (this.live || this.stopped || this.paused || this.isTerminal()) return;
      this.trace({ kind: 'offline', text: `not live after ${Math.round(this.timing.offlineAfterMs / 1000)} s` });
      this.setInfo({ status: 'offline' });
    }, this.timing.offlineAfterMs);
  }

  private statusWhileTrying(): 'connecting' | 'offline' {
    return this.trying() ? 'connecting' : 'offline';
  }

  /** Starts a round: the urls in order (preferred first), each after the stagger or a failure. */
  private beginRound(why: string): void {
    if (this.stopped || this.paused || this.isTerminal()) return;
    this.clearTimer('retry');
    this.clearTimer('stagger');
    this.rounds += 1;
    this.round = orderUrls(this.urls, this.preferred);
    this.roundNext = 0;
    this.verifying = 0;
    this.setInfo({ status: this.statusWhileTrying(), url: this.round[0], retryAt: null, since: this.outageStart });
    this.launchNext(why);
  }

  private launchNext(why: string): void {
    this.clearTimer('stagger');
    if (this.roundNext >= this.round.length) return;
    const url = this.round[this.roundNext++];
    const n = this.roundNext;
    this.openAttempt(url, `round ${this.rounds}, ${n}/${this.round.length}${n === 1 ? ` · ${why}` : ''}`);
    // (openAttempt may already have moved on to the next url when the socket could not be made.)
    if (this.staggerTimer === null && this.attempts.length && (this.roundNext < this.round.length || this.hedging())) {
      this.staggerTimer = setTimeout(() => {
        this.staggerTimer = null;
        if (this.roundNext < this.round.length) this.launchNext(why);
        else if (this.hedging()) this.beginRound('no answer yet');
      }, this.timing.urlStaggerMs);
    }
  }

  /**
   * Start another round while earlier attempts still hang? Only early in an outage (the fast
   * window), while nothing has even opened a socket (an open one is waiting for welcome: the
   * path works) and no 4401 is being checked.
   */
  private hedging(): boolean {
    if (this.stopped || this.paused || this.isTerminal() || this.live || this.verifying > 0) return false;
    if (this.attempts.length === 0 || this.attempts.some((a) => a.openedAt !== null)) return false;
    const start = this.outageStart;
    return start !== null && this.opts.deps.now() - start < this.timing.fastWindowMs;
  }

  private openAttempt(url: string, note: string): void {
    const now = this.opts.deps.now();
    // At most maxParallelAttempts in flight: the oldest makes room (noted on this line, not its own).
    let replaced = '';
    while (this.attempts.length >= this.timing.maxParallelAttempts) {
      // (A socket that already opened is waiting for welcome: never the one to go.)
      const oldest = this.attempts.find((x) => x.openedAt === null);
      if (!oldest) break;
      this.attempts = this.attempts.filter((x) => x !== oldest);
      this.closeSocket(oldest, 1000, 'Replaced by a fresh attempt');
      replaced = ` · replaces one started ${formatSeconds(now - oldest.startedAt)} ago`;
    }
    this.trace({ kind: 'attempt', url, text: `${note}${replaced}` });
    let ws: SocketLike;
    try {
      ws = this.opts.deps.createSocket(wsUrlFor(url));
    } catch (err) {
      this.trace({ kind: 'fail', url, ms: 0, text: `Could not open a connection${err instanceof Error && err.message ? `: ${err.message}` : ''}` });
      this.attemptGone('Could not open a connection');
      return;
    }
    const a: Attempt = { url, ws, startedAt: now, openedAt: null, openTimer: null, helloTimer: null, errorTimer: null };
    this.attempts.push(a);
    a.openTimer = setTimeout(() => this.attemptFailed(a, 'Timed out connecting'), this.timing.openTimeoutMs);

    ws.onopen = () => {
      if (!this.attempts.includes(a)) return;
      if (a.openTimer) clearTimeout(a.openTimer);
      a.openTimer = null;
      a.openedAt = this.opts.deps.now();
      const hello: HelloFrame = {
        t: 'hello',
        token: this.opts.token,
        protocol: PROTOCOL_VERSION,
        app: this.opts.app,
        features: [...CLIENT_FEATURES],
      };
      if (this.opts.deviceName) hello.device = { name: this.opts.deviceName };
      try {
        ws.send(JSON.stringify(hello));
      } catch {
        this.attemptFailed(a, 'Could not send hello');
        return;
      }
      this.trace({ kind: 'open', url, ms: a.openedAt - a.startedAt, text: 'hello sent' });
      a.helloTimer = setTimeout(() => this.attemptFailed(a, 'The computer did not answer'), this.timing.helloTimeoutMs);
    };
    ws.onmessage = (ev) => {
      if (this.live === a) this.handleMessage(ev?.data);
      else if (this.attempts.includes(a)) this.attemptMessage(a, ev?.data);
    };
    ws.onerror = () => {
      if (this.live !== a && !this.attempts.includes(a)) return;
      // A close event normally follows; only fail here if it doesn't.
      if (a.errorTimer === null) {
        a.errorTimer = setTimeout(() => {
          a.errorTimer = null;
          if (this.live === a) this.failLive('Connection error');
          else this.attemptFailed(a, 'Connection error');
        }, 250);
      }
    };
    ws.onclose = (ev) => {
      const code = ev?.code ?? 1006;
      if (this.live === a) this.liveClosed(code, ev?.reason);
      else if (this.attempts.includes(a)) this.attemptClosed(a, code, ev?.reason);
    };
  }

  private clearAttemptTimers(a: Attempt): void {
    for (const k of ['openTimer', 'helloTimer', 'errorTimer'] as const) {
      const t = a[k];
      if (t !== null) clearTimeout(t);
      a[k] = null;
    }
  }

  private closeSocket(a: Attempt, code: number, reason: string): void {
    this.clearAttemptTimers(a);
    const ws = a.ws;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  private abortAttempts(): void {
    this.clearTimer('stagger');
    const list = this.attempts;
    this.attempts = [];
    for (const a of list) this.closeSocket(a, 1000, 'Not needed');
  }

  private attemptMessage(a: Attempt, data: unknown): void {
    const frame = parseServerFrame(typeof data === 'string' ? data : null);
    if (!frame) return;
    if (frame.t === 'welcome') this.handleWelcome(a, frame);
    else if (frame.t === 'error') this.info = { ...this.info, lastError: frame.message };
  }

  private attemptFailed(a: Attempt, reason: string, code?: number): void {
    if (!this.attempts.includes(a)) return;
    this.attempts = this.attempts.filter((x) => x !== a);
    this.closeSocket(a, 4000, reason);
    this.trace({ kind: 'fail', url: a.url, ms: this.opts.deps.now() - a.startedAt, code, text: reason });
    this.attemptGone(reason);
  }

  /** An attempt ended without welcome: start the next url now, or end the round. */
  private attemptGone(reason: string): void {
    if (this.stopped || this.paused || this.isTerminal()) return;
    this.info = { ...this.info, lastError: reason };
    if (this.roundNext < this.round.length) {
      this.launchNext('next address');
      return;
    }
    if (this.attempts.length === 0 && this.verifying === 0) this.roundFailed(reason);
  }

  private attemptClosed(a: Attempt, code: number, reason?: string): void {
    if (code === CLOSE_PROTOCOL_MISMATCH) {
      this.trace({ kind: 'fail', url: a.url, ms: this.opts.deps.now() - a.startedAt, code, text: reason || 'protocol mismatch' });
      this.enterTerminal('incompatible', 'This computer runs an incompatible phi remote.');
      return;
    }
    if (code === CLOSE_UNAUTHORIZED) {
      // Revoked token, or a different hub now answers at this address? Ask /v1/info. The round
      // waits for the answer before it can end.
      this.attempts = this.attempts.filter((x) => x !== a);
      this.closeSocket(a, 1000, 'unauthorized');
      this.trace({ kind: 'fail', url: a.url, ms: this.opts.deps.now() - a.startedAt, code, text: reason || 'unauthorized' });
      const round = this.rounds;
      this.verifying += 1;
      this.opts.deps
        .fetchInfo(a.url)
        .catch(() => null)
        .then((info) => {
          if (round === this.rounds) this.verifying -= 1;
          if (this.stopped || this.paused || this.isTerminal()) return;
          if (info && info.hubId !== this.hubId) {
            this.dropPreferred(a.url);
            if (!this.live && round === this.rounds) this.attemptGone('A different computer answered at this address');
          } else {
            this.enterTerminal('unauthorized', 'This phone was unpaired from the computer.');
          }
        });
      return;
    }
    this.attemptFailed(a, describeClose(code, reason, false), code);
  }

  /** A url that answered as someone else goes last next time. */
  private dropPreferred(url: string): void {
    if (this.preferred !== url) return;
    this.preferred = this.urls.find((u) => u !== url) ?? url;
  }

  private handleWelcome(a: Attempt, frame: ServerFrameOf<'welcome'>): void {
    if (frame.host.hubId !== this.hubId) {
      this.dropPreferred(a.url);
      this.attemptFailed(a, 'A different computer answered at this address');
      return;
    }
    if (frame.host.protocol !== PROTOCOL_VERSION) {
      this.enterTerminal('incompatible', 'This computer runs an incompatible phi remote.', 1000);
      return;
    }
    const now = this.opts.deps.now();
    // The winner: the other attempts of this round are not needed.
    this.attempts = this.attempts.filter((x) => x !== a);
    this.abortAttempts();
    this.clearAttemptTimers(a);
    this.clearTimer('retry');
    this.clearTimer('offline');
    this.clearTimer('kick');
    this.pendingKick = null;
    this.live = a;
    this.liveSince = now;
    const gen = ++this.gen;
    const outage = this.outageStart;
    this.outageStart = null;
    this.attempt = 0;
    this.preferred = a.url;
    this.info = { ...this.info, lastSeenAt: now };
    this.trace({
      kind: 'welcome',
      url: a.url,
      ms: now - a.startedAt,
      text: [frame.host.hubVersion ? `phi ${frame.host.hubVersion}` : '', outage !== null ? `trying for ${formatSeconds(now - outage)}` : '']
        .filter(Boolean)
        .join(' · ') || undefined,
    });
    this.setInfo({
      status: 'live',
      url: a.url,
      lastError: null,
      retryAt: null,
      hubVersion: frame.host.hubVersion || null,
      since: null,
    });
    const queued = this.queue;
    this.queue = [];
    for (const entry of queued) this.transmit(entry);
    this.schedulePing(gen);
    this.opts.onLive(frame, a.url);
  }

  private handleMessage(data: unknown): void {
    this.info = { ...this.info, lastSeenAt: this.opts.deps.now() };
    const frame = parseServerFrame(typeof data === 'string' ? data : null);
    if (!frame) return;
    const re = 're' in frame ? frame.re : undefined;
    if (re !== undefined) {
      const entry = this.inflight.get(re);
      if (entry) {
        this.inflight.delete(re);
        clearTimeout(entry.timer);
        if (frame.t === 'error') entry.reject(new HubError(frame.code, frame.message));
        else if (frame.t === 'ack' && !frame.ok) {
          entry.reject(new HubError(frame.error?.code ?? 'internal', frame.error?.message ?? 'Request failed'));
        } else if (frame.t !== entry.expect) {
          entry.reject(new HubError('bad_response', `Unexpected reply ${frame.t}`));
        } else entry.resolve(frame);
        return;
      }
    }
    this.opts.onFrame(frame);
  }

  private transmit(entry: Pending): void {
    if (!this.live) {
      this.queue.push(entry);
      return;
    }
    this.inflight.set(entry.id, entry);
    try {
      this.live.ws.send(JSON.stringify(entry.frame));
    } catch {
      this.inflight.delete(entry.id);
      clearTimeout(entry.timer);
      entry.reject(new ConnectionError('disconnected', 'Connection lost'));
    }
  }

  private schedulePing(gen: number): void {
    this.clearTimer('ping');
    this.pingTimer = setTimeout(() => {
      if (gen !== this.gen || !this.live) return;
      this.request({ t: 'ping' }, { timeoutMs: this.timing.pingTimeoutMs })
        .then(() => {
          if (gen === this.gen) this.schedulePing(gen);
        })
        .catch((err: unknown) => {
          if (gen !== this.gen) return;
          if (err instanceof ConnectionError && err.kind === 'timeout') {
            this.trace({ kind: 'ping-timeout', text: `no answer in ${formatSeconds(this.timing.pingTimeoutMs)}` });
            this.failLive('The computer stopped answering');
          }
        });
    }, this.timing.pingIntervalMs);
  }

  /** A live connection after a network change may be dead: one quick ping tells. */
  private probe(reason: string): void {
    if (!this.live || this.probing) return;
    const gen = this.gen;
    const started = this.opts.deps.now();
    this.probing = true;
    this.request({ t: 'ping' }, { timeoutMs: this.timing.probeTimeoutMs })
      .then(() => {
        if (gen === this.gen) this.trace({ kind: 'probe', ms: this.opts.deps.now() - started, text: `ok (${reason})` });
      })
      .catch((err: unknown) => {
        if (gen !== this.gen) return;
        this.trace({ kind: 'probe', ms: this.opts.deps.now() - started, text: `no answer (${reason})` });
        if (err instanceof ConnectionError && err.kind === 'timeout') this.failLive(`No answer after ${reason}`);
      })
      .finally(() => {
        this.probing = false;
      });
  }

  /** Detaches and closes the live socket, rejecting in-flight requests. */
  private teardownLive(reason: string, code: number): void {
    const a = this.live;
    if (!a) return;
    this.live = null;
    this.gen++;
    this.clearTimer('ping');
    this.closeSocket(a, code, reason);
    const err = new ConnectionError('disconnected', 'Connection lost');
    for (const entry of this.inflight.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.inflight.clear();
    this.info = { ...this.info, lastSeenAt: this.info.lastSeenAt ?? this.opts.deps.now() };
  }

  /** Client-side failure of the live socket (ping timeout, error without close). */
  private failLive(reason: string): void {
    if (!this.live) return;
    this.dropped(reason, 4000);
  }

  private liveClosed(code: number, reason?: string): void {
    if (!this.live) return;
    if (code === CLOSE_PROTOCOL_MISMATCH) {
      this.teardownLive(reason || 'Closed', code);
      this.trace({ kind: 'drop', code, text: reason || 'protocol mismatch' });
      this.enterTerminal('incompatible', 'This computer runs an incompatible phi remote.');
      return;
    }
    if (code === CLOSE_UNAUTHORIZED) {
      const url = this.live.url;
      this.teardownLive(reason || 'Closed', code);
      this.trace({ kind: 'drop', code, text: reason || 'unauthorized' });
      const verifyGen = this.gen;
      this.setInfo({ status: 'connecting', url });
      this.opts.deps
        .fetchInfo(url)
        .catch(() => null)
        .then((info) => {
          if (this.stopped || this.paused || verifyGen !== this.gen || this.live || this.attempts.length) return;
          if (info && info.hubId !== this.hubId) {
            this.dropPreferred(url);
            this.beginOutage();
            this.roundFailed('A different computer answered at this address');
          } else this.enterTerminal('unauthorized', 'This phone was unpaired from the computer.');
        });
      return;
    }
    this.dropped(describeClose(code, reason, true), code, true);
  }

  /** The live connection is gone: a new outage; retry the same url quickly. */
  private dropped(reason: string, code: number, byServer = false): void {
    const liveFor = this.opts.deps.now() - this.liveSince;
    this.teardownLive(reason, byServer ? code : 4000);
    this.trace({ kind: 'drop', ms: liveFor, code: byServer ? code : undefined, text: reason });
    if (this.stopped || this.paused || this.isTerminal()) return;
    this.attempt = 0;
    this.beginOutage();
    this.scheduleRetry(backoffDelay(0, this.opts.deps.random, this.timing, this.timing.backoffFastMaxMs), reason);
  }

  private enterTerminal(status: 'unauthorized' | 'incompatible', message: string, closeCode?: number): void {
    this.abortAttempts();
    if (this.live) this.teardownLive(message, closeCode ?? 1000);
    for (const t of ['retry', 'kick', 'offline'] as const) this.clearTimer(t);
    this.outageStart = null;
    this.trace({ kind: 'terminal', text: message });
    this.setInfo({ status, lastError: message, retryAt: null, since: null });
    this.rejectQueue(new ConnectionError(status, message));
  }

  private rejectQueue(err: Error): void {
    const queued = this.queue;
    this.queue = [];
    for (const entry of queued) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  /** Every url of the round failed: wait (backoff), then the next round. */
  private roundFailed(reason: string): void {
    if (this.stopped || this.paused || this.isTerminal()) return;
    this.clearTimer('stagger');
    const now = this.opts.deps.now();
    if (this.outageStart === null) this.beginOutage();
    const young = now - (this.outageStart ?? now) < this.timing.fastWindowMs;
    const delay = backoffDelay(this.attempt, this.opts.deps.random, this.timing, young ? this.timing.backoffFastMaxMs : this.timing.backoffMaxMs);
    this.attempt += 1;
    this.scheduleRetry(delay, reason);
  }

  private scheduleRetry(delay: number, reason: string): void {
    this.clearTimer('retry');
    const now = this.opts.deps.now();
    this.trace({ kind: 'retry', ms: delay, text: `step ${this.attempt}` });
    this.setInfo({ status: this.statusWhileTrying(), lastError: reason, retryAt: now + delay, since: this.outageStart });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.beginRound('backoff over');
    }, delay);
  }
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function describeClose(code: number, reason: string | undefined, wasLive: boolean): string {
  if (reason && reason.length < 120) return reason;
  if (wasLive) return 'Connection lost';
  if (code === 1006) return "Couldn't reach the computer";
  return `Connection closed (${code})`;
}
