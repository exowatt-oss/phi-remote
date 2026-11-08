/**
 * Slash commands in the composer (protocol "Slash commands (v1 addition)"): the trigger at the
 * caret, ranking, display labels, insertion, Return/space completion, composer highlighting
 * and the leading-command split the user bubble renders as a pill. Pure functions only.
 *
 * The trigger rules (a `/` token at the caret, path words excluded), range replacement and the
 * search scoring are adapted from T3 Code (MIT): packages/shared/src/composerTrigger.ts,
 * packages/shared/src/searchRanking.ts and
 * apps/mobile/src/features/threads/composerSlashSkillSearch.ts. See THIRD_PARTY_NOTICES.md.
 */

import type { CommandInfo, CommandSource } from './protocol';

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const SKILL_PREFIX = 'skill:';

/** What the menu shows after the slash: skills drop their `skill:` prefix (`use-subs`). */
export function commandLabel(command: Pick<CommandInfo, 'name' | 'source'>): string {
  if (command.source === 'skill' && command.name.startsWith(SKILL_PREFIX) && command.name.length > SKILL_PREFIX.length) {
    return command.name.slice(SKILL_PREFIX.length);
  }
  return command.name;
}

/** The subtle tag on each menu row. Built-in and extension commands are both "Command". */
export const SOURCE_TAG: Record<CommandSource, string> = {
  builtin: 'Command',
  extension: 'Command',
  skill: 'Skill',
  prompt: 'Prompt',
};

/** Order of the unfiltered menu: the most useful first. */
const EMPTY_QUERY_RANK: Record<CommandSource, number> = { builtin: 0, skill: 1, prompt: 2, extension: 3 };

// ---------------------------------------------------------------------------
// Trigger at the caret
// ---------------------------------------------------------------------------

export type Selection = { start: number; end: number };

export type SlashTrigger = {
  /** Text between the slash and the caret. */
  query: string;
  /** Index of the slash. */
  rangeStart: number;
  /** The caret. */
  rangeEnd: number;
  /** End of the whole token (first whitespace at or after the caret, or the end). */
  tokenEnd: number;
  /** Only whitespace before the slash: the session runs the command. */
  atMessageStart: boolean;
};

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r';
}

function clamp(text: string, n: number): number {
  if (!Number.isFinite(n)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(n)));
}

/**
 * The slash token the caret is in, if any: a `/` at the start of the draft, a line, or after
 * whitespace, with no selection. A word with a second slash (`/tmp/x`) is a path, not a
 * command.
 */
export function detectSlashTrigger(text: string, selection: Selection): SlashTrigger | null {
  if (selection.start !== selection.end) return null;
  const caret = clamp(text, selection.end);
  let start = caret;
  while (start > 0 && !isSpace(text[start - 1])) start -= 1;
  if (text[start] !== '/' || start >= caret) return null;
  let end = caret;
  while (end < text.length && !isSpace(text[end])) end += 1;
  if (text.slice(start + 1, end).includes('/')) return null;
  return {
    query: text.slice(start + 1, caret),
    rangeStart: start,
    rangeEnd: caret,
    tokenEnd: end,
    atMessageStart: text.slice(0, start).trim() === '',
  };
}

// ---------------------------------------------------------------------------
// Ranking (T3 searchRanking)
// ---------------------------------------------------------------------------

type Ranked<T> = { item: T; score: number; tieBreaker: string };

function lengthPenalty(value: string, query: string): number {
  return Math.min(64, Math.max(0, value.length - query.length));
}

/** Lower is better; null when the characters of `query` do not appear in order. */
export function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;
  let qi = 0;
  let first = -1;
  let prev = -1;
  let gaps = 0;
  for (let vi = 0; vi < value.length; vi += 1) {
    if (value[vi] !== query[qi]) continue;
    if (first === -1) first = vi;
    if (prev !== -1) gaps += vi - prev - 1;
    prev = vi;
    qi += 1;
    if (qi === query.length) {
      const span = vi - first + 1 - query.length;
      return first * 2 + gaps * 3 + span + lengthPenalty(value, query);
    }
  }
  return null;
}

function boundaryIndex(value: string, query: string, markers: readonly string[]): number | null {
  let best: number | null = null;
  for (const marker of markers) {
    const i = value.indexOf(`${marker}${query}`);
    if (i !== -1 && (best === null || i + marker.length < best)) best = i + marker.length;
  }
  return best;
}

