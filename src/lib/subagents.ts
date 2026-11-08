/**
 * Subagents (protocol "Subagents (v1 addition)"), pure presentation logic.
 *
 * A phi session launches parallel worker agents with its `subagent` tool. Hubs that know the
 * app's `subagents` feature report each worker as its own session (`kind: "subagent"`) linked to
 * the parent by `parentSessionId` and to the launching tool call by `subagent.toolCallId` +
 * `subagent.index`. Everything here works from the tool item's args alone too (older hubs,
 * or before the child sessions arrive), so the card never waits on the hub.
 */

import { formatDuration } from './format';
import type { Activity, SessionStatus, ToolItem, TranscriptItem } from './protocol';

/** Lifecycle of one subagent run. */
export type SubagentRunStatus = 'running' | 'done' | 'failed' | 'killed';

/** `SessionSummary.subagent`: what the hub knows about one subagent run. */
export type SubagentInfo = {
  runId: string;
  /** The parent's `subagent` tool call that launched this run. */
  toolCallId?: string;
  /** Position in that call's task list (0-based). */
  index?: number;
  name?: string;
  agent?: string;
  task: string;
  status: SubagentRunStatus;
  startedAt: number;
  endedAt?: number;
  turns?: number;
  toolCalls?: number;
  background?: boolean;
};

/** `SessionSummary.subagents` on a parent: how many of its subagents run, of how many. */
export type SubagentCounts = { running: number; total: number };

/** The fields of a child session summary this module reads (a `SessionSummary` fits). */
export type SubagentChild = {
  sessionId: string;
  name: string;
  status: SessionStatus;
  model?: { provider: string; id: string; name?: string };
  activity?: Activity;
  lastText?: string;
  startedAt?: number;
  parentSessionId?: string;
  subagent?: SubagentInfo;
};

const RUN_STATUSES: readonly SubagentRunStatus[] = ['running', 'done', 'failed', 'killed'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const count = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n >= 0 ? Math.floor(n) : undefined;
};

/** Validates `SessionSummary.subagent`; null when it is not usable (no runId / task / status). */
export function parseSubagentInfo(v: unknown): SubagentInfo | null {
  if (!isObj(v) || !str(v.runId)) return null;
  const status = RUN_STATUSES.includes(v.status as SubagentRunStatus) ? (v.status as SubagentRunStatus) : null;
  if (!status) return null;
  const info: SubagentInfo = {
    runId: str(v.runId)!,
    task: typeof v.task === 'string' ? v.task : '',
    status,
    startedAt: num(v.startedAt) ?? 0,
  };
  const toolCallId = str(v.toolCallId);
  if (toolCallId) info.toolCallId = toolCallId;
  const index = count(v.index);
  if (index !== undefined) info.index = index;
  const name = str(v.name);
  if (name) info.name = name;
  const agent = str(v.agent);
  if (agent) info.agent = agent;
  const endedAt = num(v.endedAt);
  if (endedAt !== undefined) info.endedAt = endedAt;
  const turns = count(v.turns);
  if (turns !== undefined) info.turns = turns;
  const toolCalls = count(v.toolCalls);
  if (toolCalls !== undefined) info.toolCalls = toolCalls;
  if (typeof v.background === 'boolean') info.background = v.background;
  return info;
}

/** Validates `SessionSummary.subagents`. */
export function parseSubagentCounts(v: unknown): SubagentCounts | undefined {
  if (!isObj(v)) return undefined;
  const total = count(v.total);
  const running = count(v.running);
  if (total === undefined || running === undefined) return undefined;
  return { running: Math.min(running, total), total };
}

/** Validates `SessionSummary.tmux`. */
export function parseTmux(v: unknown): { session: string; window?: string } | undefined {
  if (!isObj(v)) return undefined;
  const session = str(v.session);
  if (!session) return undefined;
  const window = str(v.window) ?? (typeof v.window === 'number' && Number.isFinite(v.window) ? String(v.window) : undefined);
  return window ? { session, window } : { session };
}

// ---------------------------------------------------------------------------
// The launching tool call
// ---------------------------------------------------------------------------

/** One task of a `subagent` tool call, as the parent asked for it. */
export type SubagentTask = { index: number; name: string; agent?: string; model?: string; task: string };

