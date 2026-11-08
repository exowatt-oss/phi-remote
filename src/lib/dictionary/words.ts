/**
 * Common English words (SCOWL up to size 50, with capitalized words and first names): dictation
 * corrections leave them as heard unless the user listed them as a "heard as" spelling or they
 * follow "slash". The list is decoded on first use (~70k words).
 */

import { COMMON_WORDS_FRONT_CODED } from '../../generated/common-words';

/** Everyday speech and tech words SCOWL's common list lacks; also never corrected. */
const EXTRA = `ok okay yeah yep nope gonna wanna gotta kinda sorta lol um uh hmm
app apps api apis repo repos config configs backend frontend dev devs prod env envs ui ux sdk cli
url urls wifi iphone ipad ios macos android github gitlab slack email emails docker npm json yaml
async login logout signup subagent subagents workflow workflows websocket localhost admin admins
blog podcast emoji emojis website websites online offline inline startup startups`;

let words: Set<string> | null = null;

function decode(): Set<string> {
  const set = new Set<string>();
  const s = COMMON_WORDS_FRONT_CODED;
  let prev = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    const shared = c <= 57 ? c - 48 : c - 55; // '0'-'9' then 'A'-'Z'
    let j = i + 1;
    while (j < s.length && s.charCodeAt(j) >= 97) j += 1; // the rest: lowercase letters
    prev = prev.slice(0, shared) + s.slice(i + 1, j);
    set.add(prev);
    i = j;
  }
  for (const w of EXTRA.split(/\s+/)) if (w) set.add(w);
  return set;
}

/** `word` (any case, possessive `'s` ignored) is a common English word or a first name. */
export function isCommonWord(word: string): boolean {
  words ??= decode();
  const w = word.toLowerCase().replace(/['’]s$/, '');
  if (words.has(w)) return true;
  // Simple inflections of a listed word the list does not carry (repos → repo, configs, apps).
  if (w.length > 3 && w.endsWith('s') && words.has(w.slice(0, -1))) return true;
  return false;
}

/** For tests. */
export function commonWordCount(): number {
  words ??= decode();
  return words.size;
}
