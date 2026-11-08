/**
 * Dictionary-based correction of what dictation heard. Runs on the text each engine returns
 * (and on live dictation's words as they appear). Three passes, all conservative:
 *
 *   1. Slash commands: "slash X", "forward slash X" (also heard as "for slash", "for sash") and
 *      "/X" become `/<command>` when X sounds like one of your computers' commands:
 *      "forward slash Jeff mobile" → "/jev-mobile", "slash use fast" → "/example-skill".
 *      Anything else after "slash" stays as heard.
 *   2. "heard as" spellings, yours and the built-in ones: "exampleco" → ExampleCo.
 *   3. Near misses by sound: one to three words that sound like one of your words, a built-in
 *      name or a model name ("exampleco", "exampleco", "X O tree") become it. A common English word is
 *      never changed this way, and a run of words is joined only from one that is not.
 *      (Folder, computer and command names reach dictation through SpeechAnalyzer's context and
 *      "slash" commands; they never rewrite prose.)
 *
 * Case and punctuation around a corrected word are kept; text is never added or removed
 * otherwise. Pure functions only.
 */

import { editDistance, keyDeletions, normalizeWord, soundKey, soundSimilarity, soundSpelling } from './phonetic';
import type { Dictionary, DictionaryTerm } from './vocabulary';
import { isCommonWord } from './words';

export type CorrectionKind = 'command' | 'alias' | 'word';
export type Correction = { from: string; to: string; kind: CorrectionKind };

/** One whitespace-separated piece of the text: punctuation before, the word, punctuation after. */
type Chunk = { lead: string; core: string; trail: string; space: string; command?: true };

