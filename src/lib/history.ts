/**
 * Session history (protocol "Session history (v1 addition)"): every stored phi session on every
 * paired computer, merged into one list. Pure functions only: paging merges, the merged rows
 * (live sessions folded in), local search, date sections and the bounded on-phone cache format.
 */

import { nestUnderOverseers, threadOfCaption } from './overseer';
import { parsePastSession, type PastSession, type SessionSummary, type TranscriptItem } from './protocol';

/** Sessions per `sessions.past` page. */
export const PAGE_SIZE = 50;
/** Newest items kept per cached transcript. */
export const CACHED_ITEMS = 120;
/** Transcripts kept on the phone (least recently opened go first). */
export const MAX_CACHED_TRANSCRIPTS = 50;
/** Index entries kept on the phone per computer (newest). */
export const MAX_CACHED_INDEX = 500;

/** What to run on a computer whose phi predates session history. */
export const UPDATE_COMMAND = 'phi remote install'; // Update phi from its public distribution before reinstalling the remote service.

/**
 * `history`: the computer lists its stored sessions. `legacy`: it connected without the feature
 * (older phi). `unknown`: not connected since launch and nothing cached says otherwise.
 */
export type HistorySupport = 'history' | 'legacy' | 'unknown';

export type HubHistory = {
  /** Every stored session known on this computer: the browse index, search hits, opened ones. */
  byId: Record<string, PastSession>;
  /** The browse index: newest first, contiguous from the newest (the pages loaded so far). */
  order: string[];
  /** Cursor of the next page; null = the end; undefined = the first page was never loaded. */
  nextCursor: string | null | undefined;
  support: HistorySupport;
  loading: boolean;
  /** The computer is still building its index; a later refresh shows more. */
  indexing: boolean;
  error: string | null;
};

export const emptyHubHistory: HubHistory = Object.freeze({
  byId: Object.freeze({}) as Record<string, PastSession>,
  order: Object.freeze([]) as unknown as string[],
  nextCursor: undefined,
  support: 'unknown',
  loading: false,
  indexing: false,
  error: null,
}) as HubHistory;

/** Server-side search results for one computer (`sessions.past` with `query`). */
export type SearchHub = { ids: string[]; nextCursor: string | null | undefined; loading: boolean; error: string | null };
export type SearchState = { query: string; hubs: Record<string, SearchHub> };

export type PastPage = { sessions: PastSession[]; nextCursor?: string; indexing?: boolean };

const newestFirst = (byId: Record<string, PastSession>) => (a: string, b: string) =>
  (byId[b]?.modifiedAt ?? 0) - (byId[a]?.modifiedAt ?? 0) || (a < b ? -1 : a > b ? 1 : 0);

/** Ids de-duplicated (known ones only), newest `modifiedAt` first. */
export function sortIds(byId: Record<string, PastSession>, ids: Iterable<string>): string[] {
  const out = [...new Set(ids)].filter((id) => id in byId);
  out.sort(newestFirst(byId));
  return out;
}

/**
 * Applies a `sessions.past` page to a computer's index. `refresh` is a first page: it is
 * authoritative for everything as new as its oldest entry (sessions missing from that range were
 * deleted) and keeps the older cached tail. `more` appends the next page.
 */
export function applyPage(h: HubHistory, page: PastPage, mode: 'refresh' | 'more'): HubHistory {
  const byId = { ...h.byId };
  for (const s of page.sessions) byId[s.sessionId] = s;
  const pageIds = page.sessions.map((s) => s.sessionId);
  let order: string[];
  let nextCursor: string | null;
  if (mode === 'more') {
    order = sortIds(byId, [...h.order, ...pageIds]);
    nextCursor = page.nextCursor ?? null;
  } else if (!page.nextCursor) {
    // The whole history fit in one page: it is the complete list.
    order = sortIds(byId, pageIds);
    nextCursor = null;
  } else {
    const oldest = Math.min(...page.sessions.map((s) => s.modifiedAt));
    const fresh = new Set(pageIds);
    const tail = h.order.filter((id) => !fresh.has(id) && (h.byId[id]?.modifiedAt ?? 0) < oldest);
    order = sortIds(byId, [...pageIds, ...tail]);
    // A cached tail continues with its own cursor (when it has one); otherwise from this page.
    nextCursor = tail.length > 0 && h.nextCursor !== undefined ? h.nextCursor : page.nextCursor;
  }
  return { ...h, byId, order, nextCursor, support: 'history', loading: false, indexing: page.indexing === true, error: null };
}

