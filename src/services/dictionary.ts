/**
 * The dictation dictionary on this iPhone (Settings › Voice › Dictionary): your words, the
 * built-in phi / ExampleCo names, and what every paired computer contributes — its slash commands,
 * models, name and folders — cached in Documents/dictionary.json so dictation keeps knowing them
 * offline.
 *
 * Both dictation engines use it: SpeechAnalyzer is given the words as contextual strings
 * (voice-transcription.ios.ts), and every transcript — SpeechAnalyzer's and live dictation's,
 * final text and the live words on screen — is corrected against it (`src/lib/dictionary`).
 * The computers' part refreshes whenever one connects (at most every 10 minutes) and as the app
 * learns new folders or command lists.
 */

import { File, Paths } from 'expo-file-system';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import {
  compileDictionary,
  correctDictation,
  DICTIONARY_FILE,
  EMPTY_DICTIONARY_FILE,
  harvestHubs,
  mergeHubVocabulary,
  parseDictionaryFile,
  removeWord,
  sameHubVocabulary,
  serializeDictionaryFile,
  upsertWord,
  type Dictionary,
  type DictionaryFile,
  type HubVocabulary,
  type UserWord,
} from '@/lib/dictionary';
import { isEnglishLocale } from '@/lib/live-dictation/engine';
import { commandsDonor, type RemoteState } from '@/lib/store';
import type { VoiceTranscriber } from '@/lib/voice-input';

import { remote } from './remote';

/** The groups Settings › Voice › Dictionary lists ("Already known"). */
export type DictionaryListKind = 'seed' | 'command' | 'model' | 'host' | 'folder';

export type DictionaryState = {
  loaded: boolean;
  file: DictionaryFile;
  dict: Dictionary;
};

const compile = (file: DictionaryFile): Dictionary => compileDictionary({ words: file.words, hubs: Object.values(file.hubs) });

export const dictionaryStore = createStore<DictionaryState>()(() => ({
  loaded: false,
  file: EMPTY_DICTIONARY_FILE,
  dict: compile(EMPTY_DICTIONARY_FILE),
}));

export function useDictionary<T>(selector: (s: DictionaryState) => T): T {
  return useStore(dictionaryStore, selector);
}

// ---------------------------------------------------------------------------------------------
// Using it
// ---------------------------------------------------------------------------------------------

/** The transcript with your words fixed (see src/lib/dictionary/correct.ts). Never throws. */
export function correctTranscript(text: string, locale: string): string {
  try {
    return correctDictation(text, dictionaryStore.getState().dict, { english: isEnglishLocale(locale) });
  } catch {
    return text;
  }
}

/** The words SpeechAnalyzer should expect (your words first, at most 100). */
export function dictationContextualStrings(): string[] {
  return dictionaryStore.getState().dict.contextualStrings;
}

/** A transcriber whose text is corrected against the dictionary (null stays null). */
export function withDictionary(transcriber: VoiceTranscriber | null): VoiceTranscriber | null {
  if (!transcriber) return null;
  return {
    prepare: async (options) => {
      const prepared = await transcriber.prepare(options);
      return {
        locale: prepared.locale,
        transcribe: async (uri, opts) => correctTranscript(await prepared.transcribe(uri, opts), prepared.locale),
      };
    },
  };
}

/** For the live words on screen: the same correction, remembering the last few inputs (updates repeat them). */
export function livePreviewCorrector(locale = 'en-US'): (text: string) => string {
  const memo = new Map<string, string>();
  return (text) => {
    if (!text) return text;
    const hit = memo.get(text);
    if (hit !== undefined) return hit;
    const out = correctTranscript(text, locale);
    if (memo.size > 8) memo.clear();
    memo.set(text, out);
    return out;
  };
}

// ---------------------------------------------------------------------------------------------
// Your words
// ---------------------------------------------------------------------------------------------

function setFile(file: DictionaryFile): void {
  dictionaryStore.setState({ file, dict: compile(file) });
  scheduleSave();
}

/** Add a word, or replace `previous` with it. */
export function saveWord(word: UserWord, previous?: string): void {
  const { file } = dictionaryStore.getState();
  setFile({ ...file, words: upsertWord(file.words, word, previous) });
}

export function deleteWord(text: string): void {
  const { file } = dictionaryStore.getState();
  setFile({ ...file, words: removeWord(file.words, text) });
}

// ---------------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
  if (!dictionaryStore.getState().loaded) return; // the first load would be overwritten otherwise
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const f = new File(Paths.document, DICTIONARY_FILE);
      if (!f.exists) f.create({ intermediates: true });
      f.write(serializeDictionaryFile(dictionaryStore.getState().file));
    } catch {}
  }, 500);
}

