/**
 * The dictionary as stored on the phone (Documents/dictionary.json): your words, and the cached
 * vocabulary of every computer (so dictation keeps knowing them while a computer is offline).
 * Parsing is defensive; anything malformed is dropped, never thrown. Pure functions only.
 */

import type { CommandSource } from '../protocol';
import type { HubVocabulary, UserWord } from './vocabulary';

export type DictionaryFile = {
  version: 1;
  words: UserWord[];
  hubs: Record<string, HubVocabulary>;
};

export const DICTIONARY_FILE = 'dictionary.json';
export const WORD_MAX_LENGTH = 60;
export const HEARD_AS_MAX = 12;
export const WORDS_MAX = 500;

export const EMPTY_DICTIONARY_FILE: DictionaryFile = { version: 1, words: [], hubs: {} };

const SOURCES = new Set<CommandSource>(['builtin', 'extension', 'prompt', 'skill']);

const isText = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** A word or phrase as typed: inner whitespace collapsed, trimmed. */
export function cleanPhrase(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, WORD_MAX_LENGTH);
}

/** "chaff, fi ,fee" → ["chaff", "fi", "fee"] (commas or new lines; blanks and repeats dropped). */
export function parseHeardAs(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of input.split(/[,\n]/)) {
    const p = cleanPhrase(part);
    const k = p.toLowerCase();
    if (!p || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out.slice(0, HEARD_AS_MAX);
}

function parseWord(raw: unknown): UserWord | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (!isText(v.text, WORD_MAX_LENGTH)) return null;
  const heardAs = Array.isArray(v.heardAs) ? v.heardAs.filter((h): h is string => isText(h, WORD_MAX_LENGTH)) : [];
  return { text: cleanPhrase(v.text), heardAs: parseHeardAs(heardAs.join(',')) };
}

function parseHub(raw: unknown): HubVocabulary | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => isText(s)) : []);
  const commands = Array.isArray(v.commands)
    ? v.commands.flatMap((c) => {
        const o = c as Record<string, unknown> | null;
        return o && isText(o.name) && SOURCES.has(o.source as CommandSource) ? [{ name: o.name, source: o.source as CommandSource }] : [];
      })
    : [];
  return {
    name: typeof v.name === 'string' ? v.name : '',
    commands,
    models: list(v.models),
    folders: list(v.folders),
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
  };
}

export function parseDictionaryFile(raw: string | null): DictionaryFile {
  if (!raw) return { ...EMPTY_DICTIONARY_FILE, hubs: {} };
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const words = Array.isArray(v.words) ? v.words.map(parseWord).filter((w): w is UserWord => w !== null) : [];
    const hubs: Record<string, HubVocabulary> = {};
    if (v.hubs && typeof v.hubs === 'object' && !Array.isArray(v.hubs)) {
      for (const [id, h] of Object.entries(v.hubs as Record<string, unknown>)) {
        const hub = parseHub(h);
        if (hub) hubs[id] = hub;
      }
    }
    return { version: 1, words: dedupeWords(words).slice(0, WORDS_MAX), hubs };
  } catch {
    return { ...EMPTY_DICTIONARY_FILE, hubs: {} };
  }
}

export function serializeDictionaryFile(file: DictionaryFile): string {
  return JSON.stringify({ version: 1, words: file.words, hubs: file.hubs });
}

function dedupeWords(words: UserWord[]): UserWord[] {
  const out: UserWord[] = [];
  for (const w of words) {
    const i = out.findIndex((x) => x.text.toLowerCase() === w.text.toLowerCase());
    if (i < 0) out.push(w);
    else out[i] = { text: out[i].text, heardAs: parseHeardAs([...out[i].heardAs, ...w.heardAs].join(',')) };
  }
  return out;
}

/**
 * Add a word, or replace one (`previous`: the word being edited). The list stays sorted
 * alphabetically; a "heard as" equal to the word itself is dropped.
 */
export function upsertWord(words: UserWord[], word: UserWord, previous?: string): UserWord[] {
  const text = cleanPhrase(word.text);
  if (!text) return words;
  const heardAs = parseHeardAs(word.heardAs.join(',')).filter((h) => h.toLowerCase() !== text.toLowerCase());
  const drop = new Set([text.toLowerCase(), (previous ?? '').toLowerCase()]);
  const rest = words.filter((w) => !drop.has(w.text.toLowerCase()));
  return [...rest, { text, heardAs }].sort((a, b) => a.text.localeCompare(b.text, undefined, { sensitivity: 'base' })).slice(0, WORDS_MAX);
}

export function removeWord(words: UserWord[], text: string): UserWord[] {
  return words.filter((w) => w.text.toLowerCase() !== text.toLowerCase());
}
