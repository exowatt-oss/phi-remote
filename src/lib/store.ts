/**
 * App state shape (zustand vanilla store) plus pure selectors. No React here; the UI reads it
 * with `useStore` and the RemoteClient is the only writer.
 */

import { createStore, type StoreApi } from 'zustand/vanilla';

import type { ConnInfo } from './connection';
import { shortCwd } from './format';
import type { HubHistory, SearchState } from './history';
import { nestUnderOverseers } from './overseer';
import { basename, type CommandInfo, type SessionSummary } from './protocol';
import type { Prefs } from './storage';
import { emptyTranscript, type TranscriptState } from './transcript';

export type HostView = {
  hubId: string;
  name: string;
  urls: string[];
  preferredUrl: string;
  deviceId: string;
  pairedAt: number;
  lastSeenAt: number | null;
  conn: ConnInfo;
  /** `welcome.host.features` of the current (or last) connection; null before the first one. */
  features: string[] | null;
};

export type RemoteState = {
  /** Hosts loaded from storage. */
  ready: boolean;
  hostOrder: string[];
  hosts: Record<string, HostView>;
  /** hubId → sessionId → summary. Kept (stale) while a host is offline. */
  sessions: Record<string, Record<string, SessionSummary>>;
  sessionsLoaded: Record<string, boolean>;
  /** transcriptKey(hubId, sessionId) → transcript. */
  transcripts: Record<string, TranscriptState>;
  /** transcriptKey(hubId, sessionId) → that session's slash commands (fetched on demand). */
  commands: Record<string, CommandsEntry>;
  /**
   * transcriptKey(hubId, old sessionId) → the sessionId that replaced it (/new, /resume,
   * /fork … start a new session id); an open thread follows it.
   */
  replacements: Record<string, string>;
  prefs: Prefs;
  /** Session history (v1 addition): hubId → that computer's stored sessions (persisted on the phone). */
  history: Record<string, HubHistory>;
  /** The phone's copy of the index has been read (the list can show). */
  historyReady: boolean;
  /** Server-side search across computers; null while not searching. */
  search: SearchState | null;
  /** transcriptKey → a resume in flight (session.resume sent, not acked yet). */
  resuming: Record<string, { since: number }>;
  /** transcriptKey → a quiet line after a resume (its recorded folder was gone, so it ran elsewhere). */
  resumeNotes: Record<string, string>;
};

/**
 * A session's slash commands. `unavailable` covers every failure (older hubs answer
 * `bad_request`): the menu just stays hidden. A refetch keeps the old list visible.
 */
export type CommandsEntry = {
  status: 'loading' | 'ready' | 'unavailable';
  commands: CommandInfo[];
};

export const initialConnInfo: ConnInfo = {
  status: 'idle',
  url: null,
  lastError: null,
  retryAt: null,
  lastSeenAt: null,
  hubVersion: null,
  since: null,
};

export function createRemoteStore(): StoreApi<RemoteState> {
  return createStore<RemoteState>()(() => ({
    ready: false,
    hostOrder: [],
    hosts: {},
    sessions: {},
    sessionsLoaded: {},
    transcripts: {},
    commands: {},
    replacements: {},
    prefs: {},
    history: {},
    historyReady: false,
    search: null,
    resuming: {},
    resumeNotes: {},
  }));
}

export function transcriptKey(hubId: string, sessionId: string): string {
  return `${hubId}\n${sessionId}`;
}

export function selectTranscript(state: RemoteState, hubId: string, sessionId: string): TranscriptState {
  return state.transcripts[transcriptKey(hubId, sessionId)] ?? emptyTranscript;
}

/**
 * A top-level thread (not a subagent). Subagent sessions live in `sessions` too (their threads
 * open from the parent's card) but are never listed, counted or used as a command donor.
 */
export function isThread(s: Pick<SessionSummary, 'kind'>): boolean {
  return s.kind !== 'subagent';
}

const NO_COMMANDS: CommandInfo[] = [];

/** The commands to offer for a session (empty while unknown, loading the first time, or unavailable). */
export function selectCommands(state: RemoteState, hubId: string, sessionId: string | null): CommandInfo[] {
  if (!sessionId) return NO_COMMANDS;
  return state.commands[transcriptKey(hubId, sessionId)]?.commands ?? NO_COMMANDS;
}

/**
 * Which session the new-thread composer borrows its command list from: skills and prompt
 * templates are per machine, so any session on the same computer will do (the most recent).
 */
export function commandsDonor(state: Pick<RemoteState, 'sessions'>, hubId: string | null): string | null {
  if (!hubId) return null;
  let best: SessionSummary | null = null;
  for (const s of Object.values(state.sessions[hubId] ?? {})) {
    if (!isThread(s)) continue;
    if (!best || s.lastActivityAt > best.lastActivityAt) best = s;
  }
  return best?.sessionId ?? null;
}

/** Working sessions first, then most recent activity first; name as a stable tiebreaker. */
export function compareSessions(a: SessionSummary, b: SessionSummary): number {
  if (a.status !== b.status) return a.status === 'working' ? -1 : 1;
  if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
  return a.name.localeCompare(b.name) || a.sessionId.localeCompare(b.sessionId);
}

export type HostGroup = { host: HostView; sessions: SessionSummary[]; loaded: boolean };