export type SubagentLaunch = {
  tasks: SubagentTask[];
  /** `background` from the args; undefined when not said (phi's default depends on the session). */
  background?: boolean;
};

/** `provider/model-id:level` → `model-id` (the args carry phi's model reference). */
export function shortModelRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const id = ref.slice(ref.lastIndexOf('/') + 1).replace(/:[a-z]+$/i, '');
  return id || undefined;
}

function parseArgs(args: unknown): Obj {
  if (isObj(args)) return args;
  if (typeof args === 'string') {
    try {
      const parsed: unknown = JSON.parse(args);
      if (isObj(parsed)) return parsed;
    } catch {
      // Truncated or not JSON: fall back to the summary.
    }
  }
  return {};
}

const firstLine = (text: string, max = 60): string | undefined => {
  const line = text.split('\n').find((l) => l.trim())?.trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function taskOf(raw: unknown, index: number): SubagentTask | null {
  if (!isObj(raw)) return null;
  const agent = str(raw.agent);
  const text = typeof raw.task === 'string' ? raw.task.trim() : '';
  const task: SubagentTask = {
    index,
    // phi's display name: the task's name, else its agent, else the task's first line.
    name: str(raw.name) ?? agent ?? firstLine(text) ?? `task-${index + 1}`,
    task: text,
  };
  if (agent) task.agent = agent;
  const model = shortModelRef(str(raw.model));
  if (model) task.model = model;
  return task;
}

/**
 * Names from a launch summary — "3 subagents: ws-a, ws-b, scout", "2 subagents (chain): plan →
 * build", "1 subagent: x" — or null for any other summary ("subagent  status", "… kill ws-a").
 */
function namesFromSummary(summary: string): string[] | null {
  const m = /^\d+ subagents?( \(chain\))?: (.+)$/.exec(summary.trim());
  if (!m) return null;
  return m[2]
    .split(m[1] ? ' → ' : ', ')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A name repeated within one call gets " #2", " #3" (as phi names the sessions). */
function numberRepeats(tasks: SubagentTask[]): SubagentTask[] {
  const seen = new Map<string, number>();
  return tasks.map((t) => {
    const n = (seen.get(t.name) ?? 0) + 1;
    seen.set(t.name, n);
    return n > 1 ? { ...t, name: `${t.name} #${n}` } : t;
  });
}

/**
 * The tasks a `subagent` tool item launched, or null when the item is not a launch (another
 * tool, or `action: "status" | "kill"`). Tasks come from `tasks`, `chain` or the single-task
 * form of the args; a summary like "3 subagents: ws-a, ws-b" is the last resort.
 */
export function subagentLaunch(item: Pick<ToolItem, 'name' | 'args' | 'summary'>): SubagentLaunch | null {
  if (!/^subagents?$/i.test(item.name)) return null;
  const args = parseArgs(item.args);
  const action = str(args.action);
  if (action && action !== 'run') return null;
  const list = Array.isArray(args.tasks) ? args.tasks : Array.isArray(args.chain) ? args.chain : null;
  let tasks: SubagentTask[] = [];
  if (list) {
    list.forEach((raw, i) => {
      const t = taskOf(raw, i);
      if (t) tasks.push(t);
    });
  } else if (typeof args.task === 'string') {
    const t = taskOf(args, 0);
    if (t) tasks = [t];
  } else {
    // No usable args: only a launch summary makes this a launch.
    const names = namesFromSummary(item.summary);
    if (!names) return null;
    return { tasks: names.map((name, index) => ({ index, name, task: '' })) };
  }
  tasks = numberRepeats(tasks);
  const launch: SubagentLaunch = { tasks };
  if (typeof args.background === 'boolean') launch.background = args.background;
  return launch;
}

// ---------------------------------------------------------------------------
// Card rows
// ---------------------------------------------------------------------------

/** `unknown`: launched in the background on a hub that does not report subagents. */
export type SubagentRowStatus = SubagentRunStatus | 'unknown';

export type SubagentRow = {
  key: string;
  index: number;
  name: string;
  agent?: string;
  /** Display model: the child's model name, else the args' model id. */
  model?: string;
  task: string;
  status: SubagentRowStatus;
  /** The child session, when the hub reports it (the row then opens its thread). */
  sessionId?: string;
  startedAt?: number;
  endedAt?: number;
  turns?: number;
  toolCalls?: number;
  /** The child is mid-turn (streaming or running a tool). */
  working: boolean;
  activity?: Activity;
  lastText?: string;
};

/** The model's name, else its id alone (`provider` may be "" when only an id is known). */
function modelName(model: SubagentChild['model']): string | undefined {
  if (!model) return undefined;
  if (model.name) return model.name;
  return model.id.slice(model.id.lastIndexOf('/') + 1) || undefined;
}

/** A row for a child session (with or without the task it came from). */
export function rowFromChild(child: SubagentChild, task?: SubagentTask): SubagentRow {
  const info = child.subagent;
  const row: SubagentRow = {
    key: `child:${child.sessionId}`,
    index: info?.index ?? task?.index ?? 0,
    // The summary name is the display name (name, else agent, else first line; repeats "#2").
    name: child.name || info?.name || task?.name || 'subagent',
    task: info?.task || task?.task || '',
    status: info?.status ?? 'running',
    sessionId: child.sessionId,
    working: child.status === 'working',
  };
  const agent = info?.agent ?? task?.agent;
  if (agent) row.agent = agent;
  const model = modelName(child.model) ?? task?.model;
  if (model) row.model = model;
  const startedAt = info?.startedAt || child.startedAt;
  if (startedAt) row.startedAt = startedAt;
  if (info?.endedAt !== undefined) row.endedAt = info.endedAt;
  if (info?.turns !== undefined) row.turns = info.turns;
  if (info?.toolCalls !== undefined) row.toolCalls = info.toolCalls;
  if (child.activity && row.status === 'running') row.activity = child.activity;
  if (child.lastText) row.lastText = child.lastText;
  return row;
}

/** What an args-only row can say from the tool item alone. */
function statusFromTool(item: Pick<ToolItem, 'status' | 'output'>, background: boolean | undefined): SubagentRowStatus {
  if (item.status === 'running') return 'running';
  if (item.status === 'error') return 'failed';
  // An "ok" background launch only means the runs started.
  const launchedInBackground = background ?? /\bin the background\b/i.test(item.output ?? '');
  return launchedInBackground ? 'unknown' : 'done';
}

const byIndexThenStart = (a: SubagentChild, b: SubagentChild) =>
  (a.subagent?.index ?? Infinity) - (b.subagent?.index ?? Infinity) ||
  (a.subagent?.startedAt ?? 0) - (b.subagent?.startedAt ?? 0) ||
  a.sessionId.localeCompare(b.sessionId);

/**
 * One row per subagent of a `subagent` tool item: each task from the args, matched to its child
 * session by `toolCallId` + `index` (else by name), plus children of that call the args do not
 * mention (truncated args). Null when the item is not a launch.
 */
export function subagentRows(item: ToolItem, children: readonly SubagentChild[]): SubagentRow[] | null {
  const launch = subagentLaunch(item);
  if (!launch) return null;
  const linked = children.filter((c) => c.subagent && c.subagent.toolCallId === item.toolCallId).sort(byIndexThenStart);
  const used = new Set<string>();
  const take = (c: SubagentChild | undefined) => {
    if (c) used.add(c.sessionId);
    return c;
  };
  // Once the hub reports children for this call, a task without one is simply not reported.
  const fallback: SubagentRowStatus = item.status !== 'running' && linked.length > 0 ? 'unknown' : statusFromTool(item, launch.background);
  const rows: SubagentRow[] = [];
  for (const task of launch.tasks) {
    const child =
      take(linked.find((c) => !used.has(c.sessionId) && c.subagent?.index === task.index)) ??
      take(linked.find((c) => !used.has(c.sessionId) && c.subagent?.index === undefined && c.name === task.name));
    if (child) {
      rows.push(rowFromChild(child, task));
      continue;
    }
    const row: SubagentRow = {
      key: `task:${item.toolCallId}:${task.index}`,
      index: task.index,
      name: task.name,
      task: task.task,
      status: fallback,
      working: false,
    };
    if (task.agent) row.agent = task.agent;
    if (task.model) row.model = task.model;
    rows.push(row);
  }
  for (const child of linked) if (!used.has(child.sessionId)) rows.push(rowFromChild(child));
  return rows;
}

/** A parent's subagent sessions (any launch), oldest first. */
export function childrenOf<T extends SubagentChild>(sessions: Readonly<Record<string, T>> | undefined, parentSessionId: string): T[] {
  if (!sessions) return [];
  const out: T[] = [];
  for (const s of Object.values(sessions)) if (s.subagent && s.parentSessionId === parentSessionId) out.push(s);
  return out.sort((a, b) => (a.subagent?.startedAt ?? 0) - (b.subagent?.startedAt ?? 0) || byIndexThenStart(a, b));
}

/**
 * Every subagent of a parent for a list: one group per launch in the transcript (newest first),
 * then children whose launch is not loaded (older history) as rows of their own.
 */
export function subagentGroups(
  items: readonly TranscriptItem[],
  children: readonly SubagentChild[],
): { key: string; ts: number; rows: SubagentRow[] }[] {
  const groups: { key: string; ts: number; rows: SubagentRow[] }[] = [];
  const shown = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'tool') continue;
    const rows = subagentRows(item, children);
    if (!rows || rows.length === 0) continue;
    for (const r of rows) if (r.sessionId) shown.add(r.sessionId);
    groups.push({ key: item.toolCallId, ts: item.ts, rows });
  }
  groups.reverse();
  const rest = children.filter((c) => !shown.has(c.sessionId)).map((c) => rowFromChild(c));
  if (rest.length) groups.push({ key: 'other', ts: 0, rows: rest });
  return groups;
}

