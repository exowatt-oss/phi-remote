/**
 * phi remote protocol v1 — client-side types and defensive frame validation.
 *
 * Mirrors docs/PROTOCOL.md exactly. Inbound frames are validated field by field:
 * unknown frame types and unknown fields are dropped, malformed list entries are
 * skipped rather than failing the whole frame.
 */

import { parseBoard, parseOverseerLink, parseThreadCounts, type OverseerBoard, type OverseerLink, type ThreadCounts } from './overseer';
import { parseSubagentCounts, parseSubagentInfo, parseTmux, type SubagentCounts, type SubagentInfo } from './subagents';

export type { BoardThread, OverseerBoard, OverseerLink, ThreadCounts } from './overseer';
export type { SubagentCounts, SubagentInfo, SubagentRunStatus } from './subagents';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 7717;

/**
 * Optional protocol additions this app understands, sent in `hello.features`. Hubs only send
 * subagent sessions to clients that list `subagents` (older hubs ignore the field).
 */
export const CLIENT_FEATURES = ['subagents'] as const;

/**
 * Session history (v1 addition): a hub that lists `history` in `welcome.host.features` answers
 * `sessions.past`, `session.transcript` and `session.resume`.
 */
export const HISTORY_FEATURE = 'history';

export type SessionStatus = 'working' | 'idle';

export type Activity = { tool: string; summary?: string };

export type SessionSummary = {
  sessionId: string;
  name: string;
  cwd: string;
  host: string;
  pid: number;
  /** `subagent`: a worker launched by another session's `subagent` tool (Subagents, v1 addition). */
  kind: 'interactive' | 'headless' | 'subagent';
  status: SessionStatus;
  model?: { provider: string; id: string; name?: string };
  thinkingLevel?: string;
  startedAt: number;
  lastActivityAt: number;
  lastText?: string;
  activity?: Activity;
  usage?: { costUsd?: number; contextPercent?: number };
  /** Slash commands (v1 addition): changes whenever the session's command list changes. */
  commandsVersion?: number | string;
  /** Subagents (v1 addition), `kind: "subagent"` only: the session that launched it. */
  parentSessionId?: string;
  /** Subagents (v1 addition), `kind: "subagent"` only: the run. */
  subagent?: SubagentInfo;
  /** Subagents (v1 addition), on a parent: how many of its subagents are running, of how many. */
  subagents?: SubagentCounts;
  /** The session runs inside tmux (its `name` defaults to the tmux session name). */
  tmux?: { session: string; window?: string };
  /** An overseer started this session: it is one of that overseer's threads. */
  overseer?: OverseerLink;
  /** Error of the last turn, one line (cleared by the next reply without one). */
  lastError?: string;
  /** Overseers (v1 addition): this session is an overseer with at least one thread. */
  isOverseer?: true;
  /** Overseers (v1 addition), on overseers: its threads by state (registry + live summaries). */
  threadCounts?: ThreadCounts;
};

/** Slash commands (v1 addition). */
export type CommandSource = 'builtin' | 'extension' | 'prompt' | 'skill';

/**
 * One slash command a session accepts. `name` is exactly what goes after the slash and may
 * contain a colon (`skill:use-subs`).
 */
export type CommandInfo = {
  name: string;
  description?: string;
  source: CommandSource;
  argumentHint?: string;
};

export type LiveState = { status: SessionStatus; activity?: Activity };

export type UserItem = { id: string; ts: number; kind: 'user'; text: string; images?: number };
export type AssistantItem = {
  id: string;
  ts: number;
  kind: 'assistant';
  text: string;
  thinking?: string;
  model?: string;
  streaming?: boolean;
  error?: string;
};
export type ToolItem = {
  id: string;
  ts: number;
  kind: 'tool';
  toolCallId: string;
  name: string;
  summary: string;
  args?: unknown;
  status: 'running' | 'ok' | 'error';
  output?: string;
  outputTruncated?: boolean;
};
export type NoteItem = { id: string; ts: number; kind: 'note'; label?: string; text: string };

export type TranscriptItem = UserItem | AssistantItem | ToolItem | NoteItem;

export type LiveEvent =
  | { type: 'item.upsert'; item: TranscriptItem }
  | { type: 'state'; state: LiveState }
  /** `replacedBy`: /new (and friends) moved the conversation to a new session id. */
  | { type: 'reset'; replacedBy?: string };

