/**
 * Connection log: what each computer's connection did, kept on the phone (the newest
 * TRACE_LIMIT events per computer, saved to a file) so a slow or failed reconnect can be read
 * after the fact — Settings › Computers › a computer › Connection log, and Copy to share it.
 * Pure (storage behind the history cache's FileStore; the app passes a file in Documents).
 */

import type { FileStore } from './history-cache';
import { displayHost } from './pairing';

/** Events kept per computer. */
export const TRACE_LIMIT = 300;
export const TRACE_FILE = 'connection-log.json';

export type TraceKind =
  /** The app started (text: version and build). */
  | 'launch'
  /** A connection attempt to `url` began (text: the round and why). */
  | 'attempt'
  /** The socket opened and hello was sent (ms: since the attempt began). */
  | 'open'
  /** The computer answered hello: live (ms: since the attempt began). */
  | 'welcome'
  /** An attempt failed (ms: since it began; code: close code; text: why). */
  | 'fail'
  /** A live connection ended (ms: how long it was live; code; text). */
  | 'drop'
  /** Waiting before the next round (ms: the wait; text: why). */
  | 'retry'
  /** Still not connected after the first attempts: shown offline from now on. */
  | 'offline'
  /** A live connection was checked with a ping (ms: the answer time; text: the result). */
  | 'probe'
  /** The live connection stopped answering pings. */
  | 'ping-timeout'
  /** Reconnecting at once, backoff reset (text: why: network change, foreground …). */
  | 'kick'
  /** The network path changed (text: type, or "none"). */
  | 'network'
  | 'foreground'
  | 'background'
  /** The connection was closed because the app is in the background. */
  | 'pause'
  /** Pairing expired (4401) or an incompatible phi (4426). */
  | 'terminal'
  | 'stop';

export type TraceEvent = { at: number; kind: TraceKind; url?: string; ms?: number; code?: number; text?: string };
export type TraceInput = Omit<TraceEvent, 'at'> & { at?: number };

type Listener = () => void;

const KINDS = new Set<TraceKind>([
  'launch',
  'attempt',
  'open',
  'welcome',
  'fail',
  'drop',
  'retry',
  'offline',
  'probe',
  'ping-timeout',
  'kick',
  'network',
  'foreground',
  'background',
  'pause',
  'terminal',
  'stop',
]);

function parseEvent(v: unknown): TraceEvent | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== 'number' || !Number.isFinite(o.at) || !KINDS.has(o.kind as TraceKind)) return null;
  const e: TraceEvent = { at: o.at, kind: o.kind as TraceKind };
  if (typeof o.url === 'string') e.url = o.url.slice(0, 200);
  if (typeof o.ms === 'number' && Number.isFinite(o.ms)) e.ms = o.ms;
  if (typeof o.code === 'number' && Number.isFinite(o.code)) e.code = o.code;
  if (typeof o.text === 'string') e.text = o.text.slice(0, 300);
  return e;
}

/** Reads a saved log defensively: hubId → events, oldest first, at most `limit` each. */
export function parseTraceFile(raw: string | null, limit = TRACE_LIMIT): Record<string, TraceEvent[]> {
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  const hubs = v && typeof v === 'object' && (v as { v?: unknown }).v === 1 ? (v as { hubs?: unknown }).hubs : null;
  if (!hubs || typeof hubs !== 'object') return {};
  const out: Record<string, TraceEvent[]> = {};
  for (const [hubId, list] of Object.entries(hubs as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const events = list.map(parseEvent).filter((e): e is TraceEvent => e !== null);
    events.sort((a, b) => a.at - b.at);
    out[hubId] = events.slice(-limit);
  }
  return out;
}

/**
 * Per-computer ring buffers of connection events. Recording is synchronous and cheap; saving is
 * debounced. Events recorded before `load()` finishes are kept after the saved ones.
 */
export class ConnTrace {
  private readonly files: FileStore | null;
  private readonly limit: number;
  private readonly saveDelayMs: number;
  private readonly now: () => number;
  private readonly onEvent?: (hubId: string, e: TraceEvent) => void;
  private readonly hubs = new Map<string, TraceEvent[]>();
  private readonly listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private loaded = false;
  private chain: Promise<unknown> = Promise.resolve();
  private versionValue = 0;

  constructor(opts: {
    files?: FileStore | null;
    limit?: number;
    saveDelayMs?: number;
    now?: () => number;
    /** Every event as it is recorded (QA: the Simulator log). */
    onEvent?: (hubId: string, e: TraceEvent) => void;
  } = {}) {
    this.files = opts.files ?? null;
    this.limit = opts.limit ?? TRACE_LIMIT;
    this.saveDelayMs = opts.saveDelayMs ?? 1_000;
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent;
  }

  /** Bumps on every change (for useSyncExternalStore). */
  get version(): number {
    return this.versionValue;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(hubId: string, input: TraceInput): void {
    const e: TraceEvent = { ...input, at: input.at ?? this.now() };
    let list = this.hubs.get(hubId);
    if (!list) this.hubs.set(hubId, (list = []));
    list.push(e);
    if (list.length > this.limit) list.splice(0, list.length - this.limit);
    this.onEvent?.(hubId, e);
    this.changed();
  }

  /** One event in every computer's log (launch, network change, foreground …). */
  recordAll(hubIds: Iterable<string>, input: TraceInput): void {
    const at = input.at ?? this.now();
    for (const hubId of hubIds) this.record(hubId, { ...input, at });
  }

  /** A computer's events, oldest first. */
  events(hubId: string): TraceEvent[] {
    return this.hubs.get(hubId) ?? [];
  }

  hubIds(): string[] {
    return [...this.hubs.keys()];
  }

  removeHub(hubId: string): void {
    if (!this.hubs.delete(hubId)) return;
    this.changed();
  }

  /** Forgets the logs of computers that are no longer paired. */
  retain(hubIds: Iterable<string>): void {
    const keep = new Set(hubIds);
    let changed = false;
    for (const id of [...this.hubs.keys()]) {
      if (keep.has(id)) continue;
      this.hubs.delete(id);
      changed = true;
    }
    if (changed) this.changed();
  }

  /** Reads the saved log; events recorded meanwhile stay (newest), the oldest beyond the bound go. */
  async load(): Promise<void> {
    if (this.loaded || !this.files) {
      this.loaded = true;
      return;
    }
    const raw = await this.files.read(TRACE_FILE).catch(() => null);
    this.loaded = true;
    const saved = parseTraceFile(raw, this.limit);
    for (const [hubId, old] of Object.entries(saved)) {
      const recent = this.hubs.get(hubId) ?? [];
      const firstRecent = recent[0]?.at ?? Infinity;
      const merged = [...old.filter((e) => e.at <= firstRecent), ...recent];
      this.hubs.set(hubId, merged.slice(-this.limit));
    }
    this.changed();
  }

  /** Writes now (app going to the background). */
  flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.files || !this.dirty || !this.loaded) return this.chain.then(() => undefined);
    this.dirty = false;
    const body = JSON.stringify({ v: 1, savedAt: this.now(), hubs: Object.fromEntries(this.hubs) });
    const files = this.files;
    const next = this.chain.then(() => files.write(TRACE_FILE, body));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private changed(): void {
    this.versionValue += 1;
    this.dirty = true;
    for (const l of this.listeners) l();
    if (!this.files || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.loaded) {
        this.dirty = true;
        return;
      }
      void this.flush().catch(() => undefined);
    }, this.saveDelayMs);
  }
}

