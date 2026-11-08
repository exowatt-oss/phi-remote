/** Small pure formatting helpers shared by screens. */

import type { SessionSummary } from './protocol';

/** `/Users/me/x` or `/home/me/x` → `~/x`. The hub's $HOME is not in the protocol, so infer it. */
export function shortCwd(cwd: string): string {
  if (!cwd) return '';
  const m = /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root)(\/.*)?$/.exec(cwd);
  if (m) return `~${m[1] ?? ''}`;
  return cwd;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Compact relative time: now, 4m, 2h, 3d, then "Oct 3". */
export function relativeTime(ts: number, now: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  const date = new Date(ts);
  const sameYear = new Date(now).getFullYear() === date.getFullYear();
  return `${MONTHS[date.getMonth()]} ${date.getDate()}${sameYear ? '' : `, ${date.getFullYear()}`}`;
}

/** "Last seen" phrasing built on relativeTime. */
export function lastSeen(ts: number | null | undefined, now: number): string {
  if (!ts) return 'Not seen yet';
  const r = relativeTime(ts, now);
  return r === 'now' ? 'Seen just now' : /^\d/.test(r) ? `Seen ${r} ago` : `Seen ${r}`;
}

/** Target size so the long side is ≤ max; null when no resize is needed. */
export function fitWithin(width: number, height: number, max = 1600): { width: number; height: number } | null {
  const long = Math.max(width, height);
  if (!(long > max) || width <= 0 || height <= 0) return null;
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Human model label: explicit name, else the id without a vendor prefix. */
export function modelLabel(model: SessionSummary['model'] | undefined): string {
  if (!model) return '';
  if (model.name) return model.name;
  const slash = model.id.lastIndexOf('/');
  return slash >= 0 ? model.id.slice(slash + 1) : model.id;
}

/** Router path for a session. */
export function sessionHref(hubId: string, sessionId: string): string {
  return `/session/${encodeURIComponent(hubId)}/${encodeURIComponent(sessionId)}`;
}

/** Approximate decoded byte size of base64 data. */
export function base64Bytes(data: string): number {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - pad;
}

const json = (v: unknown, space?: number): string => {
  try {
    return JSON.stringify(v, null, space) ?? String(v);
  } catch {
    return String(v);
  }
};

/** Edit-tool args ({ edits: [{ oldText, newText }] } or { oldText, newText }) as a -/+ diff. */
function editDiff(args: Record<string, unknown>): string | null {
  const list = Array.isArray(args.edits) ? args.edits : 'oldText' in args && 'newText' in args ? [args] : null;
  if (!list || list.length === 0) return null;
  const side = (text: string, mark: string) =>
    text
      .replace(/\n$/, '')
      .split('\n')
      .map((l) => `${mark} ${l}`);
  const blocks: string[] = [];
  for (const e of list) {
    const { oldText, newText } = (e ?? {}) as Record<string, unknown>;
    if (typeof oldText !== 'string' || typeof newText !== 'string') return null;
    blocks.push([...side(oldText, '-'), ...side(newText, '+')].join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * Tool args as readable text, not escaped JSON: `key: value` lines, multi-line strings as
 * indented blocks, edits as a -/+ diff, anything nested as indented JSON.
 */
export function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args;
  if (typeof args !== 'object' || Array.isArray(args)) return json(args, 2);
  const record = args as Record<string, unknown>;
  const diff = editDiff(record);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (diff && (key === 'edits' || key === 'oldText' || key === 'newText')) continue;
    if (typeof value === 'string') {
      lines.push(value.includes('\n') ? `${key}:\n${value.replace(/\n$/, '').replace(/^/gm, '  ')}` : `${key}: ${value}`);
    } else if (value === null || typeof value !== 'object') {
      lines.push(`${key}: ${String(value)}`);
    } else {
      lines.push(`${key}: ${json(value, 2)}`);
    }
  }
  if (diff) lines.push(diff);
  return lines.join('\n');
}

/** Splits a tool summary like "bash  ls -la" into the tool name and the rest. */
export function splitToolSummary(summary: string, name?: string): { tool: string; detail: string } {
  const m = /^(\S+)\s+([\s\S]*)$/.exec(summary.trim());
  if (m && (!name || m[1] === name)) return { tool: m[1], detail: m[2].trim() };
  if (name && summary.trim() !== name) return { tool: name, detail: summary.trim() };
  return { tool: summary.trim(), detail: '' };
}

/** Infers the remote home directory from absolute paths like /Users/me/x or /home/me/x. */
export function inferHome(paths: string[]): string | null {
  for (const p of paths) {
    const m = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?:\/|$)/.exec(p);
    if (m) return m[1];
  }
  return null;
}

/** Expands a leading ~ using the inferred home; returns the input unchanged otherwise. */
export function expandHome(path: string, home: string | null): string {
  const p = path.trim();
  if (!home || !p.startsWith('~')) return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return `${home}${p.slice(1)}`;
  return p;
}

/** Elapsed time, T3 style: "12s", "4m 05s", "1h 04m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h === 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** Dictation clock: "0:07", "1:42". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Clock time for message meta rows, e.g. "14:05" (locale-aware). */
export function clockTime(ts: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    const d = new Date(ts);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

export type MachineSymbol = 'laptopcomputer' | 'desktopcomputer' | 'server.rack';

/** SF Symbol for a computer, guessed from its name. */
export function machineSymbol(name: string): MachineSymbol {
  const n = name.toLowerCase();
  if (/macbook|laptop|book|air\b|thinkpad|xps/.test(n)) return 'laptopcomputer';
  if (/server|devbox|box|linux|ubuntu|debian|vm|ec2|pve|node|host|rack|cloud/.test(n)) return 'server.rack';
  return 'desktopcomputer';
}

/** Thread title: the session name without a leading "phi — ", else the first line of text. */
export function threadTitle(name: string, lastText?: string): string {
  const cleaned = name.replace(/^phi\s*[—–-]\s*/i, '').trim();
  if (cleaned) return cleaned;
  const first = lastText?.split('\n').find((l) => l.trim())?.trim();
  return first || 'New session';
}

/**
 * One-line plain-text preview of a markdown reply for the threads list: no backticks,
 * emphasis markers, headings, list bullets, fences or table rules; table cells joined
 * with " · "; links reduced to their text. Hubs already send `lastText` as one line, so
 * tables arrive inline ("one: | File | Change | |---|---| | a.ts | fix |").
 */
export function plainPreview(text: string | undefined): string {
  if (!text) return '';
  const table = /\|\s*:?-{3,}/.test(text);
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '');
    if (line && !/^(`{3,}|~{3,})/.test(line)) lines.push(line);
  }
  // Fences that arrive inline ("``` ts it(…) ```") lose their language tag as well.
  let out = lines.join(' ').replace(/(`{3,}|~{3,})[\w+-]*\s?/g, ' ');
  if (table) {
    out = out
      .replace(/\|?(\s*:?-{3,}:?\s*\|)+(\s*:?-{3,}:?)?/g, ' ')
      .replace(/\s*\|\s*/g, ' · ')
      .replace(/(\s*·\s*)+/g, ' · ')
      .replace(/^\s*·\s*|\s*·\s*$/g, '')
      .replace(/:\s*·\s*/g, ': ');
  }
  return out
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Args worth showing under a tool row: only what the summary does not already say. */
export function argsBeyondSummary(args: unknown, summary: string): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return summary.includes(args.trim()) ? '' : args;
  if (typeof args === 'object' && !Array.isArray(args)) {
    const said = (v: unknown) => (typeof v === 'string' || typeof v === 'number') && summary.includes(String(v).trim());
    const rest = Object.fromEntries(Object.entries(args as Record<string, unknown>).filter(([, v]) => !said(v)));
    return Object.keys(rest).length === 0 ? '' : formatArgs(rest);
  }
  return formatArgs(args);
}

export type ToolSymbol = 'terminal' | 'eye' | 'square.and.pencil' | 'magnifyingglass' | 'globe' | 'sparkles' | 'wrench';

/** SF Symbol for a tool name (T3 work-log icons). */
export function toolSymbol(name: string): ToolSymbol {
  const n = name.toLowerCase();
  if (/bash|shell|exec|run|command|terminal/.test(n)) return 'terminal';
  if (/^read|view|cat|open/.test(n)) return 'eye';
  if (/edit|write|patch|apply|create|replace/.test(n)) return 'square.and.pencil';
  if (/grep|find|search|ls|glob|list/.test(n)) return 'magnifyingglass';
  if (/web|fetch|http|browse|url/.test(n)) return 'globe';
  if (/agent|task|subagent|delegate/.test(n)) return 'sparkles';
  return 'wrench';
}