export type HostInfo = {
  name: string;
  hubId: string;
  hubVersion: string;
  protocol: number;
  /** Optional additions the hub implements (`history`); empty for older hubs. */
  features: string[];
};

/** Session history (v1 addition): one stored phi session on a computer (`sessions.past`). */
export type PastSession = {
  sessionId: string;
  /** session_info name, else the first user message line, else the cwd basename. */
  title: string;
  /** The title is a name the user gave the session. */
  named: boolean;
  /** "" for very old sessions. */
  cwd: string;
  createdAt: number;
  modifiedAt: number;
  messageCount: number;
  /** Last assistant reply, one line. */
  preview?: string;
  model?: { provider: string; id: string };
  /** Registered with the hub right now (the app trusts `sessions.list` for this instead). */
  live: boolean;
  liveKind?: 'interactive' | 'headless';
  /**
   * Data only: false when the hub could not read the session file. The app never gates on it
   * (sending always tries `session.resume`; a refusal shows as a normal send failure).
   */
  resumable: boolean;
  /** Overseers (v1 addition): the overseer that started this session (from the registry files). */
  overseer?: OverseerLink;
  /** Overseers (v1 addition): this session started threads. */
  isOverseer?: true;
};

export type ModelInfo = { provider: string; id: string; name: string; reasoning: boolean };

export type ErrorCode = 'not_found' | 'bad_request' | 'session_offline' | 'forbidden' | 'internal' | (string & {});

export type ServerFrame =
  | { t: 'welcome'; host: HostInfo; deviceId: string }
  | { t: 'pong'; re: string }
  | {
      t: 'ack';
      re: string;
      ok: boolean;
      error?: { code: ErrorCode; message: string };
      sessionId?: string;
      /** session.resume: the folder it runs in, and `cwdFallback` when the recorded one was gone. */
      cwd?: string;
      cwdFallback?: boolean;
    }
  | { t: 'error'; re?: string; code: ErrorCode; message: string }
  | { t: 'sessions'; re: string; sessions: SessionSummary[] }
  | { t: 'session.upsert'; session: SessionSummary }
  /** `replacedBy`: the session continues under that id (sent after /new, /resume, /fork, ...). */
  | { t: 'session.remove'; sessionId: string; replacedBy?: string }
  | {
      t: 'session.snapshot';
      re: string;
      sessionId: string;
      items: TranscriptItem[];
      hasMore: boolean;
      state: LiveState;
    }
  | { t: 'session.history'; re: string; sessionId: string; items: TranscriptItem[]; hasMore: boolean }
  | { t: 'session.event'; sessionId: string; event: LiveEvent }
  | {
      t: 'models';
      re: string;
      models: ModelInfo[];
      current?: { provider: string; id: string };
      thinkingLevel?: string;
      thinkingLevels: string[];
    }
  | { t: 'cwds'; re: string; cwds: string[] }
  | { t: 'commands'; re: string; sessionId: string; commands: CommandInfo[] }
  /** Session history (v1 addition). `nextCursor` absent = the end. */
  | { t: 'sessions.past'; re: string; sessions: PastSession[]; nextCursor?: string; indexing?: boolean }
  | { t: 'session.transcript'; re: string; sessionId: string; items: TranscriptItem[]; hasMore: boolean }
  /** Overseers (v1 addition): every thread an overseer started or adopted, registry order. */
  | ({ t: 'overseer.board'; re: string } & OverseerBoard);

export type ServerFrameOf<T extends ServerFrame['t']> = Extract<ServerFrame, { t: T }>;

export type PromptImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
export type PromptImage = { mimeType: PromptImageMime; data: string };
export type PromptMode = 'auto' | 'steer' | 'followUp';
export type PushEnv = 'sandbox' | 'production';

