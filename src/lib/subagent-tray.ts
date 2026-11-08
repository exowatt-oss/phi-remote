/**
 * The pinned subagent tray above a parent thread's composer: which subagents it lists, its
 * summary line and its life cycle, as pure functions of the thread's rows and the clock.
 *
 * The tray comes up when any subagent of the thread runs. From then until it goes away (an
 * "episode") it covers every launch that had a running subagent, so a second launch joins the
 * first ("5 subagents · 3 running · 1 done · 1 failed"). It lists the running ones and the failed
 * ones nobody has looked at yet; finished ones leave the list and stay in the transcript's card.
 * When the last one stops it says so for FINISH_LINGER_MS ("All 4 done"), then goes. A failure
 * keeps it up until the run is opened or the thread gets a new prompt.
 */

import { countRows, rowFromChild, subagentRows, type RowCounts, type SubagentChild, type SubagentRow } from './subagents';
import type { TranscriptItem } from './protocol';

/** How long "All 4 done" stays before the tray shrinks away. */
export const FINISH_LINGER_MS = 4000;

export type TrayRow = SubagentRow & {
  /** The launch it belongs to: the `subagent` tool call id, or `child:<sessionId>` when that call is not loaded. */
  launch: string;
  /** Stable identity across the args-only row and the child session row: the session id once known. */
  id: string;
};

/**
 * Every subagent of a thread in launch order (oldest first): children whose launch is not in the
 * loaded transcript, then each launch's rows. A launch the transcript still shows running while
 * the thread is not working (interrupted, or offline) says nothing certain about tasks the hub
 * has not reported: those become `unknown`, as in the card.
 */
export function threadSubagentRows(
  items: readonly TranscriptItem[],
  children: readonly SubagentChild[],
  sessionWorking: boolean,
): TrayRow[] {
  const launched: TrayRow[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'tool') continue;
    const rows = subagentRows(item, children);
    if (!rows) continue;
    const stale = item.status === 'running' && !sessionWorking;
    for (const r of rows) {
      if (r.sessionId) seen.add(r.sessionId);
      const status = stale && !r.sessionId && r.status === 'running' ? 'unknown' : r.status;
      launched.push({ ...r, status, launch: item.toolCallId, id: r.sessionId ?? r.key });
    }
  }
  const loose: TrayRow[] = [];
  for (const c of children) {
    if (seen.has(c.sessionId)) continue;
    loose.push({ ...rowFromChild(c), launch: `child:${c.sessionId}`, id: c.sessionId });
  }
  return [...loose, ...launched];
}

/** What the tray remembers per thread between renders (and between visits, for the app session). */
export type TrayMemory = {
  /** Launches that had a running subagent since the tray last went away. */
  episode: readonly string[];
  /** When the last of them stopped running; null while any runs. */
  finishedAt: number | null;
  /** Failed runs (row ids) the user has opened, or put behind them with a new prompt. */
  acked: readonly string[];
};

export const EMPTY_TRAY: TrayMemory = { episode: [], finishedAt: null, acked: [] };

const inEpisode = (memory: TrayMemory, rows: readonly TrayRow[]) => rows.filter((r) => memory.episode.includes(r.launch));
const isPendingFailure = (memory: TrayMemory, r: TrayRow) => r.status === 'failed' && !memory.acked.includes(r.id);

const finished = (r: TrayRow) => r.status === 'done' || r.status === 'failed' || r.status === 'killed';

/**
 * The next memory for these rows at `now`: running launches join the episode; the moment the
 * last one stops is stamped; once that moment has been shown (or there was nothing to report,
 * say every row turned `unknown`) and no failure waits, the tray is cleared. Returns `prev`
 * itself when nothing changed.
 */
