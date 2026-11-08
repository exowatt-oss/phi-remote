/**
 * Per-session transcript state: a map keyed by item id plus an ordered id list.
 * An upsert for a known id replaces in place; an unknown id appends (docs/PROTOCOL.md).
 */

import type { LiveState, TranscriptItem } from './protocol';

export type TranscriptPhase =
  /** Nothing loaded yet. */
  | 'empty'
  /** Waiting for the subscribe snapshot. */
  | 'loading'
  /** Snapshot applied; live events are flowing. */
  | 'ready'
  /** The hub asked us to resubscribe (`reset`); items shown may be outdated. */
  | 'stale'
  /** Subscribe failed (e.g. the session ended). */
  | 'error';

/**
 * Where the items came from: `live` = a session.subscribe snapshot plus events; `stored` = a
 * stored session read with session.transcript (Session history, v1 addition); `cache` = this
 * iPhone's copy, shown until the computer answers.
 */
export type TranscriptSource = 'live' | 'stored' | 'cache';

export type TranscriptState = {
  byId: Readonly<Record<string, TranscriptItem>>;
  order: readonly string[];
  hasMore: boolean;
  live: LiveState | null;
  phase: TranscriptPhase;
  loadingOlder: boolean;
  error: string | null;
  source: TranscriptSource | null;
};

export const emptyTranscript: TranscriptState = Object.freeze({
  byId: Object.freeze({}),
  order: Object.freeze([]) as readonly string[],
  hasMore: false,
  live: null,
  phase: 'empty',
  loadingOlder: false,
  error: null,
  source: null,
});

export type TranscriptAction =
  | { type: 'loading' }
  | { type: 'snapshot'; items: TranscriptItem[]; hasMore: boolean; state: LiveState }
  /** The newest page of a stored session (session.transcript without `before`). */
  | { type: 'stored'; items: TranscriptItem[]; hasMore: boolean }
  /** This iPhone's copy; only fills an empty transcript. */
  | { type: 'cached'; items: TranscriptItem[]; hasMore: boolean }
  /** The live session ended but the computer keeps it: the items stay, read as stored. */
  | { type: 'detach' }
  | { type: 'history'; items: TranscriptItem[]; hasMore: boolean }
  | { type: 'loadingOlder'; value: boolean }
  | { type: 'upsert'; item: TranscriptItem }
  | { type: 'state'; state: LiveState }
  | { type: 'reset' }
  | { type: 'error'; message: string };

function indexItems(items: TranscriptItem[]): { byId: Record<string, TranscriptItem>; order: string[] } {
  const byId: Record<string, TranscriptItem> = {};
  const order: string[] = [];
  for (const item of items) {
    if (!(item.id in byId)) order.push(item.id);
    byId[item.id] = item;
  }
  return { byId, order };
}

/**
 * A newest page that replaces what is shown. When the page starts at an item already on screen
 * (same ids: the stored transcript and the resumed live session share them), the older items
 * before it stay, so the switch from stored (or cached) to live never drops or repeats anything.
 */
function replaceNewest(
  state: TranscriptState,
  items: TranscriptItem[],
  hasMore: boolean,
  keepOlder: boolean,
): Pick<TranscriptState, 'byId' | 'order' | 'hasMore'> {
  const page = indexItems(items);
  const at = keepOlder && page.order.length > 0 ? state.order.indexOf(page.order[0]) : -1;
  if (at <= 0) return { ...page, hasMore };
  const byId: Record<string, TranscriptItem> = {};
  const order: string[] = [];
  for (const id of state.order.slice(0, at)) {
    if (id in page.byId || !(id in state.byId)) continue;
    order.push(id);
    byId[id] = state.byId[id];
  }
  return { byId: { ...byId, ...page.byId }, order: [...order, ...page.order], hasMore: state.hasMore };
}

export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.type) {
    case 'loading':
      // Keep whatever is on screen while a (re)subscribe is in flight.
      return { ...state, phase: state.order.length > 0 ? state.phase : 'loading', error: null };

    case 'snapshot': {
      // A resubscribe of a live session starts over; the first live snapshot after a stored or
      // cached transcript continues it.
      const page = replaceNewest(state, action.items, action.hasMore, state.source !== 'live');
      return { ...page, live: action.state, phase: 'ready', loadingOlder: false, error: null, source: 'live' };
    }

    case 'stored': {
      const page = replaceNewest(state, action.items, action.hasMore, true);
      return { ...page, live: null, phase: 'ready', loadingOlder: false, error: null, source: 'stored' };
    }

    case 'cached': {
      if (state.order.length > 0 || action.items.length === 0) return state;
      const { byId, order } = indexItems(action.items);
      return { ...state, byId, order, hasMore: action.hasMore, phase: 'ready', error: null, source: 'cache' };
    }

    case 'detach':
      return { ...state, live: null, phase: 'ready', error: null, loadingOlder: false, source: 'stored' };

    case 'history': {
      const older = action.items.filter((item) => !(item.id in state.byId));
      if (older.length === 0) return { ...state, hasMore: action.hasMore, loadingOlder: false };
      const indexed = indexItems(older);
      return {
        ...state,
        byId: { ...indexed.byId, ...state.byId },
        order: [...indexed.order, ...state.order],
        hasMore: action.hasMore,
        loadingOlder: false,
      };
    }

    case 'loadingOlder':
      return state.loadingOlder === action.value ? state : { ...state, loadingOlder: action.value };

    case 'upsert': {
      const { item } = action;
      const known = item.id in state.byId;
      if (known && state.byId[item.id] === item) return state;
      return {
        ...state,
        byId: { ...state.byId, [item.id]: item },
        order: known ? state.order : [...state.order, item.id],
      };
    }

    case 'state':
      return { ...state, live: action.state };

    case 'reset':
      return { ...state, phase: 'stale' };

    case 'error':
      return { ...state, phase: 'error', error: action.message, loadingOlder: false };

    default:
      return state;
  }
}

/** Items in display order (oldest → newest). */
export function orderedItems(state: TranscriptState): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const id of state.order) {
    const item = state.byId[id];
    if (item) out.push(item);
  }
  return out;
}

/** Plain text for copying a transcript item. */
export function itemCopyText(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user':
    case 'note':
      return item.text;
    case 'assistant':
      return item.error && !item.text ? item.error : item.text;
    case 'tool':
      return item.output ? `${item.summary}\n\n${item.output}` : item.summary;
  }
}
