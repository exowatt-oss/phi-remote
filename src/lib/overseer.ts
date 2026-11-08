/**
 * Overseers (v1 addition, docs/PROTOCOL.md "Overseers"). An overseer is a phi session that starts
 * and manages other phi sessions, its threads, with the `overseer` tool. Pure: parsing, the board
 * (the hub's `overseer.board`, else derived from live summaries), nesting threads under their
 * overseer, the prompts that start an overseer or a thread, and the transcript cards.
 */

import type { CommandInfo, NoteItem, SessionSummary, ToolItem } from './protocol';

/** `welcome.host.features` entry of hubs that answer `overseer.board` and report overseer fields. */
export const OVERSEER_FEATURE = 'overseer';

/** `SessionSummary.overseer` / `PastSession.overseer`: the overseer that owns a thread. */
export type OverseerLink = { sessionId: string; name?: string; thread?: string };

export type ThreadCounts = { total: number; working: number; idle: number; error: number; exited: number; closed: number };

export type BoardBackend = 'forca' | 'tmux' | 'headless' | 'external';

/** One thread on the board (`overseer.board`), registry facts overlaid with the live summary. */
export type BoardThread = {
  name: string;
  sessionId: string;
  backend: BoardBackend;
  adopted?: boolean;
  cwd: string;
  /** "provider/id". */
  model?: string;
  thinking?: string;
  state: 'running' | 'exited' | 'closed';
  /** Registered with the hub right now. */
  live: boolean;
  status?: 'working' | 'idle';
  /** What it is doing now (the current tool and its argument). */
  activity?: string;
  lastText?: string;
  lastError?: string;
  costUsd?: number;
  contextPercent?: number;
  createdAt: number;
  lastActivityAt?: number;
  exitedAt?: number;
  closedAt?: number;
  subagentModels?: { default?: string; allow?: string[] };
};

export type OverseerBoard = { sessionId: string; name?: string; threads: BoardThread[] };

// ---------------------------------------------------------------------------
// Parsing (defensive, like the rest of src/lib/protocol.ts)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