/** Exact < prefix < word boundary < substring < fuzzy; `value` and `query` lowercased. */
export function scoreQueryMatch(input: {
  value: string;
  query: string;
  exactBase: number;
  prefixBase?: number;
  boundaryBase?: number;
  includesBase?: number;
  fuzzyBase?: number;
  boundaryMarkers?: readonly string[];
}): number | null {
  const { value, query } = input;
  if (!value || !query) return null;
  if (value === query) return input.exactBase;
  const penalty = lengthPenalty(value, query);
  if (input.prefixBase !== undefined && value.startsWith(query)) return input.prefixBase + penalty;
  if (input.boundaryBase !== undefined) {
    const i = boundaryIndex(value, query, input.boundaryMarkers ?? [' ', '-', '_', '/']);
    if (i !== null) return input.boundaryBase + i * 2 + penalty;
  }
  if (input.includesBase !== undefined) {
    const i = value.indexOf(query);
    if (i !== -1) return input.includesBase + i * 2 + penalty;
  }
  if (input.fuzzyBase !== undefined) {
    const fuzzy = scoreSubsequenceMatch(value, query);
    if (fuzzy !== null) return input.fuzzyBase + fuzzy;
  }
  return null;
}

function insertRanked<T>(list: Ranked<T>[], entry: Ranked<T>, limit: number): void {
  const before = (a: Ranked<T>, b: Ranked<T>) => a.score - b.score || a.tieBreaker.localeCompare(b.tieBreaker);
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (before(entry, list[mid]) < 0) hi = mid;
    else lo = mid + 1;
  }
  if (lo >= limit) return;
  list.splice(lo, 0, entry);
  if (list.length > limit) list.pop();
}

const NAME_MARKERS = ['-', '_', ':', '.', '/'] as const;

/**
 * The menu for `query` (text after the slash). Empty query: built-ins, then skills, prompts
 * and extension commands, each in the hub's order. Otherwise ranked by the short label, then
 * the full name (`skill:…`), then (3+ characters) the description.
 */
export function rankCommands(commands: readonly CommandInfo[], query: string, limit = 60): CommandInfo[] {
  const q = query.trim().replace(/^\/+/, '').toLowerCase();
  if (!q) {
    return commands
      .map((c, i) => ({ c, i }))
      .sort((a, b) => EMPTY_QUERY_RANK[a.c.source] - EMPTY_QUERY_RANK[b.c.source] || a.i - b.i)
      .slice(0, limit)
      .map(({ c }) => c);
  }
  const ranked: Ranked<CommandInfo>[] = [];
  commands.forEach((c, i) => {
    const label = commandLabel(c).toLowerCase();
    const name = c.name.toLowerCase();
    const scores = [
      scoreQueryMatch({ value: label, query: q, exactBase: 0, prefixBase: 2, boundaryBase: 4, includesBase: 6, fuzzyBase: 100, boundaryMarkers: NAME_MARKERS }),
      name === label
        ? null
        : scoreQueryMatch({ value: name, query: q, exactBase: 1, prefixBase: 3, boundaryBase: 5, includesBase: 7, fuzzyBase: 110, boundaryMarkers: NAME_MARKERS }),
      q.length >= 3 && c.description
        ? scoreQueryMatch({ value: c.description.toLowerCase(), query: q, exactBase: 30, prefixBase: 32, boundaryBase: 34, includesBase: 36 })
        : null,
    ].filter((s): s is number => s !== null);
    if (!scores.length) return;
    const rank = EMPTY_QUERY_RANK[c.source];
    insertRanked(ranked, { item: c, score: Math.min(...scores), tieBreaker: `${rank}\u0000${label}\u0000${String(i).padStart(5, '0')}` }, limit);
  });
  return ranked.map((r) => r.item);
}

/**
 * The one command `query` names exactly, for Return/space completion: by full name first,
 * then by short label. Null when nothing or more than one command matches.
 */
export function exactCommandMatch(commands: readonly CommandInfo[], query: string): CommandInfo | null {
  const q = query.toLowerCase();
  if (!q) return null;
  const byName = commands.filter((c) => c.name.toLowerCase() === q);
  if (byName.length) return byName.length === 1 ? byName[0] : null;
  const byLabel = commands.filter((c) => commandLabel(c).toLowerCase() === q);
  return byLabel.length === 1 ? byLabel[0] : null;
}

// ---------------------------------------------------------------------------
// Insertion
// ---------------------------------------------------------------------------

export type Edit = { text: string; caret: number };

/** Replaces the whole trigger token with `/name ` and puts the caret after the space. */
export function insertCommand(text: string, trigger: Pick<SlashTrigger, 'rangeStart' | 'tokenEnd'>, command: Pick<CommandInfo, 'name'>): Edit {
  const start = clamp(text, trigger.rangeStart);
  const end = Math.max(start, clamp(text, trigger.tokenEnd));
  const after = text.slice(end);
  const token = `/${command.name}`;
  const next = `${text.slice(0, start)}${token}${after.startsWith(' ') ? '' : ' '}${after}`;
  return { text: next, caret: start + token.length + 1 };
}

/**
 * Return or space typed right after a slash token that names exactly one command completes
 * it: `/use-subs` + space → `/skill:use-subs `; `/new` + Return → `/new ` (no newline).
 * `prev` → `next` must be a one-character insertion. Null when nothing changes.
 */
