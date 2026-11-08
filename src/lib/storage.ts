/**
 * Persistence for paired hosts and app preferences behind a tiny key-value interface.
 * The app backs it with expo-secure-store (device tokens are secrets); tests use memory.
 */

import { isDictationMic, type DictationMic } from './dictation-mic';
import { parseOverseerDefaults, type OverseerDefaults } from './overseer';
import type { PairedHost } from './pairing';
import { isTtsVoicePref } from './tts/voices';

export interface SecureKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export type StoredHost = PairedHost & { lastSeenAt?: number };

/** A model as remembered for new threads (name/reasoning kept for labels while offline). */
export type SavedModel = { provider: string; id: string; name?: string; reasoning?: boolean };

/** Model and effort for new threads. A missing field means the computer's phi default. */
export type NewThreadDefault = { model?: SavedModel; thinkingLevel?: string };

export type Prefs = {
  /** Explicit user choice; undefined until the user touches the switch. */
  notifications?: 'on' | 'off';
  /** Read-aloud rate multiplier (1 = normal). */
  speechRate?: number;
  /** System read-aloud voice identifier; undefined = best installed voice. */
  voiceId?: string;
  /** Read-aloud voice: a natural (Kokoro) voice id or 'system'; undefined = the default natural voice. */
  ttsVoice?: string;
  /** Read finished replies in the open thread aloud automatically (off unless set). */
  autoRead?: boolean;
  /** Model and effort every new thread starts with (absent = phi's defaults). */
  newThread?: NewThreadDefault;
  /** The microphone dictation records from when headphones are connected (absent = the iPhone's own). */
  dictationMic?: DictationMic;
  /** Defaults for the threads of overseers started from this iPhone (absent = DEFAULT_OVERSEER). */
  overseer?: OverseerDefaults;
};

const INDEX_KEY = 'phiremote.hosts.v1';
const PREFS_KEY = 'phiremote.prefs.v1';

/** SecureStore keys allow only [A-Za-z0-9._-]; escape everything else reversibly. */
export function hostStorageKey(hubId: string): string {
  let out = '';
  for (const ch of hubId) {
    out += /[A-Za-z0-9.-]/.test(ch) ? ch : `_${ch.codePointAt(0)!.toString(16)}_`;
  }
  return `phiremote.host.${out}`;
}

function parseHost(raw: string | null): StoredHost | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredHost>;
    if (
      typeof v.hubId !== 'string' ||
      typeof v.token !== 'string' ||
      typeof v.deviceId !== 'string' ||
      !Array.isArray(v.urls) ||
      v.urls.length === 0
    ) {
      return null;
    }
    const urls = v.urls.filter((u): u is string => typeof u === 'string');
    if (urls.length === 0) return null;
    const host: StoredHost = {
      hubId: v.hubId,
      name: typeof v.name === 'string' && v.name ? v.name : v.hubId,
      urls,
      preferredUrl: typeof v.preferredUrl === 'string' && v.preferredUrl ? v.preferredUrl : urls[0],
      deviceId: v.deviceId,
      token: v.token,
      pairedAt: typeof v.pairedAt === 'number' ? v.pairedAt : 0,
    };
    if (typeof v.lastSeenAt === 'number') host.lastSeenAt = v.lastSeenAt;
    return host;
  } catch {
    return null;
  }
}

const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** Defensive parse of a stored `Prefs.newThread`; undefined when nothing usable is left. */
export function parseNewThreadDefault(raw: unknown): NewThreadDefault | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  const out: NewThreadDefault = {};
  const m = v.model as Record<string, unknown> | undefined;
  if (m && typeof m === 'object' && isName(m.provider) && isName(m.id)) {
    const model: SavedModel = { provider: m.provider, id: m.id };
    if (isName(m.name)) model.name = m.name;
    if (typeof m.reasoning === 'boolean') model.reasoning = m.reasoning;
    out.model = model;
  }
  if (typeof v.thinkingLevel === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(v.thinkingLevel)) out.thinkingLevel = v.thinkingLevel;
  return out.model || out.thinkingLevel ? out : undefined;
}

export class HostStorage {
  private readonly kv: SecureKV;
  /** Serializes writes so index updates never interleave. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(kv: SecureKV) {
    this.kv = kv;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async readIndex(): Promise<string[]> {
    const raw = await this.kv.get(INDEX_KEY);
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  async loadAll(): Promise<StoredHost[]> {
    const ids = await this.readIndex();
    const hosts: StoredHost[] = [];
    for (const id of ids) {
      const host = parseHost(await this.kv.get(hostStorageKey(id)));
      if (host && host.hubId === id) hosts.push(host);
    }
    return hosts;
  }

  /** Writes the host record, then adds it to the index (append order = display order). */
  save(host: StoredHost): Promise<void> {
    return this.serial(async () => {
      await this.kv.set(hostStorageKey(host.hubId), JSON.stringify(host));
      const ids = await this.readIndex();
      if (!ids.includes(host.hubId)) {
        ids.push(host.hubId);
        await this.kv.set(INDEX_KEY, JSON.stringify(ids));
      }
    });
  }

  remove(hubId: string): Promise<void> {
    return this.serial(async () => {
      const ids = await this.readIndex();
      if (ids.includes(hubId)) {
        await this.kv.set(INDEX_KEY, JSON.stringify(ids.filter((id) => id !== hubId)));
      }
      await this.kv.remove(hostStorageKey(hubId));
    });
  }

  async loadPrefs(): Promise<Prefs> {
    const raw = await this.kv.get(PREFS_KEY);
    if (!raw) return {};
    try {
      const v = JSON.parse(raw) as Record<string, unknown>;
      const prefs: Prefs = {};
      if (v.notifications === 'on' || v.notifications === 'off') prefs.notifications = v.notifications;
      if (typeof v.speechRate === 'number' && v.speechRate >= 0.5 && v.speechRate <= 2) prefs.speechRate = v.speechRate;
      if (typeof v.voiceId === 'string' && v.voiceId) prefs.voiceId = v.voiceId;
      if (isTtsVoicePref(v.ttsVoice)) prefs.ttsVoice = v.ttsVoice;
      if (v.autoRead === true) prefs.autoRead = true;
      const newThread = parseNewThreadDefault(v.newThread);
      if (newThread) prefs.newThread = newThread;
      if (isDictationMic(v.dictationMic)) prefs.dictationMic = v.dictationMic;
      const overseer = parseOverseerDefaults(v.overseer);
      if (overseer) prefs.overseer = overseer;
      return prefs;
    } catch {
      return {};
    }
  }

  savePrefs(prefs: Prefs): Promise<void> {
    return this.serial(() => this.kv.set(PREFS_KEY, JSON.stringify(prefs)));
  }
}

/** In-memory SecureKV for tests and previews. */
export class MemoryKV implements SecureKV {
  readonly data = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
}