function compact<T extends Obj>(o: T): T {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

export function parseOverseerLink(v: unknown): OverseerLink | undefined {
  if (!isObj(v)) return undefined;
  const sessionId = str(v.sessionId);
  if (!sessionId) return undefined;
  return compact({ sessionId, name: str(v.name)?.trim() || undefined, thread: str(v.thread)?.trim() || undefined });
}

export function parseThreadCounts(v: unknown): ThreadCounts | undefined {
  if (!isObj(v)) return undefined;
  const c: ThreadCounts = {
    total: count(v.total),
    working: count(v.working),
    idle: count(v.idle),
    error: count(v.error),
    exited: count(v.exited),
    closed: count(v.closed),
  };
  return c.total > 0 ? c : undefined;
}

const BACKENDS: readonly BoardBackend[] = ['forca', 'tmux', 'headless', 'external'];

export function parseBoardThread(v: unknown): BoardThread | null {
  if (!isObj(v)) return null;
  const sessionId = str(v.sessionId);
  if (!sessionId) return null;
  const state = v.state === 'exited' || v.state === 'closed' ? v.state : 'running';
  let subagentModels: BoardThread['subagentModels'];
  if (isObj(v.subagentModels)) {
    const allow = Array.isArray(v.subagentModels.allow) ? v.subagentModels.allow.filter((x): x is string => typeof x === 'string') : undefined;
    subagentModels = compact({ default: str(v.subagentModels.default), allow });
  }
  return compact({
    name: str(v.name)?.trim() || sessionId.slice(0, 8),
    sessionId,
    backend: BACKENDS.includes(v.backend as BoardBackend) ? (v.backend as BoardBackend) : 'headless',
    adopted: v.adopted === true ? true : undefined,
    cwd: str(v.cwd) ?? '',
    model: str(v.model),
    thinking: str(v.thinking),
    state,
    live: v.live === true,
    status: v.status === 'working' || v.status === 'idle' ? v.status : undefined,
    activity: str(v.activity),
    lastText: str(v.lastText),
    lastError: str(v.lastError),
    costUsd: num(v.costUsd),
    contextPercent: num(v.contextPercent),
    createdAt: num(v.createdAt) ?? 0,
    lastActivityAt: num(v.lastActivityAt),
    exitedAt: num(v.exitedAt),
    closedAt: num(v.closedAt),
    subagentModels,
  }) as BoardThread;
}

/** `overseer.board` reply body; null when it has no sessionId. Bad thread entries are skipped. */
export function parseBoard(v: unknown): OverseerBoard | null {
  if (!isObj(v)) return null;
  const sessionId = str(v.sessionId);
  if (!sessionId) return null;
  const threads: BoardThread[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(v.threads) ? v.threads : []) {
    const t = parseBoardThread(raw);
    if (!t || seen.has(t.sessionId)) continue;
    seen.add(t.sessionId);
    threads.push(t);
  }
  return compact({ sessionId, name: str(v.name), threads });
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/** What a thread row says about it. `stalled`: working with no activity for a long while. */
export type ThreadState = 'working' | 'stalled' | 'idle' | 'error' | 'exited' | 'closed';

/** The overseer's own default for a stall warning (`watch.stallMinutes`). */
export const STALL_MS = 15 * 60_000;

/**
 * Live status beats registry state (as the hub counts): a live thread is working, stalled, error
 * or idle whatever its record says; one that is not live is closed (record closed) or exited.
 */
export function threadState(t: Pick<BoardThread, 'state' | 'live' | 'status' | 'lastError' | 'lastActivityAt'>, now: number): ThreadState {
  if (!t.live) return t.state === 'closed' ? 'closed' : 'exited';
  if (t.status === 'working') return t.lastActivityAt && now - t.lastActivityAt > STALL_MS ? 'stalled' : 'working';
  if (t.lastError) return 'error';
  return 'idle';
}

/** The thread's current tool as one line ("bash  npm test"). */
export function activityText(a: SessionSummary['activity']): string | undefined {
  if (!a) return undefined;
  return a.summary ? `${a.tool}  ${a.summary}` : a.tool;
}

const modelRef = (m: SessionSummary['model']): string | undefined => (m ? `${m.provider}/${m.id}` : undefined);

/** A live thread as a board row (hubs without `overseer.board`, or one the registry has not listed yet). */
export function threadFromSummary(s: SessionSummary): BoardThread {
  return compact({
    name: s.overseer?.thread || s.name,
    sessionId: s.sessionId,
    backend: (s.kind === 'headless' ? 'headless' : s.tmux ? 'tmux' : 'forca') as BoardBackend,
    cwd: s.cwd,
    model: modelRef(s.model),
    thinking: s.thinkingLevel,
    state: 'running' as const,
    live: true,
    status: s.status,
    activity: s.status === 'working' ? activityText(s.activity) : undefined,
    lastText: s.lastText,
    lastError: s.lastError,
    costUsd: s.usage?.costUsd,
    contextPercent: s.usage?.contextPercent,
    createdAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
  }) as BoardThread;
}

/** Live sessions that name `overseerId` as their overseer, oldest first. */
export function liveThreadsOf(sessions: Readonly<Record<string, SessionSummary>> | undefined, overseerId: string): SessionSummary[] {
  if (!sessions) return [];
  const out: SessionSummary[] = [];
  for (const s of Object.values(sessions)) if (s.kind !== 'subagent' && s.overseer?.sessionId === overseerId && s.sessionId !== overseerId) out.push(s);
  return out.sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId));
}

/**
 * The board to draw: the hub's (registry order) with each live thread's summary laid over it, so
 * a row changes the moment its session.upsert arrives instead of at the next poll; then live
 * threads the registry does not list yet. Without a board (older hub), the live threads alone.
 */