/** Sessions grouped by host, hosts in pairing order. */
export function groupSessions(state: Pick<RemoteState, 'hostOrder' | 'hosts' | 'sessions' | 'sessionsLoaded'>): HostGroup[] {
  const groups: HostGroup[] = [];
  for (const hubId of state.hostOrder) {
    const host = state.hosts[hubId];
    if (!host) continue;
    const sessions = Object.values(state.sessions[hubId] ?? {})
      .filter(isThread)
      .sort(compareSessions);
    groups.push({ host, sessions, loaded: !!state.sessionsLoaded[hubId] });
  }
  return groups;
}

export type ProjectGroup = {
  /** Stable key: hubId + cwd (the same path on two computers is two projects). */
  key: string;
  hubId: string;
  hostName: string;
  cwd: string;
  /** Last path segment, e.g. "phi-remote". */
  title: string;
  /** cwd with ~ for the home directory. */
  path: string;
  /** Top-level rows (an overseer's threads are under `threads`, not here). */
  sessions: SessionSummary[];
  /** Overseers (v1 addition): overseer id → its live threads, oldest first (nested under it). */
  threads: Record<string, SessionSummary[]>;
  lastActivityAt: number;
  working: number;
};

/** An overseer sorts by its busiest thread: working when any is, as recent as the latest. */
function effective(s: SessionSummary, threads: readonly SessionSummary[] | undefined): SessionSummary {
  if (!threads?.length) return s;
  const working = s.status === 'working' || threads.some((t) => t.status === 'working');
  const last = Math.max(s.lastActivityAt, ...threads.map((t) => t.lastActivityAt));
  return working === (s.status === 'working') && last === s.lastActivityAt ? s : { ...s, status: working ? 'working' : 'idle', lastActivityAt: last };
}

/**
 * Threads grouped by project (host + cwd), like a sidebar: projects ordered by their most
 * recent activity, threads inside ordered working-first then most recent. An overseer's threads
 * nest under it (in the overseer's project), oldest first, instead of being rows of their own.
 */
export function groupByProject(state: Pick<RemoteState, 'hostOrder' | 'hosts' | 'sessions'>): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const hubId of state.hostOrder) {
    const host = state.hosts[hubId];
    if (!host) continue;
    const listed = Object.values(state.sessions[hubId] ?? {}).filter(isThread);
    const nesting = nestUnderOverseers(
      listed,
      (s) => s.sessionId,
      (s) => s.overseer,
      (s) => s.startedAt,
    );
    for (const s of nesting.top) {
      const cwd = s.cwd.replace(/\/+$/, '') || s.cwd;
      const key = `${hubId}\n${cwd}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          hubId,
          hostName: host.name,
          cwd,
          title: basename(cwd) || cwd || 'No folder',
          path: shortCwd(cwd),
          sessions: [],
          threads: {},
          lastActivityAt: 0,
          working: 0,
        };
        groups.set(key, g);
      }
      g.sessions.push(s);
      const threads = nesting.threads.get(s.sessionId);
      if (threads) g.threads[s.sessionId] = threads;
      for (const x of [s, ...(threads ?? [])]) {
        g.lastActivityAt = Math.max(g.lastActivityAt, x.lastActivityAt);
        if (x.status === 'working') g.working += 1;
      }
    }
  }
  const out = [...groups.values()];
  for (const g of out) g.sessions.sort((a, b) => compareSessions(effective(a, g.threads[a.sessionId]), effective(b, g.threads[b.sessionId])));
  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
  return out;
}

/** Total threads currently working, across every host. */
export function workingCount(state: Pick<RemoteState, 'sessions'>): number {
  let n = 0;
  for (const forHost of Object.values(state.sessions)) {
    for (const s of Object.values(forHost)) if (s.status === 'working' && isThread(s)) n += 1;
  }
  return n;
}

export type Reach = {
  /** Not live: trying or offline (terminal and paused computers are not counted). */
  down: HostView[];
  /** Still in the first attempts of an outage (launch, foreground, network change, a drop). */
  connecting: HostView[];
  /** Not reached after the first attempts; still retrying in the background. */
  offline: HostView[];
  /** Every computer is offline at once: the phone's own path (Tailscale) is the likely cause. */
  allUnreachable: boolean;
};

/** How the paired computers' connections add up (home title, the "Can't reach" line). */
export function reachOf(hosts: HostView[]): Reach {
  const connecting = hosts.filter((h) => h.conn.status === 'connecting' || h.conn.status === 'idle');
  const offline = hosts.filter((h) => h.conn.status === 'offline');
  const live = hosts.filter((h) => h.conn.status === 'live');
  return {
    down: [...connecting, ...offline].sort((a, b) => hosts.indexOf(a) - hosts.indexOf(b)),
    connecting,
    offline,
    allUnreachable: offline.length > 0 && connecting.length === 0 && live.length === 0,
  };
}

/**
 * The home title while computers are not live: "Connecting…" while any is still in its first
 * attempts, "offline" only after. Null when every computer is live (the wordmark shows).
 */
export function connectionTitle(hosts: HostView[]): { text: string; spinner: boolean } | null {
  const { down, connecting } = reachOf(hosts);
  if (down.length === 0) return null;
  const trying = connecting.length > 0;
  if (down.length === 1) return trying ? { text: `Connecting to ${down[0].name}…`, spinner: true } : { text: `${down[0].name} is offline`, spinner: false };
  if (down.length === hosts.length) return trying ? { text: 'Connecting…', spinner: true } : { text: 'Offline', spinner: false };
  return trying ? { text: `Connecting to ${down.length} computers…`, spinner: true } : { text: `${down.length} computers offline`, spinner: false };
}

/** The quiet line when every computer is unreachable at once. */
export const UNREACHABLE_LINE = "Can't reach your computers. Check Tailscale on this iPhone.";