async function load(): Promise<void> {
  let raw: string | null = null;
  try {
    const f = new File(Paths.document, DICTIONARY_FILE);
    raw = f.exists ? await f.text() : null;
  } catch {}
  const stored = parseDictionaryFile(raw);
  // Words saved before the file was read (unlikely) are kept on top of what was stored.
  const current = dictionaryStore.getState().file;
  let words = stored.words;
  for (const w of current.words) words = upsertWord(words, w);
  const file: DictionaryFile = { version: 1, words, hubs: { ...stored.hubs, ...current.hubs } };
  dictionaryStore.setState({ loaded: true, file, dict: compile(file) });
  if (current.words.length || Object.keys(current.hubs).length) scheduleSave();
}

// ---------------------------------------------------------------------------------------------
// What the computers contribute
// ---------------------------------------------------------------------------------------------

const REFRESH_MS = 10 * 60_000;
const lastRefresh = new Map<string, number>();
let harvestTimer: ReturnType<typeof setTimeout> | null = null;

function updateHub(hubId: string, fresh: Parameters<typeof mergeHubVocabulary>[1]): void {
  const { file } = dictionaryStore.getState();
  const prev = file.hubs[hubId];
  const next = mergeHubVocabulary(prev, fresh, Date.now());
  if (sameHubVocabulary(prev, next)) return;
  setFile({ ...file, hubs: { ...file.hubs, [hubId]: next } });
}

/**
 * Names, folders and fetched command lists the app already holds; unpaired computers are dropped.
 * A connected computer whose commands were never fetched gets them asked for (through its most
 * recent thread: its sessions arrive after it connects).
 */
function harvest(state: RemoteState): void {
  const found = harvestHubs(state);
  for (const [hubId, h] of Object.entries(found)) {
    updateHub(hubId, h);
    if (!h.commands && state.hosts[hubId]?.conn.status === 'live') {
      const donor = commandsDonor(state, hubId);
      if (donor) remote.ensureCommands(hubId, donor);
    }
  }
  if (!state.ready) return;
  const { file } = dictionaryStore.getState();
  const gone = Object.keys(file.hubs).filter((id) => !state.hosts[id]);
  if (gone.length) {
    const hubs: Record<string, HubVocabulary> = { ...file.hubs };
    for (const id of gone) delete hubs[id];
    setFile({ ...file, hubs });
  }
}

function scheduleHarvest(): void {
  if (harvestTimer) return;
  harvestTimer = setTimeout(() => {
    harvestTimer = null;
    harvest(remote.store.getState());
  }, 1500);
}

/** Ask a live computer for its models, recent folders and (through any session) its commands. */
export async function refreshHubVocabulary(hubId: string, force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - (lastRefresh.get(hubId) ?? 0) < REFRESH_MS) return;
  lastRefresh.set(hubId, now);
  const state = remote.store.getState();
  const donor = commandsDonor(state, hubId);
  if (donor) remote.ensureCommands(hubId, donor);
  const [models, cwds] = await Promise.allSettled([remote.listModels(hubId), remote.recentCwds(hubId)]);
  updateHub(hubId, {
    ...(models.status === 'fulfilled' ? { models: models.value.models } : {}),
    ...(cwds.status === 'fulfilled' ? { folders: cwds.value } : {}),
  });
}

/** Refresh every computer that is connected now (Settings › Voice › Dictionary). */
export function refreshAllHubVocabulary(): void {
  const state = remote.store.getState();
  for (const hubId of state.hostOrder) {
    if (state.hosts[hubId]?.conn.status === 'live') void refreshHubVocabulary(hubId, true).catch(() => undefined);
  }
}

let started = false;

/** App start (bootstrap): read the file, then follow the computers. */
export function initDictionary(): void {
  if (started) return;
  started = true;
  void load().then(() => scheduleHarvest());
  remote.store.subscribe((s, prev) => {
    if (s.hosts !== prev.hosts) {
      for (const hubId of s.hostOrder) {
        const live = s.hosts[hubId]?.conn.status === 'live';
        const was = prev.hosts[hubId]?.conn.status === 'live';
        if (live && !was) void refreshHubVocabulary(hubId).catch(() => undefined);
      }
    }
    if (s.sessions !== prev.sessions || s.history !== prev.history || s.commands !== prev.commands || s.hostOrder !== prev.hostOrder || s.ready !== prev.ready) {
      scheduleHarvest();
    }
  });
}