export function mergeBoard(
  board: OverseerBoard | null,
  sessions: Readonly<Record<string, SessionSummary>> | undefined,
  overseerId: string,
): BoardThread[] {
  const live = liveThreadsOf(sessions, overseerId);
  if (!board) return live.map(threadFromSummary);
  const out = board.threads.map((t) => {
    const s = sessions?.[t.sessionId];
    if (!s || s.kind === 'subagent') return t;
    const fresh = threadFromSummary(s);
    return compact({
      ...t,
      live: true,
      status: fresh.status,
      activity: fresh.activity,
      lastText: fresh.lastText ?? t.lastText,
      lastError: fresh.lastError,
      costUsd: fresh.costUsd ?? t.costUsd,
      contextPercent: fresh.contextPercent ?? t.contextPercent,
      lastActivityAt: fresh.lastActivityAt ?? t.lastActivityAt,
      model: fresh.model ?? t.model,
      thinking: fresh.thinking ?? t.thinking,
    }) as BoardThread;
  });
  const listed = new Set(board.threads.map((t) => t.sessionId));
  for (const s of live) if (!listed.has(s.sessionId)) out.push(threadFromSummary(s));
  return out;
}

export type BoardCounts = ThreadCounts & { stalled: number };

/** Counts as the rows show them (stalled split out of working). */
export function countBoard(threads: readonly BoardThread[], now: number): BoardCounts {
  const c: BoardCounts = { total: threads.length, working: 0, stalled: 0, idle: 0, error: 0, exited: 0, closed: 0 };
  for (const t of threads) c[threadState(t, now)] += 1;
  return c;
}

/** Live threads only, when the hub reports no counts (older hubs). */
export function countLive(threads: readonly SessionSummary[]): ThreadCounts | undefined {
  if (threads.length === 0) return undefined;
  const c: ThreadCounts = { total: threads.length, working: 0, idle: 0, error: 0, exited: 0, closed: 0 };
  for (const s of threads) {
    if (s.status === 'working') c.working += 1;
    else if (s.lastError) c.error += 1;
    else c.idle += 1;
  }
  return c;
}

export type CountSegment = { text: string; tone?: 'danger' | 'warning' | 'accent' };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * "4 threads · 2 working · 1 error": what needs a look, not every bucket. With nothing working
 * or failing it says how many are idle, or that they all ended.
 */
export function countSegments(c: ThreadCounts & { stalled?: number }): CountSegment[] {
  const out: CountSegment[] = [{ text: plural(c.total, 'thread') }];
  if (c.total === 0) return out;
  const stalled = c.stalled ?? 0;
  if (c.working) out.push({ text: `${c.working} working` });
  if (stalled) out.push({ text: `${stalled} stalled`, tone: 'warning' });
  if (c.error) out.push({ text: plural(c.error, 'error'), tone: 'danger' });
  if (!c.working && !stalled && !c.error) {
    if (c.idle) out.push({ text: `${c.idle} idle` });
    else out.push({ text: c.closed === c.total ? 'all closed' : 'ended' });
  }
  return out;
}

export const countsLine = (c: ThreadCounts & { stalled?: number }): string => countSegments(c).map((s) => s.text).join(' · ');