const SIMPLE = /^[A-Za-z0-9]+(['’]s)?$/;
const NUMBERS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};
const SLASH_LEAD = new Set(['forward', 'for', 'four']);
const DASHES = /^[-–—]+$/;
/** Words after "slash" looked at for a command name. */
const COMMAND_WORDS_MAX = 5;

function split(text: string): { head: string; chunks: Chunk[] } {
  const parts = text.split(/(\s+)/);
  let head = '';
  let i = 0;
  if (parts[0] === '') {
    head = parts[1] ?? '';
    i = 2;
  }
  const chunks: Chunk[] = [];
  for (; i < parts.length; i += 2) {
    const raw = parts[i];
    const space = parts[i + 1] ?? '';
    if (!raw) {
      if (chunks.length) chunks[chunks.length - 1].space += space;
      else head += space;
      continue;
    }
    const lead = /^[^A-Za-z0-9]*/.exec(raw)![0];
    const rest = raw.slice(lead.length);
    const trail = /[^A-Za-z0-9'’]*$/.exec(rest)![0];
    const core = rest.slice(0, rest.length - trail.length);
    // "everything/use": a slash glued to the word before it may start a command ("/use – subs").
    const glued = /^([A-Za-z]+)\/([A-Za-z][A-Za-z0-9]*)$/.exec(core);
    if (glued) {
      chunks.push({ lead, core: glued[1], trail: '', space: '' }, { lead: '/', core: glued[2], trail, space });
      continue;
    }
    chunks.push({ lead, core, trail, space });
  }
  return { head, chunks };
}

function join(head: string, chunks: Chunk[]): string {
  return head + chunks.map((c) => c.lead + c.core + c.trail + c.space).join('');
}

const bare = (core: string) => core.replace(/['’]s$/, '');
const possessive = (core: string) => (/['’]s$/.test(core) ? core.slice(-2) : '');

/** Nothing between chunk i and chunk i+1 but a space (no comma, no quote, no line break). */
function joined(chunks: Chunk[], i: number): boolean {
  const a = chunks[i];
  const b = chunks[i + 1];
  return !!b && a.trail === '' && b.lead === '' && !/\n/.test(a.space) && !/['’]s$/.test(a.core);
}

/** A word worth correcting: letters/digits only (no "phi-remote", "5.5", "/new"). */
function isWord(c: Chunk): boolean {
  return !c.command && SIMPLE.test(c.core);
}

/** all lowercase, ALL CAPS or Capitalized (not "sample-project" or "iMessage"). */
function plainCase(word: string): boolean {
  return word === word.toLowerCase() || word === word.toUpperCase() || word.slice(1) === word.slice(1).toLowerCase();
}

function isSingleLetter(core: string): boolean {
  return /^[A-Za-z]$/.test(core);
}

/** Common English (never corrected by sound). Single letters other than "a" and "I" are not. */
function isCommon(core: string): boolean {
  const b = bare(core);
  if (/^[0-9]+$/.test(b)) return true;
  if (isSingleLetter(b)) return /^[aAiI]$/.test(b);
  return isCommonWord(b);
}

// ---------------------------------------------------------------------------------------------
// 1. Slash commands
// ---------------------------------------------------------------------------------------------

type Marker = { start: number; first: number; firstCore: string | null };

/** "slash" / "forward slash" / "for sash" / "/" / "/word" at chunk i. */
function slashMarker(chunks: Chunk[], i: number): Marker | null {
  const c = chunks[i];
  const n = normalizeWord(c.core);
  const before = i > 0 && joined(chunks, i - 1) && SLASH_LEAD.has(normalizeWord(chunks[i - 1].core)) ? i - 1 : i;
  if (c.lead === '' && isWord(c) && n === 'slash') return { start: before, first: i + 1, firstCore: null };
  if (c.lead === '' && isWord(c) && n === 'sash' && before === i - 1 && normalizeWord(chunks[i - 1].core) !== 'four') {
    return { start: before, first: i + 1, firstCore: null };
  }
  if (c.lead.endsWith('/') && !c.lead.slice(0, -1).includes('/')) {
    // "/" alone, or "/word" (SpeechAnalyzer writes the slash itself: "/use – subs"); a "forward"
    // before it is part of it. ("for /x" stays: the engine heard "for" as a word then.)
    const start = c.lead === '/' && i > 0 && chunks[i - 1].trail === '' && normalizeWord(chunks[i - 1].core) === 'forward' ? i - 1 : i;
    if (c.core === '') return { start, first: i + 1, firstCore: null };
    if (isWord(c)) return { start, first: i, firstCore: c.core };
  }
  return null;
}

type CommandMatch = { output: string; last: number; score: number };

function matchCommand(dict: Dictionary, chunks: Chunk[], m: Marker): CommandMatch | null {
  // The words after the marker, skipping dashes; stop at punctuation.
  const words: { index: number; norm: string }[] = [];
  for (let j = m.first; j < chunks.length && words.length < COMMAND_WORDS_MAX; j += 1) {
    const c = chunks[j];
    if (j === m.first && m.firstCore !== null) {
      words.push({ index: j, norm: normalizeWord(c.core) });
    } else if (c.core === '' && DASHES.test(c.lead + c.trail)) {
      continue;
    } else if (isWord(c) && (c.lead === '' || j === m.first)) {
      if (j > m.first && words.length && chunks[words[words.length - 1].index].trail !== '' && !DASHES.test(chunks[words[words.length - 1].index].trail)) break;
      words.push({ index: j, norm: normalizeWord(bare(c.core)) });
    } else break;
    if (c.trail !== '' && !DASHES.test(c.trail)) break;
  }
  let best: CommandMatch | null = null;
  let spoken = '';
  for (let k = 0; k < words.length; k += 1) {
    const w = words[k].norm;
    spoken += k > 0 && NUMBERS[w] ? NUMBERS[w] : w;
    const key = soundKey(spoken);
    for (const t of dict.commands) {
      if (k + 1 > t.words + 1) continue;
      let score = 0;
      if (spoken === t.norm) score = 1;
      else if (key === t.key) score = soundSimilarity(spoken, t.norm);
      else if (t.key.length >= 5 && editDistance(key, t.key) === 1) score = soundSimilarity(spoken, t.norm) >= 0.8 ? soundSimilarity(spoken, t.norm) * 0.95 : 0;
      if (score < 0.6) continue;
      // Better match first; then the longer name ("jev mobile" is /jev-mobile, not /jev + "mobile").
      if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && words[k].index > best.last)) {
        best = { output: t.output, last: words[k].index, score };
      }
    }
  }
  return best;
}

function slashPass(dict: Dictionary, chunks: Chunk[], out: Correction[]): Chunk[] {
  if (!dict.commands.length) return chunks;
  const result: Chunk[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const m = slashMarker(chunks, i);
    const match = m ? matchCommand(dict, chunks, m) : null;
    if (!m || !match) {
      result.push(chunks[i]);
      continue;
    }
    // The marker may have started at the previous chunk ("forward slash"): take it back.
    if (m.start < i) result.pop();
    // A command starts after a space ("everything/use – subs" → "everything /use-subs").
    const before = result[result.length - 1];
    if (before && before.space === '') result[result.length - 1] = { ...before, space: ' ' };
    const first = chunks[m.start];
    const last = chunks[match.last];
    const lead = m.start === i && chunks[i].lead.endsWith('/') ? chunks[i].lead.slice(0, -1) : first.lead;
    const from = chunks
      .slice(m.start, match.last + 1)
      .map((c, k, all) => c.lead + c.core + c.trail + (k < all.length - 1 ? c.space : ''))
      .join('');
    const replacement: Chunk = { lead: `${lead}/`, core: match.output, trail: last.trail, space: last.space, command: true };
    if (from.trim() !== `${lead}/${match.output}${last.trail}`) out.push({ from: from.trim(), to: `/${match.output}`, kind: 'command' });
    result.push(replacement);
    i = match.last;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// 2 + 3. "heard as" spellings and near misses
// ---------------------------------------------------------------------------------------------

type SpanMatch = { length: number; text: string; kind: 'alias' | 'word'; score: number };

function matchAlias(dict: Dictionary, chunks: Chunk[], i: number): SpanMatch | null {
  if (chunks[i].command) return null;
  const first = normalizeWord(chunks[i].core);
  const firstBare = normalizeWord(bare(chunks[i].core));
  for (const rule of [...(dict.aliases.get(first) ?? []), ...(first !== firstBare ? (dict.aliases.get(firstBare) ?? []) : [])]) {
    const n = rule.tokens.length;
    let ok = true;
    for (let k = 0; k < n && ok; k += 1) {
      const c = chunks[i + k];
      if (!c || c.command || (k > 0 && !joined(chunks, i + k - 1))) ok = false;
      else {
        const norm = normalizeWord(c.core);
        // Only the last word may carry a possessive ("exampleco's").
        ok = norm === rule.tokens[k] || (k === n - 1 && normalizeWord(bare(c.core)) === rule.tokens[k]);
      }
    }
    if (ok) return { length: n, text: rule.text, kind: 'alias', score: 2 };
  }
  return null;
}

/** Joined words must begin like the word they become ("XO Tree" → SampleTool; not "gh ExampleCo", whose "gh" is silent). */
function startsAlike(first: string, norm: string): boolean {
  const a = soundSpelling(first);
  return a.length > 0 && a[0] === soundSpelling(norm)[0];
}

const isCurated = (t: DictionaryTerm) => t.source === 'user' || t.source === 'seed' || t.source === 'model';

/**
 * How close a single heard word must sound to a dictionary word. Dictation mishears a name as
 * a word that sounds almost the same ("exampleco", "exampleco", "Chev"), so the bar is high, and
 * higher for short words: three letters or fewer must sound identical ("fi" → phi).
 */
function closeEnough(heard: string, sim: number, sameKey: boolean): boolean {
  const n = heard.length;
  if (n <= 3) return sameKey && sim === 1;
  const bar = n === 4 ? 0.85 : 0.75;
  return sameKey ? sim >= bar : sim >= Math.max(bar, 0.8);
}

function matchWords(dict: Dictionary, chunks: Chunk[], i: number): SpanMatch | null {
  if (!isWord(chunks[i])) return null;
  // Spelled-out letters ("J E V", "X O tree") may run longer than three words.
  let maxLen = 3;
  let letters = 0;
  if (isSingleLetter(chunks[i].core)) {
    letters = 1;
    while (letters < 8 && joined(chunks, i + letters - 1) && isWord(chunks[i + letters]) && isSingleLetter(chunks[i + letters].core)) letters += 1;
    maxLen = Math.max(maxLen, Math.min(8, letters + 1));
  }
  // Only your "heard as" spellings change a common word, and words are joined only from one
  // that is not ("X O tree", "DSV four"; never "be exampleco").
  if (isCommon(chunks[i].core)) return null;
  let best: SpanMatch | null = null;
  let spoken = '';
  for (let k = 0; k < maxLen; k += 1) {
    const c = chunks[i + k];
    if (!c || !isWord(c) || (k > 0 && !joined(chunks, i + k - 1))) break;
    const w = normalizeWord(bare(c.core));
    spoken += k > 0 && NUMBERS[w] ? NUMBERS[w] : w;
    const span = k + 1;
    const multi = span > 1;
    const heard = bare(c.core);
    // An exact dictionary word (or its plural) ends the search: it is either right already or
    // only needs its spelling ("JEV" → Jev, "ExampleCo" → ExampleCo). Its case changes only towards
    // a word the dictionary knows properly that has capitals of its own, and only when what was
    // heard is plainly cased: "sample-project" was cased on purpose, "Devbox" starts a sentence, and a
    // folder or command name never lowercases what was heard.
    const singular = !multi && /s$/.test(spoken) ? (dict.terms.get(spoken.replace(/e?s$/, '')) ?? dict.terms.get(spoken.slice(0, -1))) : undefined;
    const plural = singular && !singular.norm.endsWith('s') ? singular : undefined; // "Postgress" is no plural
    const exact = dict.terms.get(spoken) ?? plural;
    if (exact && (!multi || exact.source === 'user' || exact.source === 'seed')) {
      const text = exact.text + (exact === plural ? spoken.slice(exact.norm.length) : '');
      if (!multi) {
        const respell = isCurated(exact) && exact.text !== exact.text.toLowerCase() && plainCase(heard) && text !== heard;
        return respell ? { length: 1, text, kind: 'word', score: 2 } : null;
      }
      if (!best || best.score < 2) best = { length: span, text, kind: 'word', score: 2 };
      continue;
    }
    // Spelled-out letters only ever match exactly; so do short all-caps acronyms (AWS, SSO) and
    // anything with digits in it ("tailscale0").
    if (k < letters || (!multi && /^[A-Z0-9]{2,3}$/.test(heard)) || (/[0-9]/.test(spoken) && !multi) || spoken.length < 2) continue;
    const key = soundKey(spoken);
    const seen = new Set<DictionaryTerm>();
    const consider = (t: DictionaryTerm, sameKey: boolean) => {
      if (seen.has(t)) return;
      seen.add(t);
      // Near misses land only on words the dictionary knows properly (yours, the built-in ones and
      // model names); joined words only on yours and the built-in ones, sounding the same.
      if (!isCurated(t) || (multi && (!sameKey || t.source === 'model' || !startsAlike(chunks[i].core, t.norm)))) return;
      const sim = soundSimilarity(spoken, t.norm);
      if (multi ? sim < 0.9 : !closeEnough(spoken, sim, sameKey)) return;
      const score = sameKey ? sim : sim * 0.95;
      if (!best || score > best.score) best = { length: span, text: t.text, kind: 'word', score };
    };
    for (const t of dict.byKey.get(key) ?? []) consider(t, true);
    if (!multi && key.length >= 4) {
      for (const t of dict.byKeyDeletion.get(key) ?? []) consider(t, false); // one sound missing from what was heard
      for (const d of keyDeletions(key)) {
        for (const t of dict.byKey.get(d) ?? []) if (editDistance(key, t.key) === 1) consider(t, false); // one extra sound
        for (const t of dict.byKeyDeletion.get(d) ?? []) if (editDistance(key, t.key) === 1) consider(t, false); // one sound swapped
      }
    }
  }
  return best;
}

function wordPass(dict: Dictionary, chunks: Chunk[], out: Correction[], bySound: boolean): Chunk[] {
  const result: Chunk[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const m = matchAlias(dict, chunks, i) ?? (bySound ? matchWords(dict, chunks, i) : null);
    if (!m) {
      result.push(chunks[i]);
      continue;
    }
    const first = chunks[i];
    const last = chunks[i + m.length - 1];
    const fromCore = chunks
      .slice(i, i + m.length)
      .map((c, k, all) => c.core + (k < all.length - 1 ? c.space : ''))
      .join('');
    const core = m.text + possessive(last.core);
    if (core !== fromCore) out.push({ from: fromCore, to: core, kind: m.kind });
    result.push({ lead: first.lead, core, trail: last.trail, space: last.space });
    i += m.length - 1;
  }
  return result;
}

export type CorrectOptions = {
  /** Near misses by sound need English spelling; other languages get commands and "heard as" only. */
  english?: boolean;
};

/** The corrected text and every change made (for diagnostics and tests). */
export function correctDictationDetailed(text: string, dict: Dictionary, opts: CorrectOptions = {}): { text: string; corrections: Correction[] } {
  if (!text.trim()) return { text, corrections: [] };
  const corrections: Correction[] = [];
  const { head, chunks } = split(text);
  const next = wordPass(dict, slashPass(dict, chunks, corrections), corrections, opts.english !== false);
  return { text: corrections.length ? join(head, next) : text, corrections };
}

export function correctDictation(text: string, dict: Dictionary, opts: CorrectOptions = {}): string {
  return correctDictationDetailed(text, dict, opts).text;
}
