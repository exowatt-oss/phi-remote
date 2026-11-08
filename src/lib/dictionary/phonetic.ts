/**
 * How a word sounds, coarsely, for matching what dictation heard against the dictionary:
 *
 *   soundSpelling  the word respelled the way it is said: ph → f, ch/sh → j, c → k or s, z → s,
 *                  x → ks (a leading X is "ex": "exampleco" → "ekswat"), double letters once.
 *                  "Chev" and "Jev" both become "jev"; "fi" and "phi" both "fi".
 *   soundKey       its consonant skeleton: soundSpelling with voiced and voiceless pairs merged
 *                  (b/p, d/t, g/k, v/f) and vowels dropped (a leading vowel kept as "a").
 *                  "exampleco" and "ExampleCo" are both "akswt"; "postgrass" and "Postgres" "pstkrs".
 *
 * Two words are near misses when their keys are equal and their sound spellings are close
 * (`soundSimilarity`, 1 − edit distance / length).
 */

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

/** Lowercase letters and digits only. */
export function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function soundSpelling(word: string): string {
  let w = normalizeWord(word);
  if (!w) return w;
  if (w[0] === 'x') w = `eks${w.slice(1)}`;
  w = w
    .replace(/^(kn|gn|pn|wr|ps)/, (m) => m[1])
    .replace(/ph/g, 'f')
    .replace(/gh/g, '')
    .replace(/tch|dg/g, 'j')
    .replace(/sch/g, 'sk')
    .replace(/ch|sh/g, 'j')
    .replace(/ck/g, 'k')
    .replace(/qu/g, 'kw')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/g(?=[eiy])/g, 'j')
    .replace(/z/g, 's');
  let out = '';
  for (const ch of w) if (ch !== out[out.length - 1]) out += ch;
  return out;
}

const VOICING: Record<string, string> = { b: 'p', d: 't', g: 'k', v: 'f' };

export function soundKey(word: string): string {
  const w = soundSpelling(word);
  let out = '';
  for (let i = 0; i < w.length; i += 1) {
    const ch = w[i];
    let k: string;
    if (VOWELS.has(ch)) {
      if (i > 0) continue;
      k = 'a';
    } else if (ch === 'h') {
      continue;
    } else if (ch === 'w') {
      // w only where it is heard: before a vowel ("watt"), not in "ow"/"aw".
      if (!VOWELS.has(w[i + 1] ?? '')) continue;
      k = 'w';
    } else {
      k = VOICING[ch] ?? ch;
    }
    if (k !== out[out.length - 1]) out += k;
  }
  return out;
}

/** Levenshtein distance (small strings). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1 for the same sound spelling, 0 for nothing in common. */
export function soundSimilarity(a: string, b: string): number {
  const x = soundSpelling(a);
  const y = soundSpelling(b);
  const n = Math.max(x.length, y.length);
  return n === 0 ? 0 : 1 - editDistance(x, y) / n;
}

/** Every string `key` becomes with one character removed (for one-edit key lookups). */
export function keyDeletions(key: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < key.length; i += 1) out.push(key.slice(0, i) + key.slice(i + 1));
  return out;
}
