/**
 * The dictation dictionary: the words dictation should get right, assembled from
 *
 *   - your own words (Settings › Voice › Dictionary), each with "heard as" spellings;
 *   - a built-in seed of generic phi and developer terms (SEED below);
 *   - every paired computer: its slash commands (skills, prompt templates, built-ins), its
 *     models, its name and the folders its sessions run in — cached on the phone (see
 *     `HubVocabulary`), so dictation keeps them while a computer is offline.
 *
 * `compileDictionary` turns that into the lookup tables the corrector (`correct.ts`) uses and
 * the contextual strings SpeechAnalyzer is given. Pure functions only.
 */

import { basename, type CommandInfo, type CommandSource, type ModelInfo } from '../protocol';
import { keyDeletions, normalizeWord, soundKey, soundSpelling } from './phonetic';
import { isCommonWord } from './words';

/** A word you added, and how dictation mishears it. */
export type UserWord = { text: string; heardAs: string[] };

/** What one computer contributes (cached in Documents/dictionary.json). */
export type HubVocabulary = {
  name: string;
  /** commands.list names as the hub sends them (`skill:example-skill`, `jev`, `new`). */
  commands: { name: string; source: CommandSource }[];
  /** Model names as models.list shows them, without the provider note ("GPT-5.6 Luna"). */
  models: string[];
  /** Folder names (last path segment) of its sessions and recent folders. */
  folders: string[];
  updatedAt: number;
};

export type SeedWord = { text: string; heardAs?: string[] };

/**
 * Generic developer names dictation gets wrong. Organization-specific terminology
 * belongs in the user's editable dictionary or vocabulary learned from paired hosts.
 */
export const SEED: SeedWord[] = [
  { text: 'phi', heardAs: ['chaff', 'phy'] },
  { text: 'phi remote', heardAs: ['fire remote', 'five remote', 'fi remote', 'phy remote'] },
  { text: 'phi mobile app', heardAs: ['five mobile app', 'fire mobile app'] },
  { text: 'Jev' },
  { text: 'devbox', heardAs: ['dev box', 'dove box', 'dapbox', 'd box'] },
  { text: 'Phonon' },
  { text: 'Opus' },
  { text: 'Sonnet' },
  { text: 'Haiku' },
  { text: 'Kimi' },
  { text: 'Claude' },
  { text: 'DeepSeek', heardAs: ['deep seek'] },
  { text: 'LiteLLM', heardAs: ['lite llm', 'light llm'] },
  { text: 'Tailscale', heardAs: ['tail scale', 'tail skill'] },
  { text: 'TestFlight' },
  { text: 'Postgres' },
  { text: 'Xcode' },
  { text: 'GitHub' },
];

export type TermSource = 'user' | 'seed' | 'model' | 'command' | 'host' | 'folder';

/** A single word the corrector can land on. */
export type DictionaryTerm = {
  text: string;
  norm: string;
  key: string;
  spelling: string;
  source: TermSource;
};

/** "heard as" → word, matched word for word (case and punctuation ignored). */
export type AliasRule = { tokens: string[]; text: string; user: boolean };

/** One slash command the corrector can write after "slash …". */
export type CommandTarget = { norm: string; key: string; spelling: string; output: string; words: number };

export type Dictionary = {
  aliases: Map<string, AliasRule[]>;
  terms: Map<string, DictionaryTerm>;
  byKey: Map<string, DictionaryTerm[]>;
  /** Terms by their key with one sound removed (one-sound-off near misses: "Orbang" → Orblang). */
  byKeyDeletion: Map<string, DictionaryTerm[]>;
  commands: CommandTarget[];
  /** For SpeechAnalyzer (AnalysisContext.contextualStrings): your words first, at most 100. */
  contextualStrings: string[];
  /** How many words came from where (Settings). */
  counts: Record<TermSource, number>;
};

export const CONTEXTUAL_STRINGS_MAX = 100;

const PRECEDENCE: Record<TermSource, number> = { user: 0, seed: 1, model: 2, command: 3, host: 4, folder: 5 };

/** Words of an alias or phrase, normalized ("demo-project" → ["demoproject"], "fire remote" → ["fire", "remote"]). */
export function phraseTokens(phrase: string): string[] {
  return phrase
    .split(/\s+/)
    .map(normalizeWord)
    .filter((t) => t.length > 0);
}

