/**
 * RemoteClient: owns one HostConnection per paired hub and is the single writer of the store.
 * Handles sessions (list + upsert/remove), transcript subscriptions (refcounted, resubscribed
 * on reconnect and on `reset`), focus, push registration and app background/foreground.
 */

import type { StoreApi } from 'zustand/vanilla';

import type { ConnTrace, TraceInput } from './conn-trace';
import {
  ConnectionError,
  HostConnection,
  type ConnInfo,
  type ConnectionTiming,
  type SocketLike,
} from './connection';
import {
  applyPage,
  emptyHubHistory,
  liveAsPast,
  PAGE_SIZE,
  queryWords,
  resumeErrorText,
  type HubHistory,
  type PastPage,
  type SearchHub,
} from './history';
import type { HistoryCache } from './history-cache';
import { OVERSEER_FEATURE, type OverseerBoard } from './overseer';
import { shortCwd } from './format';
import { fetchHubInfo, type FetchLike, type PairedHost } from './pairing';
import {
  HISTORY_FEATURE,
  HubError,
  type ClientRequest,
  type CommandInfo,
  type ModelInfo,
  type PromptImage,
  type PromptMode,
  type PushEnv,
  type ServerFrame,
  type ServerFrameOf,
  type SessionSummary,
} from './protocol';
import type { HostStorage, Prefs, StoredHost } from './storage';
import {
  createRemoteStore,
  initialConnInfo,
  transcriptKey,
  type CommandsEntry,
  type HostView,
  type RemoteState,
} from './store';
import { emptyTranscript, transcriptReducer, type TranscriptAction } from './transcript';

export type AppStateLike = {
  currentState: string | null | undefined;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
};

export type PushRegistration = { apnsToken: string; env: PushEnv; bundleId: string };

export type RemoteClientOptions = {
  storage: HostStorage;
  createSocket: (url: string) => SocketLike;
  fetch: FetchLike;
  app: { version: string; build: string };
  deviceName: string;
  appState?: AppStateLike;
  now?: () => number;
  random?: () => number;
  /** How long the app may sit in the background before sockets are closed. */
  backgroundGraceMs?: number;
  timing?: Partial<ConnectionTiming>;
  snapshotLimit?: number;
  historyLimit?: number;
  /** Session history: the phone's copy of the index and recent transcripts (none = memory only). */
  historyCache?: HistoryCache;
  /** `sessions.past` page size. */
  pastPageSize?: number;
  /** The connection log (Settings › Computers › a computer › Connection log). */
  trace?: ConnTrace;
  log?: (message: string, error?: unknown) => void;
};

/** A network path change (expo-network): its type (WIFI, CELLULAR, …) and whether it is usable. */
export type NetworkPath = { type: string; connected: boolean };

export type ModelsResult = Omit<ServerFrameOf<'models'>, 't' | 're'>;

/** `name` (Overseers, v1 addition): the session name; older hubs ignore it. */
export type SpawnRequest = { cwd: string; prompt?: string; provider?: string; modelId?: string; thinkingLevel?: string; name?: string };

/**
 * Session history: resume a stored session. Model and level go out only when the user chose them
 * (otherwise the session keeps its own). Photos are sent as a prompt once it is live.
 */
export type ResumeRequest = {
  prompt?: string;
  images?: PromptImage[];
  model?: { provider: string; id: string };
  thinkingLevel?: string;
};

/** The quiet line after a resume whose recorded folder was gone (the hub ran it in `cwd`). */
export function resumeFallbackNote(recorded: string | undefined, cwd: string): string {
  return recorded ? `Folder ${shortCwd(recorded)} is gone; resumed in ${shortCwd(cwd)}.` : `Its folder is gone; resumed in ${shortCwd(cwd)}.`;
}

/** A failed resume, worded for the person (folder gone, offline, refused …). */
export class ResumeError extends Error {
  readonly code: string | null;
  constructor(code: string | null, message: string) {
    super(message);
    this.name = 'ResumeError';
    this.code = code;
  }
}