/** A live session as a past-session row (computers without history, sessions not indexed yet). */
export function liveAsPast(s: SessionSummary): PastSession {
  const out: PastSession = {
    sessionId: s.sessionId,
    title: s.name,
    named: false,
    cwd: s.cwd,
    createdAt: s.startedAt,
    modifiedAt: s.lastActivityAt,
    messageCount: 0,
    live: true,
    liveKind: s.kind === 'headless' ? 'headless' : 'interactive',
    resumable: true,
  };
  if (s.lastText) out.preview = s.lastText;
  if (s.model) out.model = { provider: s.model.provider, id: s.model.id };
  if (s.overseer) out.overseer = s.overseer;
  if (s.isOverseer || s.threadCounts) out.isOverseer = true;
  return out;
}

/** A stored session that is running: its latest words and overseer facts from the live summary. */
function runningPast(stored: PastSession, live: SessionSummary): PastSession {
  const overseer = stored.overseer ?? live.overseer;
  const isOverseer = stored.isOverseer || live.isOverseer || !!live.threadCounts;
  if (!live.lastText && overseer === stored.overseer && !!isOverseer === !!stored.isOverseer) return stored;
  const out: PastSession = { ...stored };
  if (live.lastText) out.preview = live.lastText;
  if (overseer) out.overseer = overseer;
  if (isOverseer) out.isOverseer = true;
  return out;
}

/**
 * `connected`: live right now (can page, search, resume). `offline`: known to be unreachable (not
 * just reconnecting); its rows read as the phone's copy. Defaults to `!connected`.
 */
export type HistoryHost = { hubId: string; name: string; connected: boolean; offline?: boolean };

export type HistoryRow = {
  /** transcriptKey(hubId, sessionId). */
  key: string;
  hubId: string;
  hostName: string;
  session: PastSession;
  /** Registered with a connected computer right now (opens as a live thread). */
  running: boolean;
  /** Running and in the middle of a turn. */
  working: boolean;
  /** Its computer is not connected: readable from the phone's copy, not resumable. */
  offline: boolean;
  /** Newest of the stored time and live activity. */
  at: number;
};

export type HistoryView = {
  rows: HistoryRow[];
  /** Computers to ask for their next page when the list reaches its end. */
  loadMore: string[];
  /** Something is loading (first pages or a search). */
  loading: boolean;
};