export function advanceTray(prev: TrayMemory, rows: readonly TrayRow[], now: number): TrayMemory {
  let episode = prev.episode;
  let running = false;
  for (const r of rows) {
    if (r.status !== 'running') continue;
    running = true;
    if (!episode.includes(r.launch)) episode = [...episode, r.launch];
  }
  if (episode.length === 0) return prev.episode.length === 0 && prev.acked.length === 0 && prev.finishedAt === null ? prev : EMPTY_TRAY;
  const finishedAt = running ? null : (prev.finishedAt ?? now);
  const next: TrayMemory = episode === prev.episode && finishedAt === prev.finishedAt ? prev : { ...prev, episode, finishedAt };
  if (!running) {
    const own = inEpisode(next, rows);
    // A failure nobody has opened holds the tray up.
    if (own.some((r) => isPendingFailure(next, r))) return next;
    // Nothing to report (every row turned `unknown`), or the finish moment has been shown.
    if (!own.some(finished) || now >= (finishedAt ?? now) + FINISH_LINGER_MS) return EMPTY_TRAY;
  }
  return next;
}

/** Marks failed runs as seen (their thread was opened). */
export function ackTray(prev: TrayMemory, ids: readonly string[]): TrayMemory {
  const add = ids.filter((id) => !prev.acked.includes(id));
  return add.length ? { ...prev, acked: [...prev.acked, ...add] } : prev;
}

/** A new prompt puts every failure so far behind the user. */
export function ackTrayFailures(prev: TrayMemory, rows: readonly TrayRow[]): TrayMemory {
  return ackTray(
    prev,
    inEpisode(prev, rows)
      .filter((r) => r.status === 'failed')
      .map((r) => r.id),
  );
}

export type TraySegment = { text: string; tone?: 'danger' };

export type TrayView = {
  /** `running` while any subagent runs, then `finished` (the finish moment, or failures waiting). */
  phase: 'running' | 'finished';
  /** The header glyph: still going, all went well, or something failed. */
  status: 'running' | 'done' | 'failed';
  /** The summary line, joined with " · " (a failure count in red). */
  segments: TraySegment[];
  label: string;
  counts: RowCounts;
  /** The rows to list, capped. */
  rows: TrayRow[];
  /** Rows left out by the cap ("+2 more"). */
  more: number;
  /** When the tray goes away by itself (end of the finish moment); null while it stays. */
  expiresAt: number | null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function summary(counts: RowCounts, running: boolean): TraySegment[] {
  const { total, done, failed, killed } = counts;
  if (running && counts.running === total) return [{ text: `${plural(total, 'subagent')} running` }];
  if (!running && done === total) return [{ text: total === 1 ? 'Subagent done' : `All ${total} done` }];
  const parts: TraySegment[] = running ? [{ text: plural(total, 'subagent') }, { text: `${counts.running} running` }] : [];
  if (done) parts.push({ text: `${done} done` });
  if (failed) parts.push({ text: `${failed} failed`, tone: 'danger' });
  if (killed) parts.push({ text: `${killed} stopped` });
  return parts;
}

/**
 * What the tray shows for this memory and these rows, or null when it is not up. `cap` is the
 * most row slots it may take: more rows than that show `cap - 1` of them and a "+N more" row.
 */
export function trayView(memory: TrayMemory, rows: readonly TrayRow[], cap = 3): TrayView | null {
  if (memory.episode.length === 0) return null;
  const own = inEpisode(memory, rows);
  const running = own.some((r) => r.status === 'running');
  const listed = own.filter((r) => r.status === 'running' || isPendingFailure(memory, r));
  const counts = countRows(own);
  if (!running && listed.length === 0 && !own.some(finished)) return null;
  const slots = Math.max(2, Math.floor(cap));
  const shown = listed.length > slots ? listed.slice(0, slots - 1) : listed;
  const segments = summary(counts, running);
  return {
    phase: running ? 'running' : 'finished',
    status: running ? 'running' : counts.failed > 0 ? 'failed' : 'done',
    segments,
    label: segments.map((s) => s.text).join(' · '),
    counts,
    rows: shown,
    more: listed.length - shown.length,
    expiresAt: !running && listed.length === 0 && memory.finishedAt !== null ? memory.finishedAt + FINISH_LINGER_MS : null,
  };
}