/** "$0.36"; null when unknown or nothing spent yet. */
export function formatCost(usd: number | undefined): string | null {
  if (usd === undefined || !Number.isFinite(usd) || usd <= 0) return null;
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/**
 * "Opus 5.5", "Sonnet 5", "Haiku 4.5", "Fast", "GPT-5.6" from a "provider/id[:level]" ref. Hubs
 * name models in models.list, but board rows and tool args carry only refs.
 */
export function prettyModel(ref: string | undefined): string {
  if (!ref) return '';
  const id = ref.replace(/:[a-z]+$/i, '').split('/').pop() ?? ref;
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i.exec(id);
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  if (/^gpt-/i.test(id)) return `GPT-${id.slice(4)}`;
  return id ? `${id[0].toUpperCase()}${id.slice(1)}` : ref;
}

/** "provider/id:level" → its level, if any. */
export function refThinking(ref: string | undefined): string | undefined {
  const m = ref ? /:([a-z]+)$/i.exec(ref) : null;
  return m ? m[1] : undefined;
}

/** Row meta: "Opus 5.5 · high". */
export function threadModelLabel(t: Pick<BoardThread, 'model' | 'thinking'>): string {
  const name = prettyModel(t.model);
  const level = t.thinking && t.thinking !== 'off' ? t.thinking : refThinking(t.model);
  return [name, level].filter(Boolean).join(' · ');
}

/** The thread's latest line: what it is doing, else why it failed, else its last reply. */
export function threadDetail(t: BoardThread, state: ThreadState): { text: string; tone: 'activity' | 'danger' | 'plain' } | null {
  if ((state === 'working' || state === 'stalled') && t.activity) return { text: t.activity, tone: 'activity' };
  if (state === 'error' && t.lastError) return { text: t.lastError, tone: 'danger' };
  if (t.lastText) return { text: t.lastText, tone: 'plain' };
  if (t.lastError) return { text: t.lastError, tone: 'danger' };
  return null;
}

const STATE_ORDER: Record<ThreadState, number> = { error: 0, stalled: 1, working: 2, idle: 3, exited: 4, closed: 5 };

/** The full board, grouped: what needs a look, running, then ended (registry order inside). */
export function boardGroups(threads: readonly BoardThread[], now: number): { key: string; title: string; threads: BoardThread[] }[] {
  const attention: BoardThread[] = [];
  const running: BoardThread[] = [];
  const exited: BoardThread[] = [];
  const closed: BoardThread[] = [];
  for (const t of threads) {
    const s = threadState(t, now);
    if (s === 'error' || s === 'stalled') attention.push(t);
    else if (s === 'working' || s === 'idle') running.push(t);
    else if (s === 'exited') exited.push(t);
    else closed.push(t);
  }
  running.sort((a, b) => STATE_ORDER[threadState(a, now)] - STATE_ORDER[threadState(b, now)]);
  return [
    { key: 'attention', title: 'Needs a look', threads: attention },
    { key: 'running', title: 'Running', threads: running },
    { key: 'exited', title: 'Exited', threads: exited },
    { key: 'closed', title: 'Closed', threads: closed },
  ].filter((g) => g.threads.length > 0);
}

/**
 * The pinned board's rows: threads that still run (exited and closed are in See all), the ones
 * that fail, stall or work first, then idle ones; registry order inside each.
 */
export function activeThreads(threads: readonly BoardThread[], now: number): BoardThread[] {
  const busy: BoardThread[] = [];
  const idle: BoardThread[] = [];
  for (const t of threads) {
    const s = threadState(t, now);
    if (s === 'idle') idle.push(t);
    else if (s !== 'exited' && s !== 'closed') busy.push(t);
  }
  return [...busy, ...idle];
}

/** The session id of a thread by its name (event and report rows name threads, not ids). */
export function threadIdByName(threads: readonly BoardThread[], name: string): string | undefined {
  const exact = threads.filter((t) => t.name === name);
  if (exact.length) return exact[exact.length - 1].sessionId;
  return threads.find((t) => t.sessionId === name || (name.length >= 6 && t.sessionId.startsWith(name)))?.sessionId;
}

// ---------------------------------------------------------------------------
// Nesting threads under their overseer (home, All sessions)
// ---------------------------------------------------------------------------

export type Nesting<T> = {
  /** Rows that are not a listed overseer's thread, in the input order. */
  top: T[];
  /** Overseer id → its listed threads, oldest first. */
  threads: Map<string, T[]>;
};

/**
 * Splits rows into top-level rows and threads nested under an overseer that is itself listed at
 * the top level. A thread whose overseer is not listed (or is itself someone's thread) stays at the
 * top level, where it says whose thread it is.
 */
export function nestUnderOverseers<T>(
  rows: readonly T[],
  idOf: (row: T) => string,
  linkOf: (row: T) => OverseerLink | undefined,
  createdAt: (row: T) => number,
): Nesting<T> {
  const ids = new Set(rows.map(idOf));
  // A row is nested when its overseer is listed and that overseer is not nested itself.
  const nestedIn = (row: T): string | null => {
    const parent = linkOf(row)?.sessionId;
    if (!parent || parent === idOf(row) || !ids.has(parent)) return null;
    const parentRow = rows.find((r) => idOf(r) === parent);
    const grand = parentRow ? linkOf(parentRow)?.sessionId : undefined;
    return grand && grand !== parent && ids.has(grand) ? null : parent;
  };
  const top: T[] = [];
  const threads = new Map<string, T[]>();
  for (const row of rows) {
    const parent = nestedIn(row);
    if (!parent) {
      top.push(row);
      continue;
    }
    const list = threads.get(parent);
    if (list) list.push(row);
    else threads.set(parent, [row]);
  }
  for (const list of threads.values()) list.sort((a, b) => createdAt(a) - createdAt(b) || idOf(a).localeCompare(idOf(b)));
  return { top, threads };
}

/** An overseer: the hub says so, or a listed session names it. */
export function isOverseerSession(s: Pick<SessionSummary, 'sessionId' | 'isOverseer' | 'threadCounts'>, threadsListed: number): boolean {
  return !!s.isOverseer || (s.threadCounts?.total ?? 0) > 0 || threadsListed > 0;
}

/** The caption of a thread whose overseer is not on screen: "Thread of Overseer · fix the API". */
export function threadOfCaption(link: OverseerLink | undefined): string | null {
  if (!link) return null;
  return `Thread of ${link.name?.trim() || 'an overseer'}`;
}

// ---------------------------------------------------------------------------
// Starting an overseer, adding a thread
// ---------------------------------------------------------------------------

export type ThreadModelChoice = 'opus-high' | 'opus-xhigh' | 'fast-max' | 'same';
export type ThreadWindow = 'auto' | 'headless';
export type OverseerDefaults = { threadModel: ThreadModelChoice; window: ThreadWindow; maxThreads: number };

export const DEFAULT_OVERSEER: OverseerDefaults = { threadModel: 'opus-high', window: 'auto', maxThreads: 4 };
export const MAX_THREADS_MIN = 1;
export const MAX_THREADS_MAX = 12;

export const THREAD_MODELS: readonly { key: ThreadModelChoice; label: string; ref?: string; thinking?: string }[] = [
  { key: 'opus-high', label: 'Opus 5.5 · high', ref: 'anthropic/claude-opus-5-5', thinking: 'high' },
  { key: 'opus-xhigh', label: 'Opus 5.5 · xhigh', ref: 'anthropic/claude-opus-5-5', thinking: 'xhigh' },
  { key: 'fast-max', label: 'Fast · max', ref: 'example/fast', thinking: 'max' },
  { key: 'same', label: 'Same as overseer' },
];

export const THREAD_WINDOWS: readonly { key: ThreadWindow; label: string; detail: string }[] = [
  { key: 'auto', label: 'Auto', detail: 'A FORCA tab or tmux window when there is one' },
  { key: 'headless', label: 'No window', detail: 'Headless; still on this iPhone' },
];

/** Defensive parse of a stored `Prefs.overseer`; undefined when nothing usable is left. */
export function parseOverseerDefaults(raw: unknown): OverseerDefaults | undefined {
  if (!isObj(raw)) return undefined;
  const threadModel = THREAD_MODELS.find((m) => m.key === raw.threadModel)?.key;
  const window = THREAD_WINDOWS.find((w) => w.key === raw.window)?.key;
  const max = typeof raw.maxThreads === 'number' && Number.isInteger(raw.maxThreads) ? raw.maxThreads : undefined;
  if (!threadModel && !window && max === undefined) return undefined;
  return {
    threadModel: threadModel ?? DEFAULT_OVERSEER.threadModel,
    window: window ?? DEFAULT_OVERSEER.window,
    maxThreads: Math.min(MAX_THREADS_MAX, Math.max(MAX_THREADS_MIN, max ?? DEFAULT_OVERSEER.maxThreads)),
  };
}

/** "Opus 5.5 · high · Auto · up to 4" (the New-thread defaults pill). */
export function describeOverseerDefaults(d: OverseerDefaults): string {
  const model = THREAD_MODELS.find((m) => m.key === d.threadModel)?.label ?? '';
  const window = d.window === 'headless' ? 'No window' : 'Auto window';
  return `${model} · ${window} · up to ${d.maxThreads}`;
}

/** The overseer's own model, for "same as overseer" (null = the computer's default). */
export type OverseerModel = { provider: string; id: string; thinkingLevel?: string | null } | null;

/** The defaults in plain words, one line each (appended to the overseer prompt and to "Start a new thread"). */
export function defaultsLines(d: OverseerDefaults, overseer: OverseerModel = null): string[] {
  const choice = THREAD_MODELS.find((m) => m.key === d.threadModel);
  let model: string;
  if (choice?.ref) model = `Thread model: ${choice.ref} with thinking ${choice.thinking} ("${choice.ref}:${choice.thinking}").`;
  else if (overseer) {
    const ref = `${overseer.provider}/${overseer.id}`;
    model = `Thread model: the same as yours, ${ref}${overseer.thinkingLevel ? ` with thinking ${overseer.thinkingLevel}` : ''}.`;
  } else model = 'Thread model: the same as yours.';
  return [
    model,
    d.window === 'headless'
      ? 'Thread window: headless (backend "headless", no terminal window).'
      : 'Thread window: auto (backend "auto": a FORCA tab or tmux window when there is one).',
    "Subagent models: pin each thread's subagentModels to the overseer skill's policy for its model.",
    `At most ${plural(d.maxThreads, 'thread')} at a time.`,
  ];
}

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** The spawned overseer's session name: "Overseer · <goal, first ~40 chars>". */
export function overseerName(goal: string): string {
  const g = oneLine(goal, 40);
  return g ? `Overseer · ${g}` : 'Overseer';
}

/**
 * The slash command that invokes the overseer skill on that computer (`skill:overseer`, or an
 * `overseer` command), from a commands.list; null when it lists none.
 */
export function overseerCommand(commands: readonly CommandInfo[]): string | null {
  return commands.find((c) => c.name === 'skill:overseer')?.name ?? commands.find((c) => c.name === 'overseer')?.name ?? null;
}

export const PLAIN_OVERSEER_LEAD = 'Act as overseer (use the overseer tool): ';

function defaultsBlock(d: OverseerDefaults, overseer: OverseerModel): string {
  return ['Defaults for the threads you start:', ...defaultsLines(d, overseer).map((l) => `- ${l}`)].join('\n');
}

/** The first prompt of an overseer started from the phone. */
export function overseerPrompt(input: { goal: string; defaults: OverseerDefaults; command: string | null; overseer?: OverseerModel }): string {
  const goal = input.goal.trim();
  const lead = input.command ? `/${input.command} ${goal}` : `${PLAIN_OVERSEER_LEAD}${goal}`;
  return `${lead}\n\n${defaultsBlock(input.defaults, input.overseer ?? null)}`;
}

/** "Add thread" on an existing overseer: a normal prompt (mode auto). */
export function addThreadPrompt(description: string, defaults: OverseerDefaults, overseer: OverseerModel = null): string {
  return `Start a new thread: ${description.trim()}\n\n${defaultsBlock(defaults, overseer)}`;
}

// ---------------------------------------------------------------------------
// Transcript: `overseer` tool calls, `overseer_event` messages, thread reports
// ---------------------------------------------------------------------------

export type OverseerCall = {
  action: string;
  /** The thread it is about (name), when there is one. */
  thread?: string;
  /** The thread's session id, when the result says it (spawn, resume, adopt). */
  sessionId?: string;
  /** "Started api-filters". */
  title: string;
  /** "Opus 5.5 high · No window". */
  meta?: string;
  /** The prompt or message sent. */
  text?: string;
  /** Folds into "Worked for" with the turn's other tools (read, list, watch). */
  folded: boolean;
  running: boolean;
  failed: boolean;
  /** First line of a failure. */
  error?: string;
};

const FOLDED = new Set(['read', 'list', 'watch']);

function quotedName(output: string | undefined): string | undefined {
  const m = output ? /"([^"\n]{1,200})"/.exec(output) : null;
  return m ? m[1] : undefined;
}