/** Lower-case words of a query; empty for a blank one. */
export function queryWords(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every word appears in the title, folder, preview or computer name (the phone's instant filter). */
export function matchesQuery(s: PastSession, hostName: string, words: string[]): boolean {
  if (words.length === 0) return true;
  const hay = `${s.title}\n${s.cwd}\n${s.preview ?? ''}\n${hostName}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

const keyOf = (hubId: string, sessionId: string) => `${hubId}\n${sessionId}`;

/**
 * The merged list: every computer's stored sessions plus its live threads, newest first.
 *
 * Browsing pages through each computer newest-first, so rows stop at the newest "oldest loaded"
 * session of any connected computer that has more: nothing appears out of order before that
 * computer's next page is in. Searching shows the phone's instant matches merged with what each
 * computer found.
 */
export function historyView(input: {
  hosts: HistoryHost[];
  history: Record<string, HubHistory>;
  live: Record<string, Record<string, SessionSummary>>;
  /** Only this computer (null = all). */
  hubId: string | null;
  query: string;
  search: SearchState | null;
}): HistoryView {
  const words = queryWords(input.query);
  const searching = words.length > 0;
  const rows: HistoryRow[] = [];
  const loadMore: string[] = [];
  let loading = false;
  let cutoff = -Infinity;
  const frontier: { hubId: string; oldest: number }[] = [];

  for (const host of input.hosts) {
    if (input.hubId && host.hubId !== input.hubId) continue;
    const h = input.history[host.hubId] ?? emptyHubHistory;
    const liveHere = host.connected ? (input.live[host.hubId] ?? {}) : {};
    const ids = new Set<string>();
    if (searching) {
      for (const s of Object.values(h.byId)) if (matchesQuery(s, host.name, words)) ids.add(s.sessionId);
      const found = input.search && queryWords(input.search.query).join(' ') === words.join(' ') ? input.search.hubs[host.hubId] : undefined;
      if (found) {
        for (const id of found.ids) ids.add(id);
        if (found.loading) loading = true;
        if (host.connected && typeof found.nextCursor === 'string') loadMore.push(host.hubId);
      }
    } else {
      for (const id of h.order) ids.add(id);
      if (h.loading && h.nextCursor === undefined) loading = true;
      if (host.connected && h.support === 'history' && typeof h.nextCursor === 'string' && h.order.length > 0) {
        const oldest = h.byId[h.order[h.order.length - 1]]?.modifiedAt ?? 0;
        frontier.push({ hubId: host.hubId, oldest });
        cutoff = Math.max(cutoff, oldest);
      }
    }
    const seen = new Set<string>();
    for (const id of ids) {
      const stored = h.byId[id];
      if (!stored) continue;
      seen.add(id);
      const live = liveHere[id];
      const running = !!live && live.kind !== 'subagent';
      rows.push({
        key: keyOf(host.hubId, id),
        hubId: host.hubId,
        hostName: host.name,
        // A running one shows its latest words (and what the live summary knows), not the stored ones.
        session: running ? runningPast(stored, live) : stored,
        running,
        working: running && live.status === 'working',
        offline: host.offline ?? !host.connected,
        at: Math.max(stored.modifiedAt, running ? live.lastActivityAt : 0),
      });
    }
    // Live threads the index does not have yet (or a computer without history).
    for (const live of Object.values(liveHere)) {
      if (live.kind === 'subagent' || seen.has(live.sessionId)) continue;
      const s = liveAsPast(live);
      if (searching && !matchesQuery(s, host.name, words)) continue;
      rows.push({
        key: keyOf(host.hubId, s.sessionId),
        hubId: host.hubId,
        hostName: host.name,
        session: s,
        running: true,
        working: live.status === 'working',
        offline: false,
        at: s.modifiedAt,
      });
    }
  }

  rows.sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (!searching && frontier.length > 0) {
    for (const f of frontier) if (f.oldest >= cutoff) loadMore.push(f.hubId);
    // Running sessions always show; stored ones wait for the computer that is behind.
    return { rows: rows.filter((r) => r.at >= cutoff || r.running), loadMore, loading };
  }
  return { rows, loadMore, loading };
}

// ---------------------------------------------------------------------------
// Date sections
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAY = 86_400_000;

/** "Today", "Yesterday", "Previous 7 days", "Previous 30 days", then "October" / "October 2025". */
export function sectionTitle(ts: number, now: number): string {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  if (ts >= start) return 'Today';
  if (ts >= start - DAY) return 'Yesterday';
  if (ts >= start - 7 * DAY) return 'Previous 7 days';
  if (ts >= start - 30 * DAY) return 'Previous 30 days';
  const d = new Date(ts);
  const month = MONTH_NAMES[d.getMonth()];
  return d.getFullYear() === today.getFullYear() ? month : `${month} ${d.getFullYear()}`;
}

/** Overseers (v1 addition): where a row sits relative to an overseer on the list. */
export type RowNest = {
  /** One of the overseer above's threads, indented (`first` / `last` of its listed threads). */
  nested?: { first: boolean; last: boolean };
  /** An overseer: how many of its threads are listed, and whether they are folded under it. */
  overseer?: { threads: number; folded: boolean; foldKey: string };
  /** A thread whose overseer is not listed: "Thread of …". */
  caption?: string;
};

export type SectionedRow =
  | { type: 'section'; key: string; title: string }
  | { type: 'row'; key: string; row: HistoryRow; first: boolean; nest?: RowNest };

/** The key an overseer's threads fold under on the session lists. */
export const pastFoldKey = (row: Pick<HistoryRow, 'key'>): string => `p:${row.key}`;

export type HistoryNestItem = { row: HistoryRow; nest?: RowNest };

/**
 * Overseers (v1 addition): each listed thread moves under its overseer when the overseer is
 * listed (oldest first, hidden while folded); a thread whose overseer is not listed stays where
 * it is and says whose thread it is. `folded(key)`: the user's choice for that overseer, else
 * the default the caller picks.
 */
export function nestHistory(rows: readonly HistoryRow[], folded: (foldKey: string) => boolean): HistoryNestItem[] {
  const nesting = nestUnderOverseers(
    rows,
    (r) => r.key,
    (r) => (r.session.overseer ? { ...r.session.overseer, sessionId: keyOf(r.hubId, r.session.overseer.sessionId) } : undefined),
    (r) => r.session.createdAt,
  );
  const out: HistoryNestItem[] = [];
  for (const row of nesting.top) {
    const threads = nesting.threads.get(row.key) ?? [];
    const caption = threadOfCaption(row.session.overseer) ?? undefined;
    if (threads.length === 0 && !row.session.isOverseer) {
      out.push(caption ? { row, nest: { caption } } : { row });
      continue;
    }
    const foldKey = pastFoldKey(row);
    const isFolded = threads.length > 0 && folded(foldKey);
    out.push({ row, nest: { overseer: { threads: threads.length, folded: isFolded, foldKey }, ...(caption ? { caption } : {}) } });
    if (isFolded) continue;
    threads.forEach((t, i) => out.push({ row: t, nest: { nested: { first: i === 0, last: i === threads.length - 1 } } }));
  }
  return out;
}

/** Rows (already newest first) with a header before each date section; threads stay under their overseer. */
export function sectionize(rows: readonly (HistoryRow | HistoryNestItem)[], now: number): SectionedRow[] {
  const out: SectionedRow[] = [];
  let current = '';
  for (const entry of rows) {
    const { row, nest } = 'row' in entry ? entry : { row: entry, nest: undefined };
    if (nest?.nested) {
      out.push({ type: 'row', key: `r:${row.key}`, row, first: false, nest });
      continue;
    }
    const title = sectionTitle(row.at, now);
    const first = title !== current;
    if (first) {
      current = title;
      out.push({ type: 'section', key: `h:${title}`, title });
    }
    out.push(nest ? { type: 'row', key: `r:${row.key}`, row, first, nest } : { type: 'row', key: `r:${row.key}`, row, first });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The phone's copy (bounded)
// ---------------------------------------------------------------------------

export type CachedHub = { support: HistorySupport; nextCursor: string | null | undefined; sessions: PastSession[]; known: PastSession[] };
export type CachedIndex = { v: 1; savedAt: number; hubs: Record<string, CachedHub> };

/**
 * The index as stored on the phone: per computer its newest `max` browse entries (the cursor is
 * kept only when nothing was cut, so paging resumes exactly), plus the entries of sessions whose
 * transcripts are cached (`keep`), so those stay listed and titled.
 */
export function serializeIndex(
  history: Record<string, HubHistory>,
  keep: ReadonlySet<string>,
  now: number,
  max = MAX_CACHED_INDEX,
): CachedIndex {
  const hubs: Record<string, CachedHub> = {};
  for (const [hubId, h] of Object.entries(history)) {
    const browse = h.order.slice(0, max);
    const inBrowse = new Set(browse);
    const known = Object.values(h.byId).filter((s) => !inBrowse.has(s.sessionId) && keep.has(keyOf(hubId, s.sessionId)));
    hubs[hubId] = {
      support: h.support,
      nextCursor: h.order.length > max ? undefined : h.nextCursor,
      sessions: browse.map((id) => h.byId[id]).filter(Boolean),
      known,
    };
  }
  return { v: 1, savedAt: now, hubs };
}

/** Reads a stored index defensively; unknown or broken entries are dropped. */
export function parseIndex(raw: string | null): Record<string, HubHistory> {
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!v || typeof v !== 'object' || (v as { v?: unknown }).v !== 1) return {};
  const hubs = (v as { hubs?: unknown }).hubs;
  if (!hubs || typeof hubs !== 'object') return {};
  const out: Record<string, HubHistory> = {};
  for (const [hubId, raw] of Object.entries(hubs as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const byId: Record<string, PastSession> = {};
    const order: string[] = [];
    for (const list of [c.sessions, c.known]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const parsed = parsePastSession(item);
        if (!parsed || parsed.sessionId in byId) continue;
        // Older builds cached `resumable: false` for folders outside the allowed roots; it never gates now.
        const s = { ...parsed, resumable: true };
        byId[s.sessionId] = s;
        if (list === c.sessions) order.push(s.sessionId);
      }
    }
    const support: HistorySupport = c.support === 'history' || c.support === 'legacy' ? c.support : 'unknown';
    const nextCursor = typeof c.nextCursor === 'string' ? c.nextCursor : c.nextCursor === null ? null : undefined;
    out[hubId] = { ...emptyHubHistory, byId, order: sortIds(byId, order), nextCursor, support };
  }
  return out;
}

export type CachedTranscript = { v: 1; hubId: string; sessionId: string; savedAt: number; items: TranscriptItem[]; hasMore: boolean };

/** The newest items of a transcript as kept on the phone (streaming marks dropped). */
export function cacheableTranscript(items: TranscriptItem[], hasMore: boolean): { items: TranscriptItem[]; hasMore: boolean } {
  const newest = items.slice(-CACHED_ITEMS).map((item) => {
    if (item.kind !== 'assistant' || !item.streaming) return item;
    const { streaming: _streaming, ...rest } = item;
    return rest;
  });
  return { items: newest, hasMore: hasMore || items.length > newest.length };
}

/** Transcript files on the phone, most recently opened first. */
export type ManifestEntry = { key: string; file: string; savedAt: number };

/** Puts `entry` first; returns the new manifest and the entries pushed out by the bound. */
export function touchManifest(
  manifest: ManifestEntry[],
  entry: ManifestEntry,
  max = MAX_CACHED_TRANSCRIPTS,
): { manifest: ManifestEntry[]; evicted: ManifestEntry[] } {
  const rest = manifest.filter((m) => m.key !== entry.key);
  const next = [entry, ...rest];
  return { manifest: next.slice(0, max), evicted: next.slice(max) };
}

/** A stable file name for a transcript key (FNV-1a, hex). */
export function transcriptFileName(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `t-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}.json`;
}

export function parseManifest(raw: string | null): ManifestEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (m): m is ManifestEntry =>
        !!m && typeof m.key === 'string' && typeof m.file === 'string' && /^t-[0-9a-f]{16}\.json$/.test(m.file) && typeof m.savedAt === 'number',
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Resume errors
// ---------------------------------------------------------------------------

/** Plain words for a failed `session.resume` (codes from the contract). */
export function resumeErrorText(code: string | null, message: string, host: string): string {
  const folder = /folder no longer exists:\s*(.+)$/i.exec(message)?.[1]?.trim();
  switch (code) {
    case 'not_found':
      return `${host} no longer has this session.`;
    case 'forbidden':
      return message || `${host} refused to resume this session.`;
    case 'bad_request':
      if (folder) return `The folder ${folder} no longer exists on ${host}.`;
      if (/unknown frame type/i.test(message)) return `Update phi on ${host} to resume sessions.`;
      return message || `${host} could not resume this session.`;
    case 'timeout':
      return `${host} did not start the session in time.`;
    default:
      return message || `${host} could not resume this session.`;
  }
}