// ---------------------------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------------------------

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** 16:28:38.274 (local time). */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 2026-11-04 (local date). */
export function dayOf(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 412 ms, 8.0 s, 2m 03s. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

const LABEL: Record<TraceKind, string> = {
  launch: 'app started',
  attempt: 'connecting',
  open: 'socket open',
  welcome: 'live',
  fail: 'failed',
  drop: 'dropped',
  retry: 'retry in',
  offline: 'offline',
  probe: 'check',
  'ping-timeout': 'no pong',
  kick: 'reconnect now',
  network: 'network',
  foreground: 'foreground',
  background: 'background',
  pause: 'paused',
  terminal: 'stopped',
  stop: 'removed',
};

/** The event without its time: "failed 127.0.0.1:7811 · 8.0 s · Timed out connecting". */
export function describeEvent(e: TraceEvent): string {
  const parts: string[] = [];
  if (e.kind === 'retry') parts.push(`${LABEL.retry} ${formatDuration(e.ms ?? 0)}`);
  else parts.push(LABEL[e.kind]);
  if (e.url) parts.push(displayHost(e.url));
  const tail: string[] = [];
  if (e.ms !== undefined && e.kind !== 'retry') tail.push(formatDuration(e.ms));
  if (e.code !== undefined) tail.push(`code ${e.code}`);
  if (e.text) tail.push(e.text);
  return tail.length ? `${parts.join(' ')} · ${tail.join(' · ')}` : parts.join(' ');
}

/** "16:28:38.274  failed 127.0.0.1:7811 · 8.0 s · Timed out connecting". */
export function formatTraceLine(e: TraceEvent): string {
  return `${clockTime(e.at)}  ${describeEvent(e)}`;
}

export type TraceLogRow = { key: string; day?: string; line: string };

/** Newest first, with a day line before each day's events when the log spans more than one. */
export function traceRows(events: TraceEvent[]): TraceLogRow[] {
  const rows: TraceLogRow[] = [];
  const multiDay = events.length > 0 && dayOf(events[0].at) !== dayOf(events[events.length - 1].at);
  let day = '';
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const d = dayOf(e.at);
    if (multiDay && d !== day) {
      day = d;
      rows.push({ key: `d:${d}:${i}`, day: d, line: d });
    }
    rows.push({ key: `e:${i}:${e.at}`, line: formatTraceLine(e) });
  }
  return rows;
}

export type TraceReportHost = { hubId: string; name: string; status: string; urls: string[]; events: TraceEvent[] };

/** Everything Copy puts on the clipboard: app, time, then each computer's log (oldest first). */
export function formatTraceReport(input: { app: { version: string; build: string }; now: number; device?: string; hosts: TraceReportHost[] }): string {
  const offsetMin = -new Date(input.now).getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const zone = `UTC${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
  const lines = [
    'phi remote connection log',
    `App ${input.app.version} (${input.app.build})${input.device ? ` on ${input.device}` : ''}`,
    `Copied ${dayOf(input.now)} ${clockTime(input.now)} ${zone} (${new Date(input.now).toISOString()})`,
  ];
  for (const h of input.hosts) {
    lines.push('', `== ${h.name} (${h.hubId}) · ${h.status}`, `Addresses: ${h.urls.map(displayHost).join(', ') || 'none'}`);
    if (!h.events.length) {
      lines.push('(no events)');
      continue;
    }
    let day = '';
    for (const e of h.events) {
      const d = dayOf(e.at);
      if (d !== day) {
        day = d;
        lines.push(`-- ${d}`);
      }
      lines.push(formatTraceLine(e));
    }
  }
  return `${lines.join('\n')}\n`;
}