/** Friendly message for anything a client call can throw. */
export function describeError(err: unknown): string {
  if (err instanceof HubError) {
    switch (err.code) {
      case 'not_found':
        return 'That session is no longer running.';
      case 'session_offline':
        return 'That session is not connected to phi remote right now.';
      case 'forbidden':
        return err.message || 'Not allowed.';
      default:
        return err.message || 'The computer reported an error.';
    }
  }
  if (err instanceof ConnectionError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong.';
}

type Sub = { hubId: string; sessionId: string; refs: number };

/** Bookkeeping behind `state.commands` (one per session whose commands were asked for). */
type CommandsMeta = {
  hubId: string;
  sessionId: string;
  /** SessionSummary.commandsVersion when the list was requested. */
  version: number | string | undefined;
  inflight: boolean;
  /** Needs a refetch (reset, version change, reconnect). */
  stale: boolean;
  /** Last fetch failed: do not ask again before this time (Infinity: hub lacks commands.list). */
  retryAt: number;
};

const SPAWN_TIMEOUT_MS = 35_000;
/** After a spawn ack: how long to wait for the new session's summary before giving up on it. */
const SPAWN_SUMMARY_WAIT_MS = 5_000;
const COMMANDS_TIMEOUT_MS = 10_000;
const BOARD_TIMEOUT_MS = 10_000;
const COMMANDS_RETRY_MS = 15_000;
/** The hub acks a resume after the child registers (30 s + grace, like spawn). */
const RESUME_TIMEOUT_MS = 40_000;
const SEARCH_DEBOUNCE_MS = 300;
const INDEX_SAVE_DELAY_MS = 1_500;
/** While a computer reports `indexing`, ask again this often (a few times). */
const INDEXING_RETRY_MS = 3_000;
const INDEXING_RETRIES = 10;
/** Pages fetched in a row when a page brings nothing older (a cached tail was re-listed). */
const MAX_EMPTY_PAGES = 8;

export class RemoteClient {
  readonly store: StoreApi<RemoteState>;
  private readonly opts: RemoteClientOptions;
  private readonly now: () => number;
  private readonly random: () => number;

  private readonly records = new Map<string, StoredHost>();
  private readonly conns = new Map<string, HostConnection>();
  private readonly subs = new Map<string, Sub>();
  private readonly focusSent = new Map<string, string | null>();
  private readonly commandsMeta = new Map<string, CommandsMeta>();
  private focus: { hubId: string; sessionId: string } | null = null;
  private push: PushRegistration | null = null;
  private appActive: boolean;
  private backgroundedAt: number | null = null;
  private bgTimer: ReturnType<typeof setTimeout> | null = null;
  private appStateSub: { remove(): void } | null = null;
  private initPromise: Promise<void> | null = null;
  private disposed = false;
  /** Live subscribes in flight per key (a stored thread being promoted must not subscribe twice). */
  private readonly subscribing = new Map<string, number>();
  private indexSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly indexingRetries = new Map<string, number>();
  private readonly indexingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** transcriptKey → the resume in flight (a second resume joins it, like the hub does). */
  private readonly resumes = new Map<string, Promise<string>>();

  constructor(opts: RemoteClientOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.store = createRemoteStore();
    // 'unknown' / 'inactive' at launch count as foreground; only 'background' does not.
    this.appActive = opts.appState?.currentState !== 'background';
    if (opts.appState) {
      this.appStateSub = opts.appState.addEventListener('change', (s) => this.handleAppState(s));
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Loads paired hosts and starts connecting. Safe to call more than once. */
  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const started = this.now();
    const trace = this.opts.trace;
    const traceLoaded = trace ? trace.load().catch((err) => this.log('Could not read the connection log', err)) : Promise.resolve();
    let hosts: StoredHost[] = [];
    let prefs: Prefs = {};
    let history: Record<string, HubHistory> = {};
    const cached = this.opts.historyCache
      ? this.opts.historyCache.load().catch((err) => {
          this.log('Could not read the session history cache', err);
          return {} as Record<string, HubHistory>;
        })
      : Promise.resolve({} as Record<string, HubHistory>);
    try {
      [hosts, prefs, history] = await Promise.all([this.opts.storage.loadAll(), this.opts.storage.loadPrefs(), cached]);
    } catch (err) {
      this.log('Could not load paired computers', err);
    }
    if (this.disposed) return;
    for (const h of hosts) this.records.set(h.hubId, h);
    const paired = new Set(hosts.map((h) => h.hubId));
    this.store.setState({
      ready: true,
      prefs,
      hostOrder: hosts.map((h) => h.hubId),
      hosts: Object.fromEntries(hosts.map((h) => [h.hubId, toHostView(h)])),
      history: Object.fromEntries(Object.entries(history).filter(([hubId]) => paired.has(hubId))),
      historyReady: true,
    });
    this.traceAll({
      kind: 'launch',
      text: `phi ${this.opts.app.version} (${this.opts.app.build}) · ${hosts.length} computer${hosts.length === 1 ? '' : 's'} and ${Object.keys(history).length ? 'the history cache' : 'no history cache'} read in ${this.now() - started} ms${this.appActive ? '' : ' · in the background'}`,
    });
    for (const h of hosts) this.startConnection(h);
    void traceLoaded.then(() => trace?.retain(this.records.keys()));
  }

  private trace(hubId: string, e: TraceInput): void {
    this.opts.trace?.record(hubId, e);
  }

  /** One event in every paired computer's connection log. */
  private traceAll(e: TraceInput): void {
    this.opts.trace?.recordAll(this.records.keys(), e);
  }

  /**
   * The network path changed (expo-network). Usable again: every computer that is not live
   * retries at once (backoff reset; attempts that began on the old path start over), and live
   * ones are checked with a ping. `initial` is the path at launch (logged only).
   */
  networkChanged(path: NetworkPath, initial = false): void {
    const type = path.type.toLowerCase();
    this.traceAll({ kind: 'network', text: `${type}${path.connected ? '' : ' · no connection'}${initial ? ' · at launch' : ''}` });
    if (initial || !path.connected || !this.appActive) return;
    for (const conn of this.conns.values()) {
      conn.reconnect(`network changed (${type})`, { fresh: true, restartOlderThanMs: 250, probe: true });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.appStateSub?.remove();
    this.appStateSub = null;
    if (this.bgTimer) clearTimeout(this.bgTimer);
    if (this.indexSaveTimer) clearTimeout(this.indexSaveTimer);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    for (const t of this.indexingTimers.values()) clearTimeout(t);
    this.indexingTimers.clear();
    for (const c of this.conns.values()) c.stop();
    this.conns.clear();
  }

  // -------------------------------------------------------------------------
  // Hosts
  // -------------------------------------------------------------------------

  getHostRecord(hubId: string): StoredHost | undefined {
    return this.records.get(hubId);
  }

  /** Adds (or re-pairs) a host and connects to it. */
  async addHost(paired: PairedHost): Promise<void> {
    await this.init();
    const record: StoredHost = { ...paired };
    await this.opts.storage.save(record);
    const old = this.conns.get(paired.hubId);
    if (old) {
      old.stop();
      this.conns.delete(paired.hubId);
      this.focusSent.delete(paired.hubId);
    }
    this.records.set(paired.hubId, record);
    this.store.setState((s) => ({
      hostOrder: s.hostOrder.includes(paired.hubId) ? s.hostOrder : [...s.hostOrder, paired.hubId],
      hosts: { ...s.hosts, [paired.hubId]: toHostView(record) },
    }));
    this.startConnection(record);
  }

  /** Forgets a host: stops pushes from it (best effort), disconnects, deletes its token. */
  async removeHost(hubId: string): Promise<void> {
    const conn = this.conns.get(hubId);
    if (conn) {
      if (conn.status === 'live') {
        await conn.request({ t: 'push.unregister' }, { timeoutMs: 3000 }).catch(() => undefined);
      }
      conn.stop();
      this.conns.delete(hubId);
    }
    this.opts.trace?.removeHub(hubId);
    this.records.delete(hubId);
    this.focusSent.delete(hubId);
    for (const [key, sub] of this.subs) if (sub.hubId === hubId) this.subs.delete(key);
    for (const [key, meta] of this.commandsMeta) if (meta.hubId === hubId) this.commandsMeta.delete(key);
    this.store.setState((s) => {
      const hosts = { ...s.hosts };
      delete hosts[hubId];
      const sessions = { ...s.sessions };
      delete sessions[hubId];
      const sessionsLoaded = { ...s.sessionsLoaded };
      delete sessionsLoaded[hubId];
      const prefix = transcriptKey(hubId, '');
      const keep = <T>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([k]) => !k.startsWith(prefix)));
      const history = { ...s.history };
      delete history[hubId];
      let search = s.search;
      if (search && hubId in search.hubs) {
        const hubs = { ...search.hubs };
        delete hubs[hubId];
        search = { ...search, hubs };
      }
      return {
        hostOrder: s.hostOrder.filter((id) => id !== hubId),
        hosts,
        sessions,
        sessionsLoaded,
        transcripts: keep(s.transcripts),
        commands: keep(s.commands),
        replacements: keep(s.replacements),
        resuming: keep(s.resuming),
        history,
        search,
      };
    });
    this.scheduleIndexSave(0);
    await this.opts.historyCache?.removeHub(hubId).catch((err) => this.log('Could not clear cached transcripts', err));
    await this.opts.storage.remove(hubId);
  }

  /** Pull-to-refresh: reload sessions on live hosts, reconnect the rest now. */
  async refresh(): Promise<void> {
    const work: Promise<unknown>[] = [];
    for (const [hubId, conn] of this.conns) {
      if (conn.status === 'live') {
        work.push(this.loadSessions(hubId));
        if (this.hasHistory(hubId)) work.push(this.refreshPast(hubId));
      } else if (conn.status === 'paused') conn.resume();
      else conn.reconnect('pull to refresh', { fresh: true, restartOlderThanMs: 1_000 });
    }
    await Promise.allSettled(work);
  }

  /** Settings › Computers › Reconnect: a fresh attempt now, whatever is in flight. */
  retryHost(hubId: string): void {
    const conn = this.conns.get(hubId);
    if (!conn) return;
    if (conn.status === 'paused') conn.resume();
    else conn.reconnect('Reconnect tapped', { fresh: true, restartOlderThanMs: 0 });
  }

  private startConnection(record: StoredHost): void {
    const hubId = record.hubId;
    const conn = new HostConnection({
      hubId,
      token: record.token,
      urls: record.urls,
      preferredUrl: record.preferredUrl,
      app: this.opts.app,
      deviceName: this.opts.deviceName,
      timing: this.opts.timing,
      deps: {
        createSocket: this.opts.createSocket,
        fetchInfo: (url) => fetchHubInfo(this.opts.fetch, url),
        now: this.now,
        random: this.random,
      },
      onFrame: (frame) => {
        if (this.conns.get(hubId) === conn) this.handleFrame(hubId, frame);
      },
      onInfo: (info) => {
        if (this.conns.get(hubId) === conn) this.handleInfo(hubId, info);
      },
      onLive: (welcome, url) => {
        if (this.conns.get(hubId) === conn) this.handleLive(hubId, welcome, url);
      },
      onTrace: (e) => {
        if (this.conns.get(hubId) === conn) this.trace(hubId, e);
      },
    });
    this.conns.set(hubId, conn);
    if (this.appActive) conn.start();
    else conn.pause();
  }

  private patchHost(hubId: string, patch: Partial<HostView>): void {
    this.store.setState((s) => {
      const host = s.hosts[hubId];
      if (!host) return s;
      return { hosts: { ...s.hosts, [hubId]: { ...host, ...patch } } };
    });
  }

  private handleInfo(hubId: string, info: ConnInfo): void {
    if (info.status !== 'live') this.focusSent.delete(hubId);
    const record = this.records.get(hubId);
    const lastSeenAt = info.lastSeenAt ?? record?.lastSeenAt ?? null;
    this.patchHost(hubId, { conn: info, lastSeenAt });
    // Persist "last seen" when a live connection ends, at most once a minute.
    if (record && info.status !== 'live' && info.lastSeenAt && info.lastSeenAt - (record.lastSeenAt ?? 0) > 60_000) {
      record.lastSeenAt = info.lastSeenAt;
      this.opts.storage.save(record).catch((err) => this.log('Could not save host', err));
    }
  }

  private handleLive(hubId: string, welcome: ServerFrameOf<'welcome'>, url: string): void {
    // One computer answering means the phone's network path works again: the others retry now
    // instead of waiting out their backoff (an attempt that began before stays if still young).
    for (const [id, other] of this.conns) {
      if (id !== hubId && other.status !== 'live') {
        other.reconnect(`${welcome.host.name || this.hostName(hubId)} connected`, { restartOlderThanMs: 2_000 });
      }
    }
    const record = this.records.get(hubId);
    if (record) {
      const name = welcome.host.name || record.name;
      if (name !== record.name || url !== record.preferredUrl) {
        record.name = name;
        record.preferredUrl = url;
        this.opts.storage.save(record).catch((err) => this.log('Could not save host', err));
        this.patchHost(hubId, { name, preferredUrl: url });
      }
    }
    const features = welcome.host.features;
    this.patchHost(hubId, { features });
    const supported = features.includes(HISTORY_FEATURE);
    this.patchHistory(hubId, (h) => (h.support === (supported ? 'history' : 'legacy') ? h : { ...h, support: supported ? 'history' : 'legacy' }));
    const listed = this.loadSessions(hubId);
    if (supported) void this.refreshPast(hubId);
    for (const sub of this.subs.values()) {
      if (sub.hubId !== hubId) continue;
      const key = transcriptKey(hubId, sub.sessionId);
      if (!supported || this.store.getState().transcripts[key]?.source === 'live') {
        void this.doSubscribe(sub.hubId, sub.sessionId);
        continue;
      }
      // A stored (or cached) thread: once the list is in, follow it live if it runs, else read it.
      void listed.then(() => {
        if (!this.subs.has(key) || this.subscribing.has(key)) return;
        if (this.store.getState().transcripts[key]?.source === 'live') return;
        void this.doSubscribe(sub.hubId, sub.sessionId);
      });
    }
    // The hub may have restarted (or been upgraded) while we were away: ask again on the next '/'.
    for (const meta of this.commandsMeta.values()) {
      if (meta.hubId !== hubId) continue;
      meta.stale = true;
      meta.retryAt = 0;
    }
    this.syncFocus();
    const conn = this.conns.get(hubId);
    if (!conn) return;
    if (this.push) {
      conn.request({ t: 'push.register', ...this.push }).catch((err) => this.log('push.register failed', err));
    } else if (this.store.getState().prefs.notifications === 'off') {
      conn.request({ t: 'push.unregister' }).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  private async loadSessions(hubId: string): Promise<void> {
    const conn = this.conns.get(hubId);
    if (!conn) return;
    try {
      const reply = await conn.request({ t: 'sessions.list' });
      this.applySessions(hubId, reply.sessions);
    } catch (err) {
      this.log('sessions.list failed', err);
    }
  }

  private applySessions(hubId: string, list: SessionSummary[]): void {
    if (!this.records.has(hubId)) return;
    this.store.setState((s) => ({
      sessions: { ...s.sessions, [hubId]: Object.fromEntries(list.map((x) => [x.sessionId, x])) },
      sessionsLoaded: { ...s.sessionsLoaded, [hubId]: true },
    }));
    for (const summary of list) {
      this.checkCommandsVersion(hubId, summary);
      this.promoteToLive(hubId, summary.sessionId);
    }
  }

  private handleFrame(hubId: string, frame: ServerFrame): void {
    switch (frame.t) {
      case 'session.upsert':
        this.store.setState((s) => ({
          sessions: { ...s.sessions, [hubId]: { ...s.sessions[hubId], [frame.session.sessionId]: frame.session } },
        }));
        this.checkCommandsVersion(hubId, frame.session);
        // A stored session on screen became live (resumed here or elsewhere): follow it live.
        this.promoteToLive(hubId, frame.session.sessionId);
        return;
      case 'session.remove':
        if (frame.replacedBy) {
          // /new, /resume, /fork …: the conversation goes on under a new id; open threads follow it.
          this.replaceSession(hubId, frame.sessionId, frame.replacedBy);
          this.deleteSession(hubId, frame.sessionId);
        } else {
          this.endSession(hubId, frame.sessionId);
        }
        return;
      case 'session.event': {
        const key = transcriptKey(hubId, frame.sessionId);
        const subscribed = this.subs.has(key);
        if (!subscribed && !(key in this.store.getState().transcripts)) return;
        const ev = frame.event;
        if (ev.type === 'item.upsert') this.reduce(key, { type: 'upsert', item: ev.item });
        else if (ev.type === 'state') this.reduce(key, { type: 'state', state: ev.state });
        else if (ev.type === 'reset') {
          if (ev.replacedBy && ev.replacedBy !== frame.sessionId) {
            // Keep the old transcript on screen until the thread moves to the new id.
            this.replaceSession(hubId, frame.sessionId, ev.replacedBy);
            return;
          }
          this.reduce(key, { type: 'reset' });
          if (subscribed) void this.doSubscribe(hubId, frame.sessionId);
          this.invalidateCommands(key);
        }
        return;
      }
      // Replies that arrived after their request timed out.
      case 'sessions':
        this.applySessions(hubId, frame.sessions);
        return;
      case 'session.snapshot': {
        const key = transcriptKey(hubId, frame.sessionId);
        if (this.subs.has(key)) {
          this.reduce(key, { type: 'snapshot', items: frame.items, hasMore: frame.hasMore, state: frame.state });
        }
        return;
      }
      case 'sessions.past':
      case 'session.transcript':
        // Late replies: the request already gave up; the next refresh asks again.
        return;
      case 'session.history': {
        const key = transcriptKey(hubId, frame.sessionId);
        if (this.subs.has(key)) this.reduce(key, { type: 'history', items: frame.items, hasMore: frame.hasMore });
        return;
      }
      case 'error':
        this.log(`hub error: ${frame.code} ${frame.message}`);
        return;
      default:
        return;
    }
  }

  private deleteSession(hubId: string, sessionId: string): void {
    this.store.setState((s) => {
      const forHost = s.sessions[hubId];
      if (!forHost || !(sessionId in forHost)) return s;
      const next = { ...forHost };
      delete next[sessionId];
      return { sessions: { ...s.sessions, [hubId]: next } };
    });
  }

  /**
   * A session is gone: an open thread shows it ended (its transcript stays readable), and its
   * subagents go with it (the hub removes them too; this keeps the app right if it does not).
   */
  private endSession(hubId: string, sessionId: string): void {
    const key = transcriptKey(hubId, sessionId);
    // The hub drops subscriptions to a removed session. A computer with history keeps it: the
    // open thread stays readable as a stored session (and can be resumed).
    const summary = this.store.getState().sessions[hubId]?.[sessionId];
    if (this.hasHistory(hubId) && summary && summary.kind !== 'subagent') {
      this.rememberPast(hubId, { ...liveAsPast(summary), live: false });
      if (this.subs.has(key)) {
        this.reduce(key, { type: 'detach' });
        this.saveTranscript(hubId, sessionId);
      }
    } else if (this.subs.has(key)) this.reduce(key, { type: 'error', message: 'This thread has ended.' });
    this.dropCommands(key);
    this.deleteSession(hubId, sessionId);
    this.dropSubagentsOf(hubId, sessionId);
  }

  /** Subagents (v1 addition): a parent that ended or was replaced takes its subagents along. */
  private dropSubagentsOf(hubId: string, parentId: string): void {
    const forHost = this.store.getState().sessions[hubId] ?? {};
    for (const s of Object.values(forHost)) if (s.kind === 'subagent' && s.parentSessionId === parentId) this.endSession(hubId, s.sessionId);
  }

  // -------------------------------------------------------------------------
  // Transcripts
  // -------------------------------------------------------------------------

  private reduce(key: string, action: TranscriptAction): void {
    this.store.setState((s) => {
      const prev = s.transcripts[key] ?? emptyTranscript;
      const next = transcriptReducer(prev, action);
      return next === prev ? s : { transcripts: { ...s.transcripts, [key]: next } };
    });
  }

  /** Subscribes to a session's transcript; returns the release function. Refcounted. */
  subscribe(hubId: string, sessionId: string): () => void {
    const key = transcriptKey(hubId, sessionId);
    let sub = this.subs.get(key);
    if (!sub) {
      sub = { hubId, sessionId, refs: 0 };
      this.subs.set(key, sub);
    }
    sub.refs += 1;
    if (sub.refs === 1) void this.openTranscript(hubId, sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.subs.get(key);
      if (!current) return;
      current.refs -= 1;
      if (current.refs <= 0) {
        this.subs.delete(key);
        this.conns.get(hubId)?.notify({ t: 'session.unsubscribe', sessionId });
        this.saveTranscript(hubId, sessionId);
      }
    };
  }

  /** Shows the phone's copy first (if any), then asks the computer. */
  private async openTranscript(hubId: string, sessionId: string): Promise<void> {
    const key = transcriptKey(hubId, sessionId);
    const cache = this.opts.historyCache;
    const current = this.store.getState().transcripts[key];
    if (cache && (!current || current.order.length === 0)) {
      const copy = await cache.loadTranscript(hubId, sessionId).catch(() => null);
      if (copy && this.subs.has(key)) this.reduce(key, { type: 'cached', items: copy.items, hasMore: copy.hasMore });
    }
    if (this.subs.has(key)) await this.doSubscribe(hubId, sessionId);
  }

  private async doSubscribe(hubId: string, sessionId: string): Promise<void> {
    const key = transcriptKey(hubId, sessionId);
    const conn = this.conns.get(hubId);
    if (!conn) return;
    this.reduce(key, { type: 'loading' });
    if (conn.status !== 'live') return; // resubscribed from handleLive
    const state = this.store.getState();
    // Session history: a session the computer keeps but does not run is read, not subscribed.
    if (this.hasHistory(hubId) && state.sessionsLoaded[hubId] && !state.sessions[hubId]?.[sessionId]) {
      await this.loadStored(hubId, sessionId);
      return;
    }
    this.subscribing.set(key, (this.subscribing.get(key) ?? 0) + 1);
    let counted = true;
    const uncount = () => {
      if (!counted) return;
      counted = false;
      const n = (this.subscribing.get(key) ?? 1) - 1;
      if (n > 0) this.subscribing.set(key, n);
      else this.subscribing.delete(key);
    };
    try {
      const reply = await conn.request({ t: 'session.subscribe', sessionId, limit: this.opts.snapshotLimit ?? 120 });
      if (!this.subs.has(key)) {
        conn.notify({ t: 'session.unsubscribe', sessionId });
        return;
      }
      this.reduce(key, { type: 'snapshot', items: reply.items, hasMore: reply.hasMore, state: reply.state });
      this.saveTranscript(hubId, sessionId);
    } catch (err) {
      if (err instanceof HubError && err.code === 'not_found' && this.hasHistory(hubId) && this.subs.has(key)) {
        // Not running (any more): read what the computer stored.
        uncount();
        await this.loadStored(hubId, sessionId);
        return;
      }
      if (err instanceof HubError) this.reduce(key, { type: 'error', message: describeError(err) });
      else if (err instanceof ConnectionError && err.kind === 'timeout' && this.subs.has(key)) {
        this.reduce(key, { type: 'error', message: 'The computer did not send this session in time.' });
      }
      // Disconnects are retried by handleLive on reconnect.
    } finally {
      uncount();
    }
  }

  /** Session history: the newest page of a stored session (`session.transcript`). */
  private async loadStored(hubId: string, sessionId: string): Promise<void> {
    const key = transcriptKey(hubId, sessionId);
    const conn = this.conns.get(hubId);
    if (!conn || conn.status !== 'live') return;
    try {
      const reply = await conn.request({ t: 'session.transcript', sessionId, limit: this.opts.snapshotLimit ?? 120 });
      if (!this.subs.has(key)) return;
      // It went live while we read it: the live subscription wins.
      if (this.store.getState().transcripts[key]?.source === 'live') return;
      this.reduce(key, { type: 'stored', items: reply.items, hasMore: reply.hasMore });
      this.saveTranscript(hubId, sessionId);
    } catch (err) {
      if (!this.subs.has(key)) return;
      const host = this.hostName(hubId);
      if (err instanceof HubError) {
        this.reduce(key, { type: 'error', message: err.code === 'not_found' ? `${host} no longer has this session.` : describeError(err) });
      } else if (err instanceof ConnectionError && err.kind === 'timeout') {
        this.reduce(key, { type: 'error', message: `${host} did not send this session in time.` });
      }
    }
  }

  /** An open stored (or cached) thread whose session is now live switches to the live stream. */
  private promoteToLive(hubId: string, sessionId: string): void {
    const key = transcriptKey(hubId, sessionId);
    if (!this.subs.has(key) || this.subscribing.has(key)) return;
    const t = this.store.getState().transcripts[key];
    if (t?.source === 'live' && t.phase !== 'error') return;
    if (this.conns.get(hubId)?.status !== 'live') return;
    void this.doSubscribe(hubId, sessionId);
  }

  /** Retries a failed subscribe (e.g. after an error message is shown). */
  resubscribe(hubId: string, sessionId: string): void {
    if (this.subs.has(transcriptKey(hubId, sessionId))) void this.doSubscribe(hubId, sessionId);
  }

  /** Loads the page of items before the oldest one shown. */
  async loadOlder(hubId: string, sessionId: string): Promise<void> {
    const key = transcriptKey(hubId, sessionId);
    const t = this.store.getState().transcripts[key];
    const conn = this.conns.get(hubId);
    if (!t || !conn || !t.hasMore || t.loadingOlder || t.order.length === 0 || conn.status !== 'live') return;
    // The phone's copy pages once the computer has answered (the ids are then confirmed).
    if (t.source === 'cache') return;
    this.reduce(key, { type: 'loadingOlder', value: true });
    try {
      const limit = this.opts.historyLimit ?? 80;
      const reply =
        t.source === 'stored'
          ? await conn.request({ t: 'session.transcript', sessionId, before: t.order[0], limit })
          : await conn.request({ t: 'session.history', sessionId, before: t.order[0], limit });
      this.reduce(key, { type: 'history', items: reply.items, hasMore: reply.hasMore });
    } catch (err) {
      this.log('session.history failed', err);
      this.reduce(key, { type: 'loadingOlder', value: false });
    }
  }

  /**
   * `oldId` continues as `newId`: remember it (open threads navigate there), stop following the
   * old id, and seed the new id's slash commands with the old list (same machine) until a
   * refetch.
   */
  private replaceSession(hubId: string, oldId: string, newId: string): void {
    const oldKey = transcriptKey(hubId, oldId);
    const newKey = transcriptKey(hubId, newId);
    const sub = this.subs.get(oldKey);
    if (sub) {
      this.subs.delete(oldKey);
      this.conns.get(hubId)?.notify({ t: 'session.unsubscribe', sessionId: oldId });
    }
    const meta = this.commandsMeta.get(oldKey);
    this.commandsMeta.delete(oldKey);
    if (meta && !this.commandsMeta.has(newKey)) {
      this.commandsMeta.set(newKey, { ...meta, sessionId: newId, inflight: false, stale: true, retryAt: 0 });
    }
    this.store.setState((s) => {
      const commands = { ...s.commands };
      const carried = commands[oldKey];
      delete commands[oldKey];
      if (carried?.status === 'ready' && !commands[newKey]) commands[newKey] = carried;
      const forHost = s.sessions[hubId];
      let sessions = s.sessions;
      if (forHost && oldId in forHost) {
        const next = { ...forHost };
        delete next[oldId];
        sessions = { ...s.sessions, [hubId]: next };
      }
      return { sessions, commands, replacements: { ...s.replacements, [oldKey]: newId } };
    });
    this.dropSubagentsOf(hubId, oldId);
  }

  // -------------------------------------------------------------------------
  // Session history (protocol "Session history (v1 addition)")
  // -------------------------------------------------------------------------

  /** The computer advertises `history` on its current connection. */
  hasHistory(hubId: string): boolean {
    return !!this.store.getState().hosts[hubId]?.features?.includes(HISTORY_FEATURE);
  }

  private hostName(hubId: string): string {
    return this.store.getState().hosts[hubId]?.name ?? 'The computer';
  }

  private patchHistory(hubId: string, fn: (h: HubHistory) => HubHistory): void {
    if (!this.records.has(hubId)) return;
    this.store.setState((s) => {
      const prev = s.history[hubId] ?? emptyHubHistory;
      const next = fn(prev);
      return next === prev ? s : { history: { ...s.history, [hubId]: next } };
    });
    this.scheduleIndexSave();
  }

  /** Keeps a session's facts (opened from search, or a live one that ended) without listing it. */
  private rememberPast(hubId: string, past: PastPage['sessions'][number]): void {
    this.patchHistory(hubId, (h) => {
      const known = h.byId[past.sessionId];
      if (known && known.modifiedAt >= past.modifiedAt) return h;
      return { ...h, byId: { ...h.byId, [past.sessionId]: known ? { ...known, modifiedAt: past.modifiedAt, preview: past.preview ?? known.preview } : past } };
    });
  }

  private requestPast(hubId: string, frame: { cursor?: string; query?: string }): Promise<PastPage> {
    const conn = this.conns.get(hubId);
    if (!conn || conn.status !== 'live') return Promise.reject(new ConnectionError('disconnected', 'Not connected'));
    const req: Extract<ClientRequest, { t: 'sessions.past' }> = { t: 'sessions.past', limit: this.opts.pastPageSize ?? PAGE_SIZE };
    if (frame.cursor) req.cursor = frame.cursor;
    if (frame.query) req.query = frame.query.slice(0, 200);
    return conn.request(req);
  }

  /** Reloads a computer's newest page of stored sessions (on connect and pull-to-refresh). */
  async refreshPast(hubId: string): Promise<void> {
    if (!this.hasHistory(hubId)) return;
    const h = this.store.getState().history[hubId];
    if (h?.loading) return;
    this.patchHistory(hubId, (prev) => ({ ...prev, loading: true, error: null }));
    try {
      const page = await this.requestPast(hubId, {});
      this.patchHistory(hubId, (prev) => applyPage(prev, page, 'refresh'));
      this.retryWhileIndexing(hubId, page.indexing === true);
    } catch (err) {
      this.log('sessions.past failed', err);
      this.patchHistory(hubId, (prev) => ({ ...prev, loading: false, error: describeError(err) }));
    }
  }

  /** A computer still building its index answered with what it had: ask again a few times. */
  private retryWhileIndexing(hubId: string, indexing: boolean): void {
    const timer = this.indexingTimers.get(hubId);
    if (timer) clearTimeout(timer);
    this.indexingTimers.delete(hubId);
    if (!indexing) {
      this.indexingRetries.delete(hubId);
      return;
    }
    const n = (this.indexingRetries.get(hubId) ?? 0) + 1;
    if (n > INDEXING_RETRIES) return;
    this.indexingRetries.set(hubId, n);
    this.indexingTimers.set(
      hubId,
      setTimeout(() => {
        this.indexingTimers.delete(hubId);
        if (!this.disposed) void this.refreshPast(hubId);
      }, INDEXING_RETRY_MS),
    );
  }

  /** The next page from each of these computers (the merged list reached its end). */
  async loadMorePast(hubIds: string[]): Promise<void> {
    await Promise.allSettled(hubIds.map((hubId) => this.loadMoreFrom(hubId)));
  }

  private async loadMoreFrom(hubId: string): Promise<void> {
    for (let i = 0; i < MAX_EMPTY_PAGES; i++) {
      const h = this.store.getState().history[hubId];
      if (!h || h.loading || typeof h.nextCursor !== 'string') return;
      const oldest = h.order.length ? h.byId[h.order[h.order.length - 1]]?.modifiedAt : undefined;
      this.patchHistory(hubId, (prev) => ({ ...prev, loading: true, error: null }));
      let page: PastPage;
      try {
        page = await this.requestPast(hubId, { cursor: h.nextCursor });
      } catch (err) {
        this.log('sessions.past (more) failed', err);
        // A cursor the computer no longer understands (it restarted): start over from the top.
        const stale = err instanceof HubError && (err.code === 'bad_request' || err.code === 'not_found');
        this.patchHistory(hubId, (prev) => ({ ...prev, loading: false, ...(stale ? { nextCursor: undefined } : { error: describeError(err) }) }));
        if (stale) await this.refreshPast(hubId);
        return;
      }
      this.patchHistory(hubId, (prev) => applyPage(prev, page, 'more'));
      const after = this.store.getState().history[hubId];
      const newOldest = after?.order.length ? after.byId[after.order[after.order.length - 1]]?.modifiedAt : undefined;
      // Something older arrived (or the end): the list moves on. Otherwise the page re-listed
      // the cached tail; keep going.
      if (oldest === undefined || newOldest === undefined || newOldest < oldest || typeof after?.nextCursor !== 'string') return;
    }
  }

  /**
   * Searches every connected computer with history (debounced). The list filters the phone's
   * copy at once; each computer's matches (all of its sessions, message text too) merge in.
   */
  search(query: string): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    const q = query.trim();
    if (!queryWords(q).length) {
      if (this.store.getState().search) this.store.setState({ search: null });
      return;
    }
    const current = this.store.getState().search;
    if (current?.query === q) return;
    this.store.setState({ search: { query: q, hubs: {} } });
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      for (const hubId of this.store.getState().hostOrder) if (this.hasHistory(hubId)) void this.searchHub(hubId, q);
    }, SEARCH_DEBOUNCE_MS);
  }

  /** More search matches from these computers. */
  async loadMoreSearch(hubIds: string[]): Promise<void> {
    const search = this.store.getState().search;
    if (!search) return;
    await Promise.allSettled(
      hubIds.map((hubId) => {
        const hit = search.hubs[hubId];
        return hit && !hit.loading && typeof hit.nextCursor === 'string' ? this.searchHub(hubId, search.query, hit.nextCursor) : undefined;
      }),
    );
  }

  private patchSearch(hubId: string, query: string, fn: (hit: SearchHub) => SearchHub): void {
    this.store.setState((s) => {
      if (!s.search || s.search.query !== query) return s;
      const prev = s.search.hubs[hubId] ?? { ids: [], nextCursor: undefined, loading: false, error: null };
      return { search: { ...s.search, hubs: { ...s.search.hubs, [hubId]: fn(prev) } } };
    });
  }

  private async searchHub(hubId: string, query: string, cursor?: string): Promise<void> {
    this.patchSearch(hubId, query, (hit) => ({ ...hit, loading: true, error: null }));
    try {
      const page = await this.requestPast(hubId, { query, cursor });
      // Facts only: search hits are not part of the browse index.
      this.patchHistory(hubId, (h) => {
        const byId = { ...h.byId };
        for (const s of page.sessions) byId[s.sessionId] = s;
        return { ...h, byId };
      });
      this.patchSearch(hubId, query, (hit) => ({
        ids: [...new Set([...(cursor ? hit.ids : []), ...page.sessions.map((s) => s.sessionId)])],
        nextCursor: page.nextCursor ?? null,
        loading: false,
        error: null,
      }));
    } catch (err) {
      this.log('sessions.past (search) failed', err);
      this.patchSearch(hubId, query, (hit) => ({ ...hit, loading: false, error: describeError(err) }));
    }
  }

  /**
   * Makes a stored session live again (same id, same file, full context) and, with a prompt,
   * continues it. Resolves with the live session id once the computer has it registered; the
   * open thread switches from the stored transcript to the live one in place.
   */
  async resume(hubId: string, sessionId: string, req: ResumeRequest = {}): Promise<string> {
    const key = transcriptKey(hubId, sessionId);
    const host = this.hostName(hubId);
    const conn = this.conns.get(hubId);
    if (!conn) throw new ResumeError(null, 'That computer is not paired.');
    if (conn.status !== 'live') throw new ResumeError('offline', `${host} is offline.`);
    if (!this.hasHistory(hubId)) throw new ResumeError('legacy', `Update phi on ${host} to resume sessions.`);
    const pending = this.resumes.get(key);
    if (pending) {
      // Joins the resume in flight; a message goes to the session once it is live.
      const liveId = await pending;
      if (req.prompt?.trim() || req.images?.length) await this.prompt(hubId, liveId, req.prompt?.trim() ?? '', req.images ?? []);
      return liveId;
    }
    const run = this.runResume(hubId, sessionId, req);
    this.resumes.set(key, run);
    try {
      return await run;
    } finally {
      this.resumes.delete(key);
    }
  }

  private async runResume(hubId: string, sessionId: string, req: ResumeRequest): Promise<string> {
    const key = transcriptKey(hubId, sessionId);
    const host = this.hostName(hubId);
    const conn = this.conns.get(hubId);
    if (!conn) throw new ResumeError(null, 'That computer is not paired.');
    const frame: Extract<ClientRequest, { t: 'session.resume' }> = { t: 'session.resume', sessionId };
    const text = req.prompt?.trim();
    const images = req.images?.length ? req.images : undefined;
    if (text && !images) frame.prompt = text;
    if (req.model) {
      frame.provider = req.model.provider;
      frame.modelId = req.model.id;
    }
    if (req.thinkingLevel) frame.thinkingLevel = req.thinkingLevel;
    this.store.setState((s) => ({ resuming: { ...s.resuming, [key]: { since: this.now() } } }));
    try {
      let ack: ServerFrameOf<'ack'>;
      try {
        ack = await conn.request(frame, { timeoutMs: RESUME_TIMEOUT_MS });
      } catch (err) {
        if (err instanceof HubError) throw new ResumeError(err.code, resumeErrorText(err.code, err.message, host));
        if (err instanceof ConnectionError) {
          throw new ResumeError(err.kind, err.kind === 'timeout' ? resumeErrorText('timeout', '', host) : `${host} disconnected before the session started.`);
        }
        throw err;
      }
      const liveId = ack.sessionId || sessionId;
      if (ack.cwdFallback && ack.cwd) {
        const recorded = this.store.getState().history[hubId]?.byId[sessionId]?.cwd;
        const note = resumeFallbackNote(recorded, ack.cwd);
        this.store.setState((s) => ({ resumeNotes: { ...s.resumeNotes, [transcriptKey(hubId, liveId)]: note } }));
      }
      if (liveId !== sessionId) {
        // Not expected (the contract keeps the id), but follow it rather than lose the thread.
        this.store.setState((s) => ({ replacements: { ...s.replacements, [key]: liveId } }));
      } else {
        // Registered by the time of the ack: subscribe now even if its upsert is still on the way.
        this.promoteToLive(hubId, sessionId);
      }
      if (images) await this.prompt(hubId, liveId, text ?? '', images);
      return liveId;
    } finally {
      this.store.setState((s) => {
        const resuming = { ...s.resuming };
        delete resuming[key];
        return { resuming };
      });
    }
  }

  /** Keeps the newest page of an open transcript on the phone. */
  private saveTranscript(hubId: string, sessionId: string): void {
    const cache = this.opts.historyCache;
    if (!cache) return;
    const t = this.store.getState().transcripts[transcriptKey(hubId, sessionId)];
    if (!t || t.order.length === 0 || t.source === 'cache') return;
    const items = t.order.map((id) => t.byId[id]).filter(Boolean);
    const wasCached = cache.cachedKeys().has(transcriptKey(hubId, sessionId));
    cache
      .saveTranscript(hubId, sessionId, items, t.hasMore, this.now())
      .then(() => {
        // The index keeps the facts of sessions with a cached transcript.
        if (!wasCached) this.scheduleIndexSave();
      })
      .catch((err) => this.log('Could not cache the transcript', err));
  }

  private scheduleIndexSave(delay = INDEX_SAVE_DELAY_MS): void {
    const cache = this.opts.historyCache;
    if (!cache || this.disposed) return;
    if (this.indexSaveTimer) clearTimeout(this.indexSaveTimer);
    this.indexSaveTimer = setTimeout(() => {
      this.indexSaveTimer = null;
      const history = this.store.getState().history;
      cache.saveIndex(history, this.now()).catch((err) => this.log('Could not cache the session index', err));
    }, delay);
  }

  // -------------------------------------------------------------------------
  // Slash commands (protocol "Slash commands (v1 addition)")
  // -------------------------------------------------------------------------

  /**
   * Makes sure a session's slash commands are loaded (into `state.commands`): fetched on the
   * first `/`, again after a `reset`, a `commandsVersion` change or a reconnect. Failures
   * (older hubs answer `bad_request`) leave the list empty and are never surfaced.
   */
  ensureCommands(hubId: string, sessionId: string): void {
    const meta = this.commandsMeta.get(transcriptKey(hubId, sessionId));
    if (meta) {
      if (meta.inflight) return;
      const fresh = meta.retryAt === 0; // loaded, not invalidated since
      const waiting = this.now() < meta.retryAt; // failed recently (or never: Infinity)
      if (!meta.stale && (fresh || waiting)) return;
    }
    void this.fetchCommands(hubId, sessionId);
  }

  private setCommands(key: string, entry: CommandsEntry): void {
    this.store.setState((s) => ({ commands: { ...s.commands, [key]: entry } }));
  }

  private async fetchCommands(hubId: string, sessionId: string): Promise<void> {
    const key = transcriptKey(hubId, sessionId);
    const conn = this.conns.get(hubId);
    if (!conn || conn.status !== 'live') return; // asked again on the next '/'
    const version = this.store.getState().sessions[hubId]?.[sessionId]?.commandsVersion;
    const meta: CommandsMeta = { hubId, sessionId, version, inflight: true, stale: false, retryAt: 0 };
    this.commandsMeta.set(key, meta);
    const prev = this.store.getState().commands[key];
    this.setCommands(key, { status: prev?.status === 'ready' ? 'ready' : 'loading', commands: prev?.commands ?? [] });
    let commands: CommandInfo[] | null = null;
    let failure: unknown = null;
    try {
      commands = (await conn.request({ t: 'commands.list', sessionId }, { timeoutMs: COMMANDS_TIMEOUT_MS })).commands;
    } catch (err) {
      failure = err;
    }
    if (this.commandsMeta.get(key) !== meta) return; // removed or replaced meanwhile
    meta.inflight = false;
    if (commands) {
      this.setCommands(key, { status: 'ready', commands });
    } else {
      // A hub without commands.list answers bad_request: do not ask it again until it reconnects.
      meta.retryAt = failure instanceof HubError && failure.code === 'bad_request' ? Infinity : this.now() + COMMANDS_RETRY_MS;
      const current = this.store.getState().commands[key];
      // A failed refresh keeps a list we already had; anything else hides the menu.
      if (!(current?.status === 'ready' && current.commands.length && !(failure instanceof HubError))) {
        this.setCommands(key, { status: 'unavailable', commands: [] });
      }
      this.log('commands.list failed', failure);
    }
    if (meta.stale) void this.fetchCommands(hubId, sessionId);
  }

  /** The list may have changed: refetch now if it was ever loaded (the menu stays instant). */
  private invalidateCommands(key: string): void {
    const meta = this.commandsMeta.get(key);
    if (!meta) return;
    meta.stale = true;
    meta.retryAt = 0;
    if (!meta.inflight) void this.fetchCommands(meta.hubId, meta.sessionId);
  }

  private checkCommandsVersion(hubId: string, summary: SessionSummary): void {
    const meta = this.commandsMeta.get(transcriptKey(hubId, summary.sessionId));
    if (meta && meta.version !== summary.commandsVersion) this.invalidateCommands(transcriptKey(hubId, summary.sessionId));
  }

  private dropCommands(key: string): void {
    this.commandsMeta.delete(key);
    if (!(key in this.store.getState().commands)) return;
    this.store.setState((s) => {
      const commands = { ...s.commands };
      delete commands[key];
      return { commands };
    });
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  private conn(hubId: string): HostConnection {
    const c = this.conns.get(hubId);
    if (!c) throw new ConnectionError('closed', 'That computer is not paired.');
    return c;
  }

  async prompt(hubId: string, sessionId: string, text: string, images?: PromptImage[], mode?: PromptMode): Promise<void> {
    const frame: Extract<ClientRequest, { t: 'session.prompt' }> = { t: 'session.prompt', sessionId, text };
    if (images && images.length > 0) frame.images = images;
    if (mode) frame.mode = mode;
    await this.conn(hubId).request(frame);
  }

  async abort(hubId: string, sessionId: string): Promise<void> {
    await this.conn(hubId).request({ t: 'session.abort', sessionId });
  }

  /** Models for a session, or (no sessionId) the hub's registry and the user's defaults. */
  async listModels(hubId: string, sessionId?: string): Promise<ModelsResult> {
    const reply = await this.conn(hubId).request(sessionId ? { t: 'models.list', sessionId } : { t: 'models.list' });
    const { t: _t, re: _re, ...rest } = reply;
    return rest;
  }

  async setModel(hubId: string, sessionId: string, model: Pick<ModelInfo, 'provider' | 'id'>): Promise<void> {
    await this.conn(hubId).request({ t: 'session.setModel', sessionId, provider: model.provider, modelId: model.id });
  }

  async setThinking(hubId: string, sessionId: string, level: string): Promise<void> {
    await this.conn(hubId).request({ t: 'session.setThinking', sessionId, level });
  }

  async recentCwds(hubId: string): Promise<string[]> {
    const reply = await this.conn(hubId).request({ t: 'cwds.recent' });
    return reply.cwds;
  }

  /** Starts a headless session; resolves with its sessionId. */
  async spawn(hubId: string, req: SpawnRequest): Promise<string> {
    const frame: Extract<ClientRequest, { t: 'session.spawn' }> = { t: 'session.spawn', cwd: req.cwd };
    if (req.prompt) frame.prompt = req.prompt;
    if (req.provider && req.modelId) {
      frame.provider = req.provider;
      frame.modelId = req.modelId;
    }
    if (req.thinkingLevel) frame.thinkingLevel = req.thinkingLevel;
    if (req.name?.trim()) frame.name = req.name.replace(/\s+/g, ' ').trim().slice(0, 200);
    // The hub acks only after the new child registers (hub-side timeout 30 s).
    const ack = await this.conn(hubId).request(frame, { timeoutMs: SPAWN_TIMEOUT_MS });
    if (!ack.sessionId) throw new HubError('internal', 'The computer started the session but did not say which one.');
    if (req.thinkingLevel) void this.matchSpawnThinking(hubId, ack.sessionId, req.thinkingLevel);
    return ack.sessionId;
  }

  /**
   * Hubs from before `session.spawn.thinkingLevel` ignore it: when the new session reports a
   * different level, set it once.
   */
  private async matchSpawnThinking(hubId: string, sessionId: string, level: string): Promise<void> {
    const summary = await this.waitForSession(hubId, sessionId, SPAWN_SUMMARY_WAIT_MS);
    if (!summary || summary.thinkingLevel === level) return;
    await this.setThinking(hubId, sessionId, level).catch((err) => this.log('setThinking after spawn failed', err));
  }

  private waitForSession(hubId: string, sessionId: string, timeoutMs: number): Promise<SessionSummary | undefined> {
    const known = this.store.getState().sessions[hubId]?.[sessionId];
    if (known) return Promise.resolve(known);
    return new Promise((resolve) => {
      const done = (summary: SessionSummary | undefined) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(summary);
      };
      const timer = setTimeout(() => done(undefined), timeoutMs);
      const unsubscribe = this.store.subscribe((s) => {
        const summary = s.sessions[hubId]?.[sessionId];
        if (summary) done(summary);
      });
    });
  }

  /**
   * Overseers (v1 addition): every thread of an overseer, registry order. Hubs without the
   * feature answer `error bad_request` (callers then derive the board from live summaries).
   */
  async overseerBoard(hubId: string, sessionId: string): Promise<OverseerBoard> {
    const reply = await this.conn(hubId).request({ t: 'overseer.board', sessionId }, { timeoutMs: BOARD_TIMEOUT_MS });
    const { t: _t, re: _re, ...board } = reply;
    return board;
  }

  /** The computer answers `overseer.board` and reports overseer fields (Overseers, v1 addition). */
  hasOverseer(hubId: string): boolean {
    return !!this.store.getState().hosts[hubId]?.features?.includes(OVERSEER_FEATURE);
  }

  async closeSession(hubId: string, sessionId: string): Promise<void> {
    await this.conn(hubId).request({ t: 'session.close', sessionId });
  }

  // -------------------------------------------------------------------------
  // Focus
  // -------------------------------------------------------------------------

  /** What the app shows in the foreground; suppresses pushes for that session. */
  setFocus(target: { hubId: string; sessionId: string } | null): void {
    this.focus = target;
    this.syncFocus();
  }

  private syncFocus(): void {
    for (const [hubId, conn] of this.conns) {
      if (conn.status !== 'live') continue;
      const want = this.appActive && this.focus?.hubId === hubId ? this.focus.sessionId : null;
      const sent = this.focusSent.get(hubId) ?? null;
      if (sent === want) continue;
      if (conn.notify({ t: 'focus', sessionId: want })) this.focusSent.set(hubId, want);
    }
  }

  // -------------------------------------------------------------------------
  // Push
  // -------------------------------------------------------------------------

  /** Whether the user has turned notifications on (persisted). */
  get notificationsPref(): Prefs['notifications'] {
    return this.store.getState().prefs.notifications;
  }

  /**
   * Turns pushes on (registration) or off (null) on every live host now; hosts that are
   * offline get the same call when they reconnect. Resolves with how many live hosts accepted.
   */
  async setPush(reg: PushRegistration | null): Promise<{ ok: number; failed: number }> {
    await this.init();
    this.push = reg;
    const prefs: Prefs = { ...this.store.getState().prefs, notifications: reg ? 'on' : 'off' };
    this.store.setState({ prefs });
    await this.opts.storage.savePrefs(prefs).catch((err) => this.log('Could not save prefs', err));
    const results = await Promise.allSettled(
      [...this.conns.values()]
        .filter((c) => c.status === 'live')
        .map((c) => (reg ? c.request({ t: 'push.register', ...reg }) : c.request({ t: 'push.unregister' }))),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    return { ok, failed: results.length - ok };
  }

  /** Persists non-push preferences (read-aloud rate, voice, auto-read, new-thread model and effort, dictation microphone). */
  async updatePrefs(
    patch: Pick<Prefs, 'speechRate' | 'voiceId' | 'ttsVoice' | 'autoRead' | 'newThread' | 'dictationMic' | 'overseer'>,
  ): Promise<void> {
    const prefs: Prefs = { ...this.store.getState().prefs, ...patch };
    for (const k of Object.keys(prefs) as (keyof Prefs)[]) if (prefs[k] === undefined) delete prefs[k];
    this.store.setState({ prefs });
    await this.opts.storage.savePrefs(prefs).catch((err) => this.log('Could not save prefs', err));
  }

  /** Sets the in-memory registration without changing prefs (used at launch when already on). */
  restorePush(reg: PushRegistration): void {
    this.push = reg;
    for (const c of this.conns.values()) {
      if (c.status === 'live') c.request({ t: 'push.register', ...reg }).catch((err) => this.log('push.register failed', err));
    }
  }

  // -------------------------------------------------------------------------
  // App state
  // -------------------------------------------------------------------------

  private handleAppState(state: string): void {
    if (state === 'active') {
      if (this.appActive) return;
      this.appActive = true;
      if (this.bgTimer) clearTimeout(this.bgTimer);
      this.bgTimer = null;
      const away = this.backgroundedAt === null ? 0 : this.now() - this.backgroundedAt;
      this.backgroundedAt = null;
      const grace = this.opts.backgroundGraceMs ?? 30_000;
      this.traceAll({ kind: 'foreground', ms: away });
      for (const conn of this.conns.values()) {
        if (conn.status === 'unauthorized' || conn.status === 'incompatible') continue;
        if (conn.status === 'paused' || away >= grace) {
          // iOS suspends JS in the background, so the pause timer may not have fired;
          // after a long absence the socket is likely dead even if it looks live.
          conn.pause();
          conn.resume();
        } else {
          // Back soon: retry now (attempts from before the background start over), and check a
          // connection that looks live with a ping.
          conn.reconnect('foreground', { fresh: true, restartOlderThanMs: 1_000, probe: away >= 5_000 });
        }
      }
      this.syncFocus();
      return;
    }
    if (state !== 'background' || !this.appActive) return;
    this.appActive = false;
    this.backgroundedAt = this.now();
    this.traceAll({ kind: 'background' });
    void this.opts.trace?.flush().catch(() => undefined);
    this.syncFocus();
    if (this.bgTimer) clearTimeout(this.bgTimer);
    this.bgTimer = setTimeout(() => {
      this.bgTimer = null;
      if (!this.appActive) for (const conn of this.conns.values()) conn.pause();
    }, this.opts.backgroundGraceMs ?? 30_000);
  }

  private log(message: string, error?: unknown): void {
    this.opts.log?.(message, error);
  }
}

function toHostView(h: StoredHost): HostView {
  return {
    hubId: h.hubId,
    name: h.name,
    urls: h.urls,
    preferredUrl: h.preferredUrl,
    deviceId: h.deviceId,
    pairedAt: h.pairedAt,
    lastSeenAt: h.lastSeenAt ?? null,
    conn: initialConnInfo,
    features: null,
  };
}