function resultSessionId(output: string | undefined): string | undefined {
  const m = output ? /"[^"\n]*" \(([0-9A-Za-z~_-]{6,})[,)]/.exec(output) : null;
  return m ? m[1] : undefined;
}

/** "headless pid 56444" → "No window"; "forca tab 3" → "FORCA tab"; "tmux phi-x" → "tmux". */
function windowLabel(backend: string | undefined): string | undefined {
  if (!backend) return undefined;
  const b = backend.trim().toLowerCase();
  if (b.startsWith('headless')) return 'No window';
  if (b.startsWith('forca')) return 'FORCA tab';
  if (b.startsWith('tmux')) return 'tmux';
  return undefined;
}

/** "Opus 5.5 high" from "provider/id[:level]" and/or a level. */
export function callModelLabel(model: string | undefined, thinking: string | undefined): string | undefined {
  if (!model) return undefined;
  const level = thinking ?? refThinking(model);
  return [prettyModel(model), level].filter(Boolean).join(' ');
}

/** An `overseer` tool call as a card; null for any other tool. */
export function overseerCall(item: Pick<ToolItem, 'name' | 'args' | 'status' | 'output'>): OverseerCall | null {
  if (item.name !== 'overseer') return null;
  const args: Obj = isObj(item.args) ? item.args : {};
  const action = str(args.action) ?? 'overseer';
  const running = item.status === 'running';
  const failed = item.status === 'error';
  const output = item.output;
  const target = str(args.target)?.trim();
  const named = str(args.name)?.trim();
  // Results quote the thread's name; a target may be a session id or prefix.
  const thread = (failed ? undefined : quotedName(output)) ?? named ?? target;
  const error = failed && output ? output.trim().split('\n', 1)[0] : undefined;
  const base = { action, thread, running, failed, error, folded: FOLDED.has(action) };
  const who = thread ?? 'a thread';
  switch (action) {
    case 'spawn': {
      const line = output?.split('\n', 1)[0] ?? '';
      const segs = line.split(' · ');
      const fromResult = /^Started thread /.test(line) ? segs : [];
      const model = callModelLabel(str(args.model), str(args.thinking)) ?? callModelLabel(fromResult[2]?.trim(), undefined);
      const window = windowLabel(fromResult[1]) ?? windowLabel(str(args.backend));
      return {
        ...base,
        thread: named ?? thread,
        sessionId: resultSessionId(output),
        title: `${running ? 'Starting' : failed ? 'Could not start' : 'Started'} ${named ?? who}`,
        meta: [model, window].filter(Boolean).join(' · ') || undefined,
        text: str(args.prompt),
      };
    }
    case 'send':
      return { ...base, title: `${failed ? 'Could not send to' : 'Sent to'} ${who}`, text: str(args.message) };
    case 'close':
      return { ...base, title: `${running ? 'Closing' : failed ? 'Could not close' : 'Closed'} ${who}` };
    case 'read':
      return { ...base, title: `Read ${who}` };
    case 'list':
      return { ...base, thread: undefined, title: args.all === true ? 'Checked every session' : 'Checked the threads' };
    case 'abort':
      return { ...base, title: `${failed ? 'Could not stop' : 'Stopped'} ${who}` };
    case 'model': {
      const model = callModelLabel(str(args.model), str(args.thinking));
      return { ...base, title: model ? `Switched ${who} to ${model}` : `Changed the model of ${who}` };
    }
    case 'resume':
      return { ...base, sessionId: resultSessionId(output), title: `${running ? 'Resuming' : failed ? 'Could not resume' : 'Resumed'} ${who}`, text: str(args.prompt) };
    case 'adopt':
      return { ...base, sessionId: resultSessionId(output), title: `${failed ? 'Could not adopt' : 'Adopted'} ${who}` };
    case 'watch':
      return { ...base, title: target === 'all' ? 'Changed how it watches every thread' : `Changed how it watches ${who}` };
    default:
      return { ...base, title: `Overseer ${action}` };
  }
}

