/**
 * Transcript → feed presentation (pure). Ports T3's "run fold": once a turn is finished,
 * its tool calls, thinking and in-between replies collapse into one "Worked for 2m 10s"
 * row; the turn's first and final replies stay visible, and so does every reply that ended
 * a run (one turn can hold several: subagent results or agent mail start a run of their
 * own). The live turn is never folded. A `subagent` launch is never folded either (its
 * card stays in place), nor are an overseer's thread cards (Started, Sent to, Closed …).
 */

import { formatDuration } from './format';
import { isVisibleOverseerCall } from './overseer';
import type { AssistantItem, TranscriptItem } from './protocol';
import { subagentLaunch } from './subagents';

export type FeedItemEntry = {
  type: 'item';
  key: string;
  item: TranscriptItem;
  /** The turn is folded: hide this reply's thinking disclosure. */
  hideThinking: boolean;
};

export type FeedFoldEntry = {
  type: 'fold';
  key: string;
  turnId: string;
  label: string;
  expanded: boolean;
  /** Number of rows the fold hides. */
  hidden: number;
};

export type FeedEntry = FeedItemEntry | FeedFoldEntry;

type Turn = { id: string; user: TranscriptItem | null; items: TranscriptItem[] };

function splitTurns(items: TranscriptItem[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const item of items) {
    if (item.kind === 'user') {
      current = { id: item.id, user: item, items: [] };
      turns.push(current);
    } else {
      if (!current) {
        current = { id: `head:${item.id}`, user: null, items: [] };
        turns.push(current);
      }
      current.items.push(item);
    }
  }
  return turns;
}

const hasText = (i: TranscriptItem): i is AssistantItem => i.kind === 'assistant' && i.text.trim().length > 0;

type FoldPlan = { hidden: Set<string>; label: string; anchorId: string; thinking: boolean };

function planFold(turn: Turn, finished: boolean): FoldPlan | null {
  if (!finished || turn.items.length === 0) return null;
  const assistants = turn.items.filter((i): i is AssistantItem => i.kind === 'assistant');
  if (assistants.some((a) => a.streaming)) return null;
  // A failed turn stays open so the error and the work that led to it are visible.
  if (assistants.some((a) => a.error && a.error !== 'aborted')) return null;
  const withText = turn.items.filter(hasText);
  const first = withText[0]?.id;
  const terminal = withText[withText.length - 1]?.id;
  // An assistant message's tool items follow it directly (docs/PROTOCOL.md), so a reply with
  // no tool item after it called no tools: it ended a run, and is an answer, not narration.
  const answers = new Set<string>();
  turn.items.forEach((item, index) => {
    if (hasText(item) && turn.items[index + 1]?.kind !== 'tool') answers.add(item.id);
  });
  const hidden = new Set<string>();
  for (const item of turn.items) {
    // A subagent launch stays out of the fold: its card is how you follow (and open) the
    // subagents, which often outlive the turn that started them. So do an overseer's cards for
    // what it did to its threads (started, sent, closed …); its reads and board checks fold.
    if (item.kind === 'tool') {
      if (!subagentLaunch(item) && !isVisibleOverseerCall(item)) hidden.add(item.id);
    }
    else if (item.kind === 'assistant' && item.id !== first && item.id !== terminal && !answers.has(item.id) && !item.error)
      hidden.add(item.id);
  }
  const thinking = assistants.some((a) => !hidden.has(a.id) && !!a.thinking);
  if (hidden.size === 0 && !thinking) return null;
  const startTs = turn.user?.ts ?? turn.items[0].ts;
  const endTs = Math.max(...turn.items.map((i) => i.ts));
  const ms = endTs - startTs;
  // Under a second reads as "Worked for 0s", which looks like a bug; say "Worked" instead.
  const duration = startTs > 0 && ms >= 1000 ? formatDuration(ms) : null;
  const stopped = assistants.some((a) => a.error === 'aborted');
  const label = stopped
    ? duration
      ? `You stopped after ${duration}`
      : 'You stopped this response'
    : duration
      ? `Worked for ${duration}`
      : 'Worked';
  const anchor =
    turn.items.find((i) => hidden.has(i.id)) ?? turn.items.find((i) => i.kind === 'assistant' && !!i.thinking) ?? turn.items[0];
  return { hidden, label, anchorId: anchor.id, thinking };
}

/**
 * Builds the feed. `working` is the session's live status; `expanded` holds turn ids the
 * reader opened.
 */
export function buildFeed(
  items: TranscriptItem[],
  opts: { working: boolean; expanded: ReadonlySet<string> },
): FeedEntry[] {
  const turns = splitTurns(items);
  const out: FeedEntry[] = [];
  turns.forEach((turn, index) => {
    const last = index === turns.length - 1;
    const finished = !last || !opts.working;
    const plan = planFold(turn, finished);
    const expanded = plan ? opts.expanded.has(turn.id) : false;
    if (turn.user) out.push({ type: 'item', key: turn.user.id, item: turn.user, hideThinking: false });
    for (const item of turn.items) {
      if (plan && item.id === plan.anchorId) {
        out.push({
          type: 'fold',
          key: `fold:${turn.id}`,
          turnId: turn.id,
          label: plan.label,
          expanded,
          hidden: plan.hidden.size,
        });
      }
      if (plan && !expanded && plan.hidden.has(item.id)) continue;
      out.push({ type: 'item', key: item.id, item, hideThinking: !!plan && !expanded });
    }
  });
  return out;
}

/** When the current turn started (latest user message), for the working timer. */
export function turnStartedAt(items: TranscriptItem[]): number | null {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') return items[i].ts || null;
  return null;
}

/** The newest finished, non-empty assistant reply (for "Read latest reply"). */
export function latestReply(items: TranscriptItem[]): AssistantItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'assistant' && !it.streaming && it.text.trim()) return it;
  }
  return null;
}