export function completeOnInsert(prev: string, next: string, commands: readonly CommandInfo[]): Edit | null {
  if (next.length !== prev.length + 1 || !commands.length) return null;
  let i = 0;
  while (i < prev.length && prev[i] === next[i]) i += 1;
  const ch = next[i];
  if ((ch !== ' ' && ch !== '\n') || next.slice(i + 1) !== prev.slice(i)) return null;
  const trigger = detectSlashTrigger(prev, { start: i, end: i });
  if (!trigger || trigger.tokenEnd !== i) return null;
  const command = exactCommandMatch(commands, trigger.query);
  if (!command) return null;
  const edit = insertCommand(prev, trigger, command);
  return edit.text === next ? null : edit;
}

/**
 * Where the caret most likely is after `prev` became `next` by typing, pasting or deleting at
 * one spot (the selection event can arrive after the text event).
 */
export function caretAfterEdit(prev: string, next: string): number {
  let p = 0;
  const max = Math.min(prev.length, next.length);
  while (p < max && prev[p] === next[p]) p += 1;
  let s = 0;
  while (s < max - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s += 1;
  return next.length - s;
}

/**
 * Height of the menu's scrolling list for `room` points above the composer: up to five and a
 * half rows, always a whole number of rows plus a half, so the cut-off row reads as "scrolls"
 * rather than as a clipping glitch (an SE with the keyboard up gets 2.5 rows). Never taller
 * than the content.
 */
export function menuListHeight(room: number, count: number, rowHeight: number, padding: number): number {
  const content = count * rowHeight + padding * 2;
  const rows = Math.max(1, Math.min(5.5, Math.floor((room - padding) / rowHeight - 0.5) + 0.5));
  return Math.min(content, Math.round(rows * rowHeight + padding));
}

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

export type Segment = { text: string; command: boolean };

/** Names a typed `/token` can mean: every full name, plus each skill's unambiguous short label. */
export function commandNames(commands: readonly CommandInfo[]): Set<string> {
  const names = new Set(commands.map((c) => c.name));
  const labels = new Map<string, number>();
  for (const c of commands) if (c.source === 'skill') labels.set(commandLabel(c), (labels.get(commandLabel(c)) ?? 0) + 1);
  for (const [label, n] of labels) if (n === 1) names.add(label);
  return names;
}

/**
 * Splits a draft so the composer can colour each known `/command` at the start of a line.
 * Unknown tokens, paths and mid-line slashes stay plain.
 */
export function highlightSegments(text: string, names: ReadonlySet<string>): Segment[] {
  const out: Segment[] = [];
  if (!names.size) return text ? [{ text, command: false }] : out;
  const re = /(^|\n)([ \t]*)(\/[^\s/]+)(?=\s|$)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const token = m[3];
    if (!names.has(token.slice(1))) continue;
    const start = m.index + m[1].length + m[2].length;
    if (start > last) out.push({ text: text.slice(last, start), command: false });
    out.push({ text: token, command: true });
    last = start + token.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), command: false });
  return out;
}

// ---------------------------------------------------------------------------
// Sent messages
// ---------------------------------------------------------------------------

export type LeadingCommand = {
  /** Full command name (`skill:use-subs`). */
  name: string;
  /** Short label for the pill (`use-subs`). */
  label: string;
  /** Everything after the command (its arguments), trimmed. */
  rest: string;
};

const SLASH_HEAD = /^\/([A-Za-z0-9][\w.:@+-]*)(?=\s|$)/;
// phi expands `/skill:name args` into this block before the message is stored
// (agent-session `_expandSkillCommand`, read back by its `parseSkillBlock`).
const SKILL_BLOCK_HEAD = /^<skill name="([^"\n]+)" location="[^"\n]*">\n/;
const SKILL_BLOCK_END = '\n</skill>';

/**
 * A user message that starts with a slash command, or with phi's expanded skill block, split
 * into the command and its arguments. Null for anything else (including paths like `/tmp/x`).
 */
export function splitLeadingCommand(text: string): LeadingCommand | null {
  const skill = SKILL_BLOCK_HEAD.exec(text);
  if (skill) {
    const name = `${SKILL_PREFIX}${skill[1]}`;
    const close = text.lastIndexOf(SKILL_BLOCK_END);
    const rest = close >= 0 ? text.slice(close + SKILL_BLOCK_END.length).trim() : '';
    return { name, label: skill[1], rest };
  }
  const m = SLASH_HEAD.exec(text);
  if (!m) return null;
  const name = m[1];
  const label = name.startsWith(SKILL_PREFIX) && name.length > SKILL_PREFIX.length ? name.slice(SKILL_PREFIX.length) : name;
  return { name, label, rest: text.slice(m[0].length).trim() };
}
