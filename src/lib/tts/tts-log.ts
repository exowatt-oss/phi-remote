/**
 * The read-aloud log: what the natural voice did on this phone (downloads, every load attempt
 * with its compute units, timing and error, foreground/background, memory warnings, which voice
 * each read used and why), kept as a ring buffer of the newest TTS_LOG_LIMIT events in
 * Documents/diagnostics/tts-log.json. The sibling of the connection log (conn-trace.ts): Settings ›
 * Voice › Diagnostics shows the newest events and copies them with the rest of the report.
 * Pure (storage behind the history cache's FileStore).
 */

import type { FileStore } from '../history-cache';

export const TTS_LOG_LIMIT = 200;
export const TTS_LOG_FILE = 'tts-log.json';

export type TtsLogKind =
  | 'launch'
  | 'model'
  | 'download'
  | 'load'
  | 'attempt'
  | 'stage'
  | 'loaded'
  | 'load-fail'
  | 'unload'
  | 'foreground'
  | 'background'
  | 'memory'
  | 'read'
  | 'guard'
  | 'retry';

export type TtsLogEvent = { at: number; kind: TtsLogKind; text: string; ms?: number };

const KINDS = new Set<TtsLogKind>([
  'launch',
  'model',
  'download',
  'load',
  'attempt',
  'stage',
  'loaded',
  'load-fail',
  'unload',
  'foreground',
  'background',
  'memory',
  'read',
  'guard',
  'retry',
]);

function parseEvent(v: unknown): TtsLogEvent | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== 'number' || !Number.isFinite(o.at) || !KINDS.has(o.kind as TtsLogKind)) return null;
  const e: TtsLogEvent = { at: o.at, kind: o.kind as TtsLogKind, text: typeof o.text === 'string' ? o.text.slice(0, 400) : '' };
  if (typeof o.ms === 'number' && Number.isFinite(o.ms)) e.ms = o.ms;
  return e;
}

export function parseTtsLog(raw: string | null, limit = TTS_LOG_LIMIT): TtsLogEvent[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as { v?: unknown; events?: unknown };
    if (!v || v.v !== 1 || !Array.isArray(v.events)) return [];
    const events = v.events.map(parseEvent).filter((e): e is TtsLogEvent => e !== null);
    events.sort((a, b) => a.at - b.at);
    return events.slice(-limit);
  } catch {
    return [];
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** "2026-11-05 12:34:56.789" in local time. */
export function stamp(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function formatMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

/** One line per event, oldest first: "12:34:56.789 attempt ane (timeout 120 s)  1.20 s". */
export function formatTtsEvent(e: TtsLogEvent): string {
  return `${stamp(e.at)} ${e.kind} ${e.text}${e.ms !== undefined ? ` · ${formatMs(e.ms)}` : ''}`;
}

type Listener = () => void;

/** A ring buffer of TTS events. Recording is synchronous; saving is debounced. */
export class TtsLog {
  private readonly files: FileStore | null;
  private readonly limit: number;
  private readonly saveDelayMs: number;
  private readonly now: () => number;
  private readonly onEvent?: (e: TtsLogEvent) => void;
  private list: TtsLogEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;
  private versionValue = 0;

  constructor(
    opts: { files?: FileStore | null; limit?: number; saveDelayMs?: number; now?: () => number; onEvent?: (e: TtsLogEvent) => void } = {},
  ) {
    this.files = opts.files ?? null;
    this.limit = opts.limit ?? TTS_LOG_LIMIT;
    this.saveDelayMs = opts.saveDelayMs ?? 1_000;
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent;
  }

  get version(): number {
    return this.versionValue;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(kind: TtsLogKind, text: string, ms?: number): void {
    const e: TtsLogEvent = { at: this.now(), kind, text: text.slice(0, 400) };
    if (ms !== undefined && Number.isFinite(ms)) e.ms = Math.round(ms);
    this.list.push(e);
    if (this.list.length > this.limit) this.list.splice(0, this.list.length - this.limit);
    this.onEvent?.(e);
    this.changed();
  }

  /** Oldest first; `last` keeps only the newest ones. */
  events(last?: number): TtsLogEvent[] {
    return last === undefined ? [...this.list] : this.list.slice(-last);
  }

  /** Reads the saved log; events recorded meanwhile stay (newest). */
  async load(): Promise<void> {
    if (this.loaded || !this.files) {
      this.loaded = true;
      return;
    }
    const raw = await this.files.read(TTS_LOG_FILE).catch(() => null);
    this.loaded = true;
    const saved = parseTtsLog(raw, this.limit);
    if (saved.length) this.list = [...saved, ...this.list].slice(-this.limit);
    if (this.list.length) this.changed();
  }

  /** Writes now (tests; the app relies on the debounce). */
  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.files) return;
    await this.files.write(TTS_LOG_FILE, JSON.stringify({ v: 1, events: this.list })).catch(() => undefined);
  }

  private changed(): void {
    this.versionValue += 1;
    for (const l of this.listeners) l();
    if (!this.files || !this.loaded || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, this.saveDelayMs);
  }
}
