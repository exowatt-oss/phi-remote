/**
 * Pairing: parse `phiremote://pair?...` links and manual input, then pair with a hub
 * per docs/PROTOCOL.md (probe each url with GET /v1/info, POST /v1/pair to the winner).
 */

import { DEFAULT_PORT, PROTOCOL_VERSION } from './protocol';

export const PAIR_LINK_VERSION = 1;
export const CODE_LENGTH = 8;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type PairingLink = {
  version: number;
  code: string;
  name?: string;
  hubId?: string;
  urls: string[];
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Decodes a query string, keeping repeated keys in order. Does not rely on URL/URLSearchParams. */
export function parseQuery(query: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawKey = eq >= 0 ? part.slice(0, eq) : part;
    const rawVal = eq >= 0 ? part.slice(eq + 1) : '';
    out.push([safeDecode(rawKey), safeDecode(rawVal)]);
  }
  return out;
}

function safeDecode(s: string): string {
  const plus = s.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plus);
  } catch {
    return plus;
  }
}

/**
 * Normalizes a pairing code: Crockford base32, 8 chars, case-insensitive. Spaces and dashes
 * are ignored; per Crockford, I/L read as 1 and O as 0. U is never valid.
 */
export function normalizeCode(raw: string): string | null {
  const cleaned = raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) if (!CROCKFORD.includes(ch)) return null;
  return cleaned;
}

/**
 * Normalizes a hub base URL. Accepts `http(s)://host[:port][/path]`, or a bare host / IP /
 * `host:port` (assumed http, default port 7717). Returns null when unusable.
 */
export function normalizeHubUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (/^wss?:\/\//i.test(s)) s = s.replace(/^ws/i, 'http');
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (hasScheme && !/^https?:\/\//i.test(s)) return null;
  if (!hasScheme) s = `http://${s}`;
  const m = /^(https?):\/\/([^/?#\s]+)([^?#\s]*)$/i.exec(s);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  let authority = m[2];
  let path = m[3] ?? '';
  if (authority.includes('@')) return null;
  const bracketed = authority.startsWith('[');
  const hasPort = bracketed ? /\]:\d+$/.test(authority) : /:\d+$/.test(authority);
  if (bracketed && !/^\[[0-9a-f:.]+\](:\d+)?$/i.test(authority)) return null;
  if (!bracketed && (authority.match(/:/g)?.length ?? 0) > 1) return null;
  if (!bracketed && !/^[a-z0-9.-]+(:\d+)?$/i.test(authority)) return null;
  if (!hasPort && !hasScheme) authority = `${authority}:${DEFAULT_PORT}`;
  authority = authority.toLowerCase();
  path = path.replace(/\/+$/, '');
  return `${scheme}://${authority}${path}`;
}

/** `http://h:7717` → `ws://h:7717/v1/ws`; https → wss. */
export function wsUrlFor(baseUrl: string): string {
  return `${baseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '')}/v1/ws`;
}

/** Host part of a base URL, for display. */
export function displayHost(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//i, '');
}

/**
 * Parses a pairing deep link or QR payload. Accepts `phiremote://pair?...`,
 * `phiremote:///pair?...`, or a bare `/pair?...` path (as delivered by the router).
 */
export function parsePairingLink(input: string): ParseResult<PairingLink> {
  const s = input.trim();
  const m = /^(?:phiremote:\/{1,3})?\/?pair\/?\?(.*)$/i.exec(s);
  if (!m) return { ok: false, error: 'Not a phi pairing code.' };
  const params = parseQuery(m[1].split('#')[0]);
  const get = (k: string) => params.find(([key]) => key === k)?.[1];
  const vRaw = get('v');
  const version = vRaw === undefined ? PAIR_LINK_VERSION : Number(vRaw);
  if (version !== PAIR_LINK_VERSION) {
    return { ok: false, error: 'This pairing code is from a newer phi. Update the app.' };
  }
  const codeRaw = get('code');
  const code = codeRaw ? normalizeCode(codeRaw) : null;
  if (!code) return { ok: false, error: 'The pairing code is missing or malformed.' };
  const urls: string[] = [];
  for (const [k, v] of params) {
    if (k !== 'url') continue;
    const u = normalizeHubUrl(v);
    if (u && !urls.includes(u)) urls.push(u);
  }
  if (urls.length === 0) return { ok: false, error: 'The pairing code has no address to connect to.' };
  const name = get('name')?.trim() || undefined;
  const hubId = get('hubId')?.trim() || undefined;
  const link: PairingLink = { version, code, urls };
  if (name) link.name = name;
  if (hubId) link.hubId = hubId;
  return { ok: true, value: link };
}

/** Builds a pairing link (used for tests and for "re-pair" prefill). */
export function buildPairingLink(link: Omit<PairingLink, 'version'> & { version?: number }): string {
  const parts = [`v=${link.version ?? PAIR_LINK_VERSION}`, `code=${encodeURIComponent(link.code)}`];
  if (link.name) parts.push(`name=${encodeURIComponent(link.name)}`);
  if (link.hubId) parts.push(`hubId=${encodeURIComponent(link.hubId)}`);
  for (const u of link.urls) parts.push(`url=${encodeURIComponent(u)}`);
  return `phiremote://pair?${parts.join('&')}`;
}

// ---------------------------------------------------------------------------
// Pairing flow
// ---------------------------------------------------------------------------

export type HubInfo = { name: string; hubId: string; hubVersion: string; protocol: number };

export type PairedHost = {
  hubId: string;
  name: string;
  urls: string[];
  preferredUrl: string;
  deviceId: string;
  token: string;
  pairedAt: number;
};

export type PairingErrorCode =
  | 'unreachable'
  | 'hub_mismatch'
  | 'invalid_code'
  | 'rate_limited'
  | 'incompatible'
  | 'bad_response';

export class PairingError extends Error {
  readonly code: PairingErrorCode;
  constructor(code: PairingErrorCode, message: string) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
  }
}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type PairDeps = {
  fetch: FetchLike;
  now?: () => number;
  infoTimeoutMs?: number;
  pairTimeoutMs?: number;
};

/** Runs `fn` with an AbortSignal that fires after `ms`; rejects on timeout even if abort is ignored. */
export async function withTimeout<T>(ms: number, fn: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error('timeout'));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller?.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseInfo(v: unknown): HubInfo | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.hubId !== 'string' || !o.hubId) return null;
  return {
    hubId: o.hubId,
    name: typeof o.name === 'string' ? o.name : '',
    hubVersion: typeof o.hubVersion === 'string' ? o.hubVersion : '',
    protocol: typeof o.protocol === 'number' ? o.protocol : 0,
  };
}