/** Overseer cards that stay out of the "Worked for" fold (they are what the overseer did). */
export function isVisibleOverseerCall(item: Pick<ToolItem, 'name' | 'args' | 'status' | 'output'>): boolean {
  const call = overseerCall(item);
  return !!call && !call.folded;
}

export type OverseerEventKind = 'idle' | 'error' | 'stalled' | 'exited' | 'heartbeat';
export type OverseerEvent = { thread: string; kind: OverseerEventKind; summary?: string; text?: string };

export const OVERSEER_EVENT_LABEL = 'overseer_event';

const EVENT_LINE = /^── (.+?) · (idle|error|stalled|exited)(?: · (.*))?$/;
const HEARTBEAT_LINE = /^(?:── |\[overseer\] )heartbeat(?: · (.*))?$/;
const REPLY_HINT = /^Reply with (?:overseer|agent_message) /;

/** The thread updates of one batched `overseer_event` message; null for any other note. */
export function overseerEvents(note: Pick<NoteItem, 'label' | 'text'>): OverseerEvent[] | null {
  if (note.label !== OVERSEER_EVENT_LABEL) return null;
  const events: OverseerEvent[] = [];
  let cur: OverseerEvent | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (!cur) return;
    const text = lines.join('\n').trim();
    if (text) cur.text = text;
    events.push(cur);
    cur = null;
    lines = [];
  };
  for (const raw of note.text.split('\n')) {
    const line = raw.trimEnd();
    const hb = HEARTBEAT_LINE.exec(line);
    const ev = hb ? null : EVENT_LINE.exec(line);
    if (hb || ev) {
      flush();
      cur = hb
        ? compact({ thread: '', kind: 'heartbeat' as const, summary: hb[1]?.trim() || undefined })
        : compact({ thread: ev![1].trim(), kind: ev![2] as OverseerEventKind, summary: ev![3]?.trim() || undefined });
      continue;
    }
    if (/^\[overseer\]/.test(line) || REPLY_HINT.test(line)) {
      if (REPLY_HINT.test(line)) flush();
      continue;
    }
    if (cur) lines.push(raw);
  }
  flush();
  return events;
}