// ---------------------------------------------------------------------------
// Counts and labels
// ---------------------------------------------------------------------------

export type RowCounts = { running: number; done: number; failed: number; killed: number; unknown: number; total: number };

export function countRows(rows: readonly Pick<SubagentRow, 'status'>[]): RowCounts {
  const c: RowCounts = { running: 0, done: 0, failed: 0, killed: 0, unknown: 0, total: rows.length };
  for (const r of rows) c[r.status] += 1;
  return c;
}

/** Card header counts: "3 running · 1 done · 1 failed · 1 stopped" (zeros left out). */
export function countsLabel(c: RowCounts): string {
  const parts: string[] = [];
  if (c.running) parts.push(`${c.running} running`);
  if (c.done) parts.push(`${c.done} done`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.killed) parts.push(`${c.killed} stopped`);
  return parts.join(' · ');
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Counts for a parent: the hub's `subagents` when present, else counted from its children. */
export function parentCounts(
  reported: SubagentCounts | undefined,
  children: readonly Pick<SubagentChild, 'subagent'>[],
): SubagentCounts | undefined {
  if (reported) return reported.total > 0 ? reported : undefined;
  const own = children.filter((c) => c.subagent);
  if (own.length === 0) return undefined;
  return { running: own.filter((c) => c.subagent!.status === 'running').length, total: own.length };
}

/**
 * Counts for every parent on a host: the hub's `subagents` field, else counted from the
 * subagent sessions it reported. Parents without subagents are left out.
 */
export function countsByParent(
  sessions: Readonly<Record<string, SubagentChild & { subagents?: SubagentCounts }>> | undefined,
): Map<string, SubagentCounts> {
  const out = new Map<string, SubagentCounts>();
  if (!sessions) return out;
  const own = new Map<string, SubagentChild[]>();
  for (const s of Object.values(sessions)) {
    if (!s.subagent || !s.parentSessionId) continue;
    const list = own.get(s.parentSessionId);
    if (list) list.push(s);
    else own.set(s.parentSessionId, [s]);
  }
  for (const s of Object.values(sessions)) {
    if (s.subagent) continue;
    const c = parentCounts(s.subagents, own.get(s.sessionId) ?? []);
    if (c) out.set(s.sessionId, c);
  }
  return out;
}

/** Home row meta for a parent: "2 subagents running", or "4 subagents" once all are done. */
export function subagentsMeta(counts: SubagentCounts | undefined): { label: string; running: boolean } | null {
  if (!counts || counts.total <= 0) return null;
  if (counts.running > 0) return { label: `${plural(counts.running, 'subagent')} running`, running: true };
  return { label: plural(counts.total, 'subagent'), running: false };
}

/** Elapsed run time: ticking while running, fixed once ended; null when unknown. */
export function subagentElapsed(
  run: Pick<SubagentRow, 'startedAt' | 'endedAt' | 'status'>,
  now: number,
): string | null {
  if (!run.startedAt) return null;
  const end = run.status === 'running' ? now : run.endedAt;
  if (end === undefined) return null;
  return formatDuration(Math.max(0, end - run.startedAt));
}

/** "6 turns · 14 tool calls" (either part left out when unknown). */
export function subagentStats(run: Pick<SubagentRow, 'turns' | 'toolCalls'>): string {
  const parts: string[] = [];
  if (run.turns !== undefined) parts.push(plural(run.turns, 'turn'));
  if (run.toolCalls !== undefined) parts.push(plural(run.toolCalls, 'tool call'));
  return parts.join(' · ');
}

export function statusWord(status: SubagentRowStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'killed':
      return 'Stopped';
    default:
      return '';
  }
}