/** GET <baseUrl>/v1/info with a timeout. Resolves null when unreachable or malformed. */
export async function fetchHubInfo(fetchImpl: FetchLike, baseUrl: string, timeoutMs = 2500): Promise<HubInfo | null> {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await fetchImpl(`${baseUrl}/v1/info`, { method: 'GET', signal });
      if (!res.ok) return null;
      return parseInfo(await res.json());
    });
  } catch {
    return null;
  }
}

export type PairRequest = {
  urls: string[];
  code: string;
  hubId?: string;
  name?: string;
  deviceName: string;
};

/**
 * Probes each url in order with GET /v1/info (2.5 s each) until one answers with the expected
 * hubId (or any hub, for manual entry without a hubId), then POSTs /v1/pair to it.
 */
export async function pairWithHub(req: PairRequest, deps: PairDeps): Promise<PairedHost> {
  const code = normalizeCode(req.code);
  if (!code) throw new PairingError('invalid_code', 'Enter the 8-character code shown by phi remote pair.');
  const urls = req.urls.map((u) => normalizeHubUrl(u)).filter((u): u is string => !!u);
  if (urls.length === 0) throw new PairingError('unreachable', 'Enter the address shown by phi remote pair.');

  let winner: { url: string; info: HubInfo } | null = null;
  let sawMismatch = false;
  for (const url of urls) {
    const info = await fetchHubInfo(deps.fetch, url, deps.infoTimeoutMs ?? 2500);
    if (!info) continue;
    if (req.hubId && info.hubId !== req.hubId) {
      sawMismatch = true;
      continue;
    }
    winner = { url, info };
    break;
  }
  if (!winner) {
    if (sawMismatch) {
      throw new PairingError('hub_mismatch', 'That address answers, but it is a different computer.');
    }
    const label = req.name ? req.name : 'the computer';
    throw new PairingError(
      'unreachable',
      `Couldn't reach ${label}. Check that Tailscale is connected on both devices and phi remote is running.`,
    );
  }
  if (winner.info.protocol !== PROTOCOL_VERSION) {
    throw new PairingError(
      'incompatible',
      winner.info.protocol > PROTOCOL_VERSION
        ? 'This computer runs a newer phi remote. Update the app.'
        : 'This computer runs an older phi remote. Update phi on it.',
    );
  }

  let res: Awaited<ReturnType<FetchLike>>;
  let body: unknown;
  try {
    ({ res, body } = await withTimeout(deps.pairTimeoutMs ?? 10000, async (signal) => {
      const r = await deps.fetch(`${winner.url}/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ code, deviceName: req.deviceName, platform: 'ios' }),
        signal,
      });
      let b: unknown = null;
      try {
        b = await r.json();
      } catch {
        b = null;
      }
      return { res: r, body: b };
    }));
  } catch {
    throw new PairingError('unreachable', 'The computer stopped answering while pairing. Try again.');
  }

  if (res.status === 401) {
    throw new PairingError('invalid_code', 'That code is wrong or expired. Run phi remote pair again for a new one.');
  }
  if (res.status === 429) {
    throw new PairingError('rate_limited', 'Too many attempts. Wait a minute, then try again.');
  }
  if (!res.ok || typeof body !== 'object' || body === null) {
    throw new PairingError('bad_response', `Pairing failed (HTTP ${res.status}).`);
  }
  const b = body as Record<string, unknown>;
  if (typeof b.deviceId !== 'string' || typeof b.token !== 'string' || !b.token) {
    throw new PairingError('bad_response', 'Pairing failed: the computer sent an unexpected reply.');
  }
  const hubId = typeof b.hubId === 'string' && b.hubId ? b.hubId : winner.info.hubId;
  if (hubId !== winner.info.hubId) {
    throw new PairingError('bad_response', 'Pairing failed: the computer identified itself inconsistently.');
  }
  const name =
    (typeof b.name === 'string' && b.name) || winner.info.name || req.name || displayHost(winner.url);
  return {
    hubId,
    name,
    urls,
    preferredUrl: winner.url,
    deviceId: b.deviceId,
    token: b.token,
    pairedAt: (deps.now ?? Date.now)(),
  };
}