/** Client → hub frames. Requests carry `id`; fire-and-forget frames do not. */
export type ClientRequest =
  | { t: 'ping' }
  | { t: 'sessions.list' }
  | { t: 'session.subscribe'; sessionId: string; limit?: number }
  | { t: 'session.history'; sessionId: string; before: string; limit?: number }
  | { t: 'session.prompt'; sessionId: string; text: string; images?: PromptImage[]; mode?: PromptMode }
  | { t: 'session.abort'; sessionId: string }
  /** sessionId is optional: without it the hub answers from its own model registry. */
  | { t: 'models.list'; sessionId?: string }
  | { t: 'session.setModel'; sessionId: string; provider: string; modelId: string }
  | { t: 'session.setThinking'; sessionId: string; level: string }
  | { t: 'cwds.recent' }
  /** Slash commands (v1 addition). Older hubs answer `error bad_request`. */
  | { t: 'commands.list'; sessionId: string }
  /**
   * `thinkingLevel`: one of models.list `thinkingLevels` (older hubs ignore it, see RemoteClient.spawn).
   * `name` (Overseers, v1 addition): the session name, one line (older hubs ignore it).
   */
  | { t: 'session.spawn'; cwd: string; prompt?: string; provider?: string; modelId?: string; thinkingLevel?: string; name?: string }
  | { t: 'session.close'; sessionId: string }
  /** Session history (v1 addition): stored sessions, newest first, paged by an opaque cursor. */
  | { t: 'sessions.past'; limit?: number; cursor?: string; query?: string; cwd?: string }
  /** Session history (v1 addition): the newest page of any listed session, or the page before `before`. */
  | { t: 'session.transcript'; sessionId: string; before?: string; limit?: number }
  /**
   * Session history (v1 addition): makes a stored session live again under the same id. Model and
   * level are sent only when the user picked them; otherwise it keeps its own.
   */
  | { t: 'session.resume'; sessionId: string; prompt?: string; provider?: string; modelId?: string; thinkingLevel?: string }
  | { t: 'push.register'; apnsToken: string; env: PushEnv; bundleId: string }
  | { t: 'push.unregister' }
  /** Overseers (v1 addition): the overseer's threads. Older hubs answer `error bad_request`. */
  | { t: 'overseer.board'; sessionId: string };

export type ClientNotice =
  | { t: 'session.unsubscribe'; sessionId: string }
  | { t: 'focus'; sessionId: string | null };

export type HelloFrame = {
  t: 'hello';
  token: string;
  protocol: typeof PROTOCOL_VERSION;
  app: { version: string; build: string };
  device?: { name: string };
  /** Optional additions the app understands (`CLIENT_FEATURES`). */
  features?: string[];
};

/** Maps each request type to the reply frame type the hub sends back. */
export type ReplyFor<R extends ClientRequest> = R['t'] extends 'ping'
  ? ServerFrameOf<'pong'>
  : R['t'] extends 'sessions.list'
    ? ServerFrameOf<'sessions'>
    : R['t'] extends 'session.subscribe'
      ? ServerFrameOf<'session.snapshot'>
      : R['t'] extends 'session.history'
        ? ServerFrameOf<'session.history'>
        : R['t'] extends 'models.list'
          ? ServerFrameOf<'models'>
          : R['t'] extends 'cwds.recent'
            ? ServerFrameOf<'cwds'>
            : R['t'] extends 'commands.list'
              ? ServerFrameOf<'commands'>
              : R['t'] extends 'sessions.past'
                ? ServerFrameOf<'sessions.past'>
                : R['t'] extends 'session.transcript'
                  ? ServerFrameOf<'session.transcript'>
                  : R['t'] extends 'overseer.board'
                    ? ServerFrameOf<'overseer.board'>
                    : ServerFrameOf<'ack'>;

/** WebSocket close codes with protocol meaning. */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_PROTOCOL_MISMATCH = 4426;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}
function optStr(v: unknown): string | undefined {
  return isStr(v) ? v : undefined;
}
function optNum(v: unknown): number | undefined {
  return isNum(v) ? v : undefined;
}