/** The quiet footer that replaces a finished subagent's composer: "Finished · 3m 12s · 14 tool calls". */
export function subagentFooter(info: Pick<SubagentInfo, 'status' | 'startedAt' | 'endedAt' | 'toolCalls'>): {
  title: string;
  text: string;
  tone: 'secondary' | 'danger';
} {
  const title = info.status === 'failed' ? 'Failed' : info.status === 'killed' ? 'Stopped' : 'Finished';
  const elapsed = info.status === 'running' ? null : subagentElapsed(info, 0);
  const parts = [title];
  if (elapsed) parts.push(elapsed);
  if (info.toolCalls !== undefined) parts.push(plural(info.toolCalls, 'tool call'));
  return { title, text: parts.join(' · '), tone: info.status === 'failed' ? 'danger' : 'secondary' };
}

// ---------------------------------------------------------------------------
// Subagent threads
// ---------------------------------------------------------------------------

/** A subagent thread's title: the summary name (phi's display name for the run). */
export function subagentTitle(child: Pick<SubagentChild, 'name' | 'subagent'>): string {
  return child.name || child.subagent?.name || 'Subagent';
}

/** Id of a subagent transcript's first item: the task it was given. */
export const TASK_ITEM_ID = 'u:task';
const PARENT_PREFIX = '[message from your parent agent]';