/** "Model A (provider details)" → "Model A". */
export function modelDisplayName(model: Pick<ModelInfo, 'id' | 'name'>): string {
  const name = (model.name || model.id).replace(/\s*\([^)]*\)\s*$/, '').trim();
  return name || model.id;
}

/** The parts of an identifier or name worth knowing as words: "jev-mobile" → ["jev", "mobile"]. */
function nameParts(name: string): string[] {
  return name
    .split(/[\s\-_:./]+/)
    .filter((p) => /[A-Za-z]/.test(p) && normalizeWord(p).length >= 3);
}

/** A home folder (/Users/x, /home/x) says nothing about the work; its name is the user's. */
export function isHomeFolder(cwd: string): boolean {
  const p = cwd.replace(/\/+$/, '');
  return p === '' || p === '~' || /^\/(Users|home)\/[^/]+$/.test(p) || p === '/root';
}

/** Folder names worth knowing from a list of paths (home folders and duplicates dropped). */
export function folderNames(cwds: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const cwd of cwds) {
    if (!cwd || isHomeFolder(cwd)) continue;
    const name = basename(cwd.replace(/\/+$/, ''));
    if (name && name !== '~' && normalizeWord(name).length >= 3) out.add(name);
  }
  return [...out].sort();
}

const SKILL_PREFIX = 'skill:';

function commandTargets(commands: { name: string; source: CommandSource }[]): CommandTarget[] {
  // A bare /<label> reaches a skill only when no other command has that name (docs/PROTOCOL.md).
  const names = new Set(commands.map((c) => c.name));
  const out = new Map<string, CommandTarget>();
  const add = (spoken: string, output: string) => {
    const norm = normalizeWord(spoken);
    if (norm.length < 2 || out.has(norm)) return;
    out.set(norm, { norm, key: soundKey(norm), spelling: soundSpelling(norm), output, words: phraseTokens(spoken.replace(/[-_:]/g, ' ')).length });
  };
  // Names first: "/checkin" is the prompt template when one has that name, not the skill.
  for (const c of commands) add(c.name, c.name);
  for (const c of commands) {
    if (c.source === 'skill' && c.name.startsWith(SKILL_PREFIX)) {
      const label = c.name.slice(SKILL_PREFIX.length);
      add(label, names.has(label) ? c.name : label);
    }
  }
  return [...out.values()];
}

/** Dedupe commands from every computer by name (the first wins). */
function mergeCommands(hubs: HubVocabulary[]): { name: string; source: CommandSource }[] {
  const seen = new Map<string, { name: string; source: CommandSource }>();
  for (const h of hubs) for (const c of h.commands) if (!seen.has(c.name)) seen.set(c.name, c);
  return [...seen.values()];
}