/** Copies only defined keys, so validated objects never carry `undefined`-valued keys. */
function compact<T extends Obj>(o: T): T {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

function parseActivity(v: unknown): Activity | undefined {
  if (!isObj(v) || !isStr(v.tool)) return undefined;
  return compact({ tool: v.tool, summary: optStr(v.summary) });
}

function parseStatus(v: unknown): SessionStatus | null {
  return v === 'working' || v === 'idle' ? v : null;
}

export function parseSessionSummary(v: unknown): SessionSummary | null {
  if (!isObj(v)) return null;
  const status = parseStatus(v.status);
  if (!isStr(v.sessionId) || v.sessionId.length === 0 || !status) return null;
  const cwd = isStr(v.cwd) ? v.cwd : '';
  const name = isStr(v.name) && v.name.trim() ? v.name : basename(cwd) || v.sessionId;
  let model: SessionSummary['model'];
  if (isObj(v.model) && isStr(v.model.provider) && isStr(v.model.id)) {
    model = compact({ provider: v.model.provider, id: v.model.id, name: optStr(v.model.name) });
  }
  let usage: SessionSummary['usage'];
  if (isObj(v.usage)) {
    usage = compact({ costUsd: optNum(v.usage.costUsd), contextPercent: optNum(v.usage.contextPercent) });
  }
  const startedAt = optNum(v.startedAt) ?? 0;
  // A subagent needs its parent and run; without them it cannot be placed, so drop it.
  let kind: SessionSummary['kind'] = v.kind === 'headless' ? 'headless' : 'interactive';
  let parentSessionId: string | undefined;
  let subagent: SubagentInfo | undefined;
  if (v.kind === 'subagent') {
    subagent = parseSubagentInfo(v.subagent) ?? undefined;
    parentSessionId = isStr(v.parentSessionId) && v.parentSessionId ? v.parentSessionId : undefined;
    if (!subagent || !parentSessionId) return null;
    kind = 'subagent';
  }
  return compact({
    sessionId: v.sessionId,
    name,
    cwd,
    host: isStr(v.host) ? v.host : '',
    pid: optNum(v.pid) ?? 0,
    kind,
    status,
    model,
    thinkingLevel: optStr(v.thinkingLevel),
    startedAt,
    lastActivityAt: optNum(v.lastActivityAt) ?? startedAt,
    lastText: optStr(v.lastText),
    activity: parseActivity(v.activity),
    usage,
    commandsVersion: isStr(v.commandsVersion) || isNum(v.commandsVersion) ? v.commandsVersion : undefined,
    parentSessionId,
    subagent,
    subagents: kind === 'subagent' ? undefined : parseSubagentCounts(v.subagents),
    tmux: parseTmux(v.tmux),
    overseer: kind === 'subagent' ? undefined : parseOverseerLink(v.overseer),
    lastError: isStr(v.lastError) && v.lastError.trim() ? v.lastError : undefined,
    isOverseer: kind !== 'subagent' && v.isOverseer === true ? true : undefined,
    threadCounts: kind === 'subagent' ? undefined : parseThreadCounts(v.threadCounts),
  }) as SessionSummary;
}

const COMMAND_SOURCES: readonly CommandSource[] = ['builtin', 'extension', 'prompt', 'skill'];

/** One `CommandInfo`; null when `name` is missing/empty or has whitespace, unknown sources read as `extension`. */
export function parseCommandInfo(v: unknown): CommandInfo | null {
  if (!isObj(v) || !isStr(v.name)) return null;
  const name = v.name.trim().replace(/^\/+/, '');
  if (!name || /\s/.test(name)) return null;
  const source = COMMAND_SOURCES.includes(v.source as CommandSource) ? (v.source as CommandSource) : 'extension';
  const description = isStr(v.description) ? v.description.trim() : '';
  const argumentHint = isStr(v.argumentHint) ? v.argumentHint.trim() : '';
  return compact({
    name,
    description: description || undefined,
    source,
    argumentHint: argumentHint || undefined,
  }) as CommandInfo;
}

function parseCommands(v: unknown): CommandInfo[] {
  if (!Array.isArray(v)) return [];
  const out: CommandInfo[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const c = parseCommandInfo(raw);
    if (!c || seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out;
}

export function parseLiveState(v: unknown): LiveState | null {
  if (!isObj(v)) return null;
  const status = parseStatus(v.status);
  if (!status) return null;
  return compact({ status, activity: parseActivity(v.activity) }) as LiveState;
}

export function parseTranscriptItem(v: unknown): TranscriptItem | null {
  if (!isObj(v) || !isStr(v.id) || v.id.length === 0) return null;
  const ts = optNum(v.ts) ?? 0;
  switch (v.kind) {
    case 'user':
      return compact({
        id: v.id,
        ts,
        kind: 'user' as const,
        text: isStr(v.text) ? v.text : '',
        images: optNum(v.images),
      }) as UserItem;
    case 'assistant':
      return compact({
        id: v.id,
        ts,
        kind: 'assistant' as const,
        text: isStr(v.text) ? v.text : '',
        thinking: optStr(v.thinking),
        model: optStr(v.model),
        streaming: v.streaming === true ? true : undefined,
        error: optStr(v.error),
      }) as AssistantItem;
    case 'tool': {
      const status = v.status === 'running' || v.status === 'ok' || v.status === 'error' ? v.status : null;
      if (!status) return null;
      const name = isStr(v.name) ? v.name : 'tool';
      return compact({
        id: v.id,
        ts,
        kind: 'tool' as const,
        toolCallId: isStr(v.toolCallId) ? v.toolCallId : v.id,
        name,
        summary: isStr(v.summary) && v.summary ? v.summary : name,
        args: v.args,
        status,
        output: optStr(v.output),
        outputTruncated: v.outputTruncated === true ? true : undefined,
      }) as ToolItem;
    }
    case 'note':
      return compact({
        id: v.id,
        ts,
        kind: 'note' as const,
        label: optStr(v.label),
        text: isStr(v.text) ? v.text : '',
      }) as NoteItem;
    default:
      return null;
  }
}

function parseItems(v: unknown): TranscriptItem[] {
  if (!Array.isArray(v)) return [];
  const out: TranscriptItem[] = [];
  for (const raw of v) {
    const item = parseTranscriptItem(raw);
    if (item) out.push(item);
  }
  return out;
}

/** One `PastSession`; null without a sessionId. Missing optional facts get safe defaults. */
export function parsePastSession(v: unknown): PastSession | null {
  if (!isObj(v) || !isStr(v.sessionId) || v.sessionId.length === 0) return null;
  const cwd = isStr(v.cwd) ? v.cwd : '';
  const createdAt = optNum(v.createdAt) ?? 0;
  const modifiedAt = optNum(v.modifiedAt) ?? createdAt;
  const title = isStr(v.title) && v.title.trim() ? v.title.trim() : basename(cwd) || 'Untitled session';
  let model: PastSession['model'];
  if (isObj(v.model) && isStr(v.model.provider) && isStr(v.model.id) && v.model.id) model = { provider: v.model.provider, id: v.model.id };
  const preview = isStr(v.preview) && v.preview.trim() ? v.preview : undefined;
  return compact({
    sessionId: v.sessionId,
    title,
    named: v.named === true,
    cwd,
    createdAt,
    modifiedAt,
    messageCount: optNum(v.messageCount) ?? 0,
    preview,
    model,
    live: v.live === true,
    liveKind: v.liveKind === 'interactive' || v.liveKind === 'headless' ? v.liveKind : undefined,
    // Data only (never gates sending); absent reads as true.
    resumable: v.resumable !== false,
    overseer: parseOverseerLink(v.overseer),
    isOverseer: v.isOverseer === true ? true : undefined,
  }) as PastSession;
}

function parseLiveEvent(v: unknown): LiveEvent | null {
  if (!isObj(v)) return null;
  switch (v.type) {
    case 'item.upsert': {
      const item = parseTranscriptItem(v.item);
      return item ? { type: 'item.upsert', item } : null;
    }
    case 'state': {
      const state = parseLiveState(v.state);
      return state ? { type: 'state', state } : null;
    }
    case 'reset':
      return isStr(v.replacedBy) && v.replacedBy ? { type: 'reset', replacedBy: v.replacedBy } : { type: 'reset' };
    default:
      return null;
  }
}

function parseError(v: unknown): { code: ErrorCode; message: string } | undefined {
  if (!isObj(v)) return undefined;
  const code = isStr(v.code) ? v.code : 'internal';
  const message = isStr(v.message) ? v.message : code;
  return { code, message };
}

function parseModel(v: unknown): ModelInfo | null {
  if (!isObj(v) || !isStr(v.provider) || !isStr(v.id)) return null;
  return { provider: v.provider, id: v.id, name: isStr(v.name) && v.name ? v.name : v.id, reasoning: v.reasoning === true };
}

/**
 * Parses one inbound WebSocket text frame. Returns null for anything that is not a
 * well-formed frame of a known type; callers simply ignore those.
 */
export function parseServerFrame(input: unknown): ServerFrame | null {
  let v: unknown = input;
  if (typeof input === 'string') {
    try {
      v = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!isObj(v) || !isStr(v.t)) return null;
  const re = optStr(v.re);
  switch (v.t) {
    case 'welcome': {
      const h = v.host;
      if (!isObj(h) || !isStr(h.hubId)) return null;
      return {
        t: 'welcome',
        host: {
          name: isStr(h.name) ? h.name : '',
          hubId: h.hubId,
          hubVersion: isStr(h.hubVersion) ? h.hubVersion : '',
          protocol: isNum(h.protocol) ? h.protocol : PROTOCOL_VERSION,
          features: Array.isArray(h.features) ? h.features.filter(isStr).slice(0, 32) : [],
        },
        deviceId: isStr(v.deviceId) ? v.deviceId : '',
      };
    }
    case 'pong':
      return re ? { t: 'pong', re } : null;
    case 'ack': {
      if (!re || !isBool(v.ok)) return null;
      return compact({
        t: 'ack' as const,
        re,
        ok: v.ok,
        error: v.ok ? undefined : (parseError(v.error) ?? { code: 'internal', message: 'Request failed' }),
        sessionId: optStr(v.sessionId),
        cwd: optStr(v.cwd),
        cwdFallback: v.cwdFallback === true ? true : undefined,
      });
    }
    case 'error':
      return compact({
        t: 'error' as const,
        re,
        code: isStr(v.code) ? v.code : 'internal',
        message: isStr(v.message) ? v.message : 'Unknown error',
      });
    case 'sessions': {
      if (!re || !Array.isArray(v.sessions)) return null;
      const sessions: SessionSummary[] = [];
      for (const raw of v.sessions) {
        const s = parseSessionSummary(raw);
        if (s) sessions.push(s);
      }
      return { t: 'sessions', re, sessions };
    }
    case 'session.upsert': {
      const session = parseSessionSummary(v.session);
      return session ? { t: 'session.upsert', session } : null;
    }
    case 'session.remove':
      if (!isStr(v.sessionId)) return null;
      return isStr(v.replacedBy) && v.replacedBy && v.replacedBy !== v.sessionId
        ? { t: 'session.remove', sessionId: v.sessionId, replacedBy: v.replacedBy }
        : { t: 'session.remove', sessionId: v.sessionId };
    case 'session.snapshot': {
      if (!re || !isStr(v.sessionId)) return null;
      return {
        t: 'session.snapshot',
        re,
        sessionId: v.sessionId,
        items: parseItems(v.items),
        hasMore: v.hasMore === true,
        state: parseLiveState(v.state) ?? { status: 'idle' },
      };
    }
    case 'session.history': {
      if (!re || !isStr(v.sessionId)) return null;
      return { t: 'session.history', re, sessionId: v.sessionId, items: parseItems(v.items), hasMore: v.hasMore === true };
    }
    case 'session.event': {
      if (!isStr(v.sessionId)) return null;
      const event = parseLiveEvent(v.event);
      return event ? { t: 'session.event', sessionId: v.sessionId, event } : null;
    }
    case 'models': {
      if (!re) return null;
      const models: ModelInfo[] = [];
      if (Array.isArray(v.models)) {
        for (const raw of v.models) {
          const m = parseModel(raw);
          if (m) models.push(m);
        }
      }
      let current: { provider: string; id: string } | undefined;
      if (isObj(v.current) && isStr(v.current.provider) && isStr(v.current.id)) {
        current = { provider: v.current.provider, id: v.current.id };
      }
      return compact({
        t: 'models' as const,
        re,
        models,
        current,
        thinkingLevel: optStr(v.thinkingLevel),
        thinkingLevels: Array.isArray(v.thinkingLevels) ? v.thinkingLevels.filter(isStr) : [],
      });
    }
    case 'cwds':
      if (!re) return null;
      return { t: 'cwds', re, cwds: Array.isArray(v.cwds) ? v.cwds.filter(isStr) : [] };
    case 'commands':
      if (!re) return null;
      return { t: 'commands', re, sessionId: isStr(v.sessionId) ? v.sessionId : '', commands: parseCommands(v.commands) };
    case 'sessions.past': {
      if (!re || !Array.isArray(v.sessions)) return null;
      const sessions: PastSession[] = [];
      const seen = new Set<string>();
      for (const raw of v.sessions) {
        const s = parsePastSession(raw);
        if (!s || seen.has(s.sessionId)) continue;
        seen.add(s.sessionId);
        sessions.push(s);
      }
      return compact({
        t: 'sessions.past' as const,
        re,
        sessions,
        nextCursor: isStr(v.nextCursor) && v.nextCursor ? v.nextCursor : undefined,
        indexing: v.indexing === true ? true : undefined,
      });
    }
    case 'session.transcript': {
      if (!re || !isStr(v.sessionId)) return null;
      return { t: 'session.transcript', re, sessionId: v.sessionId, items: parseItems(v.items), hasMore: v.hasMore === true };
    }
    case 'overseer.board': {
      const board = re ? parseBoard(v) : null;
      return board ? { t: 'overseer.board', re: re!, ...board } : null;
    }
    default:
      return null;
  }
}

/** Last path segment, tolerant of trailing slashes. */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/** An error reported by the hub (`ack.ok === false` or an `error` frame). */
export class HubError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'HubError';
    this.code = code;
  }
}