/** A `user` item that is a message from the parent agent: its text without the prefix, else null. */
export function parentMessageText(text: string): string | null {
  if (!text.startsWith(PARENT_PREFIX)) return null;
  return text.slice(PARENT_PREFIX.length).trim();
}

/** A refused steer, said plainly (the draft is kept). */
export function steerErrorText(name: string, message: string): string {
  if (/not accepting messages yet/i.test(message)) return `${name} is not accepting messages yet. Try again in a moment.`;
  if (/subagent finished/i.test(message)) return `${name} has finished.`;
  return message;
}

/** "Subagent of <parent> · <model>". */
export function subagentSubtitle(parentTitle: string | null, model: string | null | undefined): string {
  const head = parentTitle ? `Subagent of ${parentTitle}` : 'Subagent';
  return model ? `${head} · ${model}` : head;
}

/** Composer placeholder while a subagent runs. */
export function steerPlaceholder(name: string): string {
  return `Steer ${name}…`;
}

/**
 * The hub's subagent session ids look like `<parent>~sa~<runId>`. Ids are opaque: this is only
 * a display hint for a thread whose summary is already gone.
 */
export function looksLikeSubagentId(sessionId: string): boolean {
  return sessionId.includes('~sa~');
}

/** `tmux attach` command for a session that runs inside tmux. */
export function tmuxAttachCommand(tmux: { session: string; window?: string }): string {
  const target = tmux.window ? `${tmux.session}:${tmux.window}` : tmux.session;
  return /^[\w.:@%+-]+$/.test(target) ? `tmux attach -t ${target}` : `tmux attach -t '${target.replace(/'/g, `'\\''`)}'`;
}
