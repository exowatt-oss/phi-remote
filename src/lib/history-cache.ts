/**
 * The phone's copy of session history: the merged index (one small JSON file) and the newest page
 * of the transcripts opened most recently (one file each, at most MAX_CACHED_TRANSCRIPTS), so the
 * list and those transcripts show at once on launch and stay readable while a computer is offline.
 * Storage is behind a tiny file interface (the app uses expo-file-system; tests use memory).
 */

import {
  cacheableTranscript,
  MAX_CACHED_TRANSCRIPTS,
  parseIndex,
  parseManifest,
  serializeIndex,
  touchManifest,
  transcriptFileName,
  type CachedTranscript,
  type HubHistory,
  type ManifestEntry,
} from './history';
import { parseTranscriptItem, type TranscriptItem } from './protocol';

export interface FileStore {
  read(name: string): Promise<string | null>;
  write(name: string, data: string): Promise<void>;
  remove(name: string): Promise<void>;
}

const INDEX_FILE = 'history-index.json';
const MANIFEST_FILE = 'history-transcripts.json';

const keyOf = (hubId: string, sessionId: string) => `${hubId}\n${sessionId}`;

export class HistoryCache {
  private readonly files: FileStore;
  private readonly maxTranscripts: number;
  private manifest: ManifestEntry[] = [];
  private loaded = false;
  /** Serializes writes so the manifest and its files never interleave. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(files: FileStore, opts: { maxTranscripts?: number } = {}) {
    this.files = files;
    this.maxTranscripts = opts.maxTranscripts ?? MAX_CACHED_TRANSCRIPTS;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** The stored index (empty when there is none or it is unreadable). */
  async load(): Promise<Record<string, HubHistory>> {
    const [index, manifest] = await Promise.all([
      this.files.read(INDEX_FILE).catch(() => null),
      this.files.read(MANIFEST_FILE).catch(() => null),
    ]);
    this.manifest = parseManifest(manifest);
    this.loaded = true;
    return parseIndex(index);
  }

  /** transcriptKeys with a cached transcript. */
  cachedKeys(): Set<string> {
    return new Set(this.manifest.map((m) => m.key));
  }

  saveIndex(history: Record<string, HubHistory>, now: number): Promise<void> {
    return this.serial(() => this.files.write(INDEX_FILE, JSON.stringify(serializeIndex(history, this.cachedKeys(), now))));
  }

  async loadTranscript(hubId: string, sessionId: string): Promise<{ items: TranscriptItem[]; hasMore: boolean } | null> {
    const key = keyOf(hubId, sessionId);
    const entry = this.manifest.find((m) => m.key === key);
    if (!entry) return null;
    const raw = await this.files.read(entry.file).catch(() => null);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as Partial<CachedTranscript>;
      if (v.v !== 1 || v.hubId !== hubId || v.sessionId !== sessionId || !Array.isArray(v.items)) return null;
      const items: TranscriptItem[] = [];
      for (const x of v.items) {
        const item = parseTranscriptItem(x);
        if (item) items.push(item);
      }
      return { items, hasMore: v.hasMore === true };
    } catch {
      return null;
    }
  }

  /** Keeps the newest page of a transcript; the least recently saved beyond the bound are deleted. */
  saveTranscript(hubId: string, sessionId: string, items: TranscriptItem[], hasMore: boolean, now: number): Promise<void> {
    if (items.length === 0) return Promise.resolve();
    return this.serial(async () => {
      if (!this.loaded) await this.load();
      const key = keyOf(hubId, sessionId);
      const file = transcriptFileName(key);
      const page = cacheableTranscript(items, hasMore);
      const body: CachedTranscript = { v: 1, hubId, sessionId, savedAt: now, items: page.items, hasMore: page.hasMore };
      await this.files.write(file, JSON.stringify(body));
      const { manifest, evicted } = touchManifest(this.manifest, { key, file, savedAt: now }, this.maxTranscripts);
      this.manifest = manifest;
      await this.files.write(MANIFEST_FILE, JSON.stringify(manifest));
      for (const e of evicted) if (e.file !== file) await this.files.remove(e.file).catch(() => undefined);
    });
  }

  /** Forgets everything cached for a computer (it was removed). */
  removeHub(hubId: string): Promise<void> {
    return this.serial(async () => {
      const prefix = keyOf(hubId, '');
      const gone = this.manifest.filter((m) => m.key.startsWith(prefix));
      if (gone.length === 0) return;
      this.manifest = this.manifest.filter((m) => !m.key.startsWith(prefix));
      await this.files.write(MANIFEST_FILE, JSON.stringify(this.manifest));
      for (const e of gone) await this.files.remove(e.file).catch(() => undefined);
    });
  }
}

/** In-memory FileStore for tests and previews. */
export class MemoryFiles implements FileStore {
  readonly data = new Map<string, string>();
  async read(name: string): Promise<string | null> {
    return this.data.get(name) ?? null;
  }
  async write(name: string, data: string): Promise<void> {
    this.data.set(name, data);
  }
  async remove(name: string): Promise<void> {
    this.data.delete(name);
  }
}