export function compileDictionary(input: { words: UserWord[]; hubs: HubVocabulary[]; seed?: SeedWord[] }): Dictionary {
  const seed = input.seed ?? SEED;
  const terms = new Map<string, DictionaryTerm>();
  const aliases = new Map<string, AliasRule[]>();
  const counts: Record<TermSource, number> = { user: 0, seed: 0, model: 0, command: 0, host: 0, folder: 0 };

  const addTerm = (text: string, source: TermSource) => {
    const t = text.trim();
    const norm = normalizeWord(t);
    if (!norm || /\s/.test(t)) return; // multi-word texts are reached through their aliases only
    const prev = terms.get(norm);
    if (prev && PRECEDENCE[prev.source] <= PRECEDENCE[source]) return;
    terms.set(norm, { text: t, norm, key: soundKey(norm), spelling: soundSpelling(norm), source });
  };
  const addAlias = (heard: string, text: string, user: boolean) => {
    const tokens = phraseTokens(heard);
    if (!tokens.length || phraseTokens(text).join(' ') === tokens.join(' ')) return;
    const list = aliases.get(tokens[0]) ?? [];
    // Your own spelling of a phrase wins over the built-in one.
    if (list.some((r) => r.tokens.join(' ') === tokens.join(' ') && (r.user || !user))) return;
    const kept = list.filter((r) => r.tokens.join(' ') !== tokens.join(' '));
    kept.push({ tokens, text: text.trim(), user });
    kept.sort((a, b) => b.tokens.length - a.tokens.length || Number(b.user) - Number(a.user));
    aliases.set(tokens[0], kept);
  };

  const strings: string[] = [];
  const stringSeen = new Set<string>();
  const addString = (s: string) => {
    const t = s.trim();
    const k = t.toLowerCase();
    if (!t || t.length > 60 || stringSeen.has(k)) return;
    stringSeen.add(k);
    strings.push(t);
  };

  for (const w of input.words) {
    addTerm(w.text, 'user');
    for (const h of w.heardAs) addAlias(h, w.text, true);
    addString(w.text);
    counts.user += 1;
  }
  for (const s of seed) {
    addTerm(s.text, 'seed');
    for (const h of s.heardAs ?? []) addAlias(h, s.text, false);
    addString(s.text);
    counts.seed += 1;
  }

  const hubs = input.hubs;
  const modelNames = new Set<string>();
  for (const h of hubs) for (const m of h.models) modelNames.add(m);
  for (const name of modelNames) {
    for (const p of nameParts(name)) if (!isCommonWord(p)) addTerm(p, 'model');
  }
  const commands = mergeCommands(hubs);
  for (const c of commands) {
    const label = c.name.startsWith(SKILL_PREFIX) ? c.name.slice(SKILL_PREFIX.length) : c.name;
    for (const p of nameParts(label)) if (!isCommonWord(p)) addTerm(p, 'command');
  }
  const hostNames = new Set(hubs.map((h) => h.name).filter(Boolean));
  for (const name of hostNames) for (const p of nameParts(name)) if (!isCommonWord(p)) addTerm(p, 'host');
  const folders = new Set<string>();
  for (const h of hubs) for (const f of h.folders) folders.add(f);
  for (const f of folders) for (const p of nameParts(f)) if (!isCommonWord(p)) addTerm(p, 'folder');

  counts.model = modelNames.size;
  counts.command = commands.length;
  counts.host = hostNames.size;
  counts.folder = folders.size;

  for (const m of modelNames) addString(m);
  for (const c of commands) addString(c.name.startsWith(SKILL_PREFIX) ? c.name.slice(SKILL_PREFIX.length) : c.name);
  for (const n of hostNames) addString(n);
  for (const f of folders) addString(f);

  const byKey = new Map<string, DictionaryTerm[]>();
  const byKeyDeletion = new Map<string, DictionaryTerm[]>();
  for (const t of terms.values()) {
    if (!t.key) continue;
    byKey.set(t.key, [...(byKey.get(t.key) ?? []), t]);
    if (t.key.length >= 5) {
      for (const d of new Set(keyDeletions(t.key))) byKeyDeletion.set(d, [...(byKeyDeletion.get(d) ?? []), t]);
    }
  }

  return {
    aliases,
    terms,
    byKey,
    byKeyDeletion,
    commands: commandTargets(commands),
    contextualStrings: strings.slice(0, CONTEXTUAL_STRINGS_MAX),
    counts,
  };
}

// ---------------------------------------------------------------------------------------------
// What a computer contributes, from the app's state and its replies
// ---------------------------------------------------------------------------------------------

export const EMPTY_HUB_VOCABULARY: HubVocabulary = { name: '', commands: [], models: [], folders: [], updatedAt: 0 };

export const HUB_FOLDERS_MAX = 200;

/**
 * Merge fresh information about one computer into its cached vocabulary. A field that was not
 * fetched this time (undefined) keeps its cached value; folders accumulate (at most 200, the
 * fresh ones kept first; stored sorted) so a folder used last month still counts.
 */
export function mergeHubVocabulary(
  prev: HubVocabulary | undefined,
  fresh: { name?: string; commands?: CommandInfo[]; models?: Pick<ModelInfo, 'id' | 'name'>[]; folders?: string[] },
  now: number,
): HubVocabulary {
  const base = prev ?? EMPTY_HUB_VOCABULARY;
  const folders = fresh.folders
    ? [...new Set([...folderNames(fresh.folders), ...base.folders])].slice(0, HUB_FOLDERS_MAX).sort()
    : base.folders;
  return {
    name: fresh.name ?? base.name,
    commands: fresh.commands ? fresh.commands.map((c) => ({ name: c.name, source: c.source })) : base.commands,
    models: fresh.models ? [...new Set(fresh.models.map(modelDisplayName))] : base.models,
    folders,
    updatedAt: now,
  };
}

/** Same words (order kept) — to skip a pointless write. */
export function sameHubVocabulary(a: HubVocabulary | undefined, b: HubVocabulary): boolean {
  if (!a) return false;
  return (
    a.name === b.name &&
    JSON.stringify(a.commands) === JSON.stringify(b.commands) &&
    JSON.stringify(a.models) === JSON.stringify(b.models) &&
    JSON.stringify(a.folders) === JSON.stringify(b.folders)
  );
}