const MODEL_REF = /\b([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9._-]*)(?::([a-z]+))?/gi;

/**
 * An update's summary in the app's words: "finished · Fast xhigh · $0.21", "error · Opus 5.5",
 * "quiet for 15m", "exited"; a heartbeat keeps its own ("3 threads (1 working)").
 */
export function eventSummary(e: Pick<OverseerEvent, 'kind' | 'summary'>): string {
  const raw = e.summary?.trim() ?? '';
  const pretty = (text: string) => text.replace(MODEL_REF, (_m, provider: string, id: string, level?: string) => callModelLabel(`${provider}/${id}`, level) ?? `${provider}/${id}`);
  switch (e.kind) {
    case 'idle':
      return raw ? pretty(raw.replace(/^turn finished\b/, 'finished')) : 'finished';
    case 'error': {
      const model = /\(([^()]+)\)\s*$/.exec(raw)?.[1];
      return model && /^[a-z0-9][a-z0-9_-]*\/[a-z0-9]/i.test(model) ? `error · ${pretty(model)}` : 'error';
    }
    case 'stalled': {
      const quiet = /no activity for (\S+)/.exec(raw)?.[1];
      return quiet ? `quiet for ${quiet}` : 'stalled';
    }
    case 'exited':
      return 'exited';
    case 'heartbeat':
      return raw || 'heartbeat';
  }
}

export type ThreadReport = { thread: string; kind: string; message: string };

const REPORT_LINE = /^\[thread (.+?) · ([a-z]+)\] ?/m;

/** A thread's `report_to_overseer` (agent mail "[thread <name> · <kind>] …"); null otherwise. */
export function threadReport(note: Pick<NoteItem, 'label' | 'text'>): ThreadReport | null {
  if (note.label && note.label !== 'agent_mail') return null;
  const m = REPORT_LINE.exec(note.text);
  if (!m) return null;
  const body = note.text.slice(m.index + m[0].length).split('\n');
  // The receiving side appends one "Reply with …" hint line; it is for the model, not for you.
  while (body.length && !body[body.length - 1].trim()) body.pop();
  if (body.length && REPLY_HINT.test(body[body.length - 1].trim())) body.pop();
  return { thread: m[1].trim(), kind: m[2], message: body.join('\n').trim() };
}
