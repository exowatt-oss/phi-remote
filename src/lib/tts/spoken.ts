/**
 * Text preparation for the natural voice (pure). `speakableText` (../speech.ts) has already
 * dropped code blocks, long inline code, tables, URLs and paths; this turns what is left into
 * the words a person would say ("12%" → "12 percent", "v0.18.2" → "version 0 point 18 point 2",
 * "2 GB" → "2 gigabytes", "Nov 5" → "November 5", "5x" → "5 times") and splits it into pieces
 * for streaming. The model spells out plain numbers, decimals, ordinals and clock times itself.
 *
 * `PRONUNCIATIONS` are word overrides in Misaki's phoneme alphabet (what the model reads; the
 * capital letters are diphthongs: A = "ay", I = "eye", O = "oh", W = "ow", Y = "oy"), for the
 * dictation dictionary's names its lexicon gets wrong. "phi" ("fye", rhymes with "fly"), "Jev"
 * and most of the others are already right.
 */

/** Word (matched in any case) → Misaki phonemes. */
export const PRONUNCIATIONS: Readonly<Record<string, string>> = {
  phi: 'fˈI',
  jev: 'ʤˈɛv',
  dsv4: 'dˌiˌɛsvˈi fˈɔɹ',
  litellm: 'lˈIt ˌɛlˌɛlˈɛm',
  postgres: 'pˈOstɡɹˌɛs',
  xcode: 'ˈɛkskˌOd',
  json: 'ʤˈAsᵊn',
  yaml: 'jˈæmᵊl',
  sqlite: 'ˌɛskjuˈɛlˌIt',
  pnpm: 'pˌiˌɛnpˌiˈɛm',
  stdout: 'stˈændəɹd ˈWt',
  stderr: 'stˈændəɹd ˈɛɹəɹ',
  readme: 'ɹˈɛdmi',
  oauth: 'ˈOˌɔθ',
};

/** File extensions read after "dot" ("remote.ts" → "remote dot T S"). */
const EXTENSIONS: Record<string, string> = {
  ts: 'T S',
  tsx: 'T S X',
  js: 'J S',
  jsx: 'J S X',
  mjs: 'M J S',
  py: 'pie',
  rs: 'R S',
  md: 'M D',
  sh: 'S H',
  css: 'C S S',
  html: 'H T M L',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  swift: 'swift',
  txt: 'text',
  sql: 'sequel',
  log: 'log',
};
const EXT_RE = new RegExp(`\\b([\\w-]+)\\.(${Object.keys(EXTENSIONS).join('|')})\\b`, 'g');

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const MONTH_ABBR: Record<string, string> = {
  jan: 'January',
  feb: 'February',
  mar: 'March',
  apr: 'April',
  jun: 'June',
  jul: 'July',
  aug: 'August',
  sep: 'September',
  sept: 'September',
  oct: 'October',
  nov: 'November',
  dec: 'December',
};

/** Unit after a number → [singular, plural]. Case-sensitive (MB, ms, kWh). */
const UNITS: Record<string, [string, string]> = {
  KB: ['kilobyte', 'kilobytes'],
  kB: ['kilobyte', 'kilobytes'],
  MB: ['megabyte', 'megabytes'],
  GB: ['gigabyte', 'gigabytes'],
  TB: ['terabyte', 'terabytes'],
  ms: ['millisecond', 'milliseconds'],
  s: ['second', 'seconds'],
  sec: ['second', 'seconds'],
  secs: ['second', 'seconds'],
  min: ['minute', 'minutes'],
  mins: ['minute', 'minutes'],
  h: ['hour', 'hours'],
  hr: ['hour', 'hours'],
  hrs: ['hour', 'hours'],
  W: ['watt', 'watts'],
  kW: ['kilowatt', 'kilowatts'],
  MW: ['megawatt', 'megawatts'],
  GW: ['gigawatt', 'gigawatts'],
  Wh: ['watt hour', 'watt hours'],
  kWh: ['kilowatt hour', 'kilowatt hours'],
  MWh: ['megawatt hour', 'megawatt hours'],
  GWh: ['gigawatt hour', 'gigawatt hours'],
  Hz: ['hertz', 'hertz'],
  kHz: ['kilohertz', 'kilohertz'],
  MHz: ['megahertz', 'megahertz'],
  GHz: ['gigahertz', 'gigahertz'],
  '°C': ['degree Celsius', 'degrees Celsius'],
  '°F': ['degree Fahrenheit', 'degrees Fahrenheit'],
};
const UNIT_RE = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s?(${Object.keys(UNITS)
    .sort((a, b) => b.length - a.length)
    .join('|')})(?![\\w°])`,
  'g',
);

function unit(n: string, u: string): string {
  // Decades read as decades ("the 1990s"), not seconds.
  if (u === 's' && /^\d{3}0$/.test(n)) return `${n}s`;
  const [one, many] = UNITS[u];
  return `${n} ${n === '1' ? one : many}`;
}

/** Spoken form of numbers, units, dates and abbreviations. */
export function spokenForm(text: string): string {
  return (
    text
      // 2026-11-05 → November 5, 2026
      .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y: string, mo: string, d: string) => {
        const month = MONTHS[Number(mo) - 1];
        const day = Number(d);
        return month && day >= 1 && day <= 31 ? `${month} ${day}, ${y}` : m;
      })
      // Nov 5 / Nov. 5 → November 5
      .replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?(?=\s+\d{1,2}\b)/g, (m, a: string) => MONTH_ABBR[a.toLowerCase()] ?? m)
      .replace(EXT_RE, (_m, name: string, ext: string) => `${name} dot ${EXTENSIONS[ext]}`)
      // 1,234,567 → 1234567 (the model reads the number whole)
      .replace(/(\d),(?=\d{3}\b)/g, '$1')
      .replace(/\bv(\d+(?:\.\d+){1,3})\b/g, (_m, v: string) => `version ${v.split('.').join(' point ')}`)
      .replace(/\b(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?\b/g, (m) => m.split('.').join(' point '))
      .replace(/\$\s?(\d+(?:\.\d+)?)(?:\s?([kKmMbB])\b)?/g, (_m, n: string, s: string | undefined) => {
        const scale = s ? { k: ' thousand', m: ' million', b: ' billion' }[s.toLowerCase()] : '';
        return `${n}${scale} ${n === '1' && !scale ? 'dollar' : 'dollars'}`;
      })
      .replace(/(\d)\s?%/g, '$1 percent')
      .replace(/\b(\d+(?:\.\d+)?)x\b/g, '$1 times')
      .replace(/\s?×\s?/g, ' times ')
      // 10-15 → 10 to 15 (not inside longer dash chains like phone numbers)
      .replace(/(?<![\d-])(\d{1,4})\s?[–-]\s?(\d{1,4})(?![\d-])/g, '$1 to $2')
      .replace(UNIT_RE, (_m, n: string, u: string) => unit(n, u))
      .replace(/~\s?(?=\d)/g, 'about ')
      .replace(/≈\s?/g, 'about ')
      .replace(/\be\.g\.,?/gi, 'for example,')
      .replace(/\bi\.e\.,?/gi, 'that is,')
      .replace(/\bvs\.?(?=\s)/gi, 'versus')
      .replace(/\bapprox\.(?=\s)/gi, 'approximately')
      .replace(/\bw\/o\b/gi, 'without')
      .replace(/\bw\/(?=\s)/gi, 'with')
      .replace(/\s*&\s*/g, ' and ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export type SpeechPiece = {
  text: string;
  /** Seconds of silence after this piece (the model's own edge silence is trimmed natively). */
  pause: number;
};

/** First piece: short, so the first words come quickly (~4 s of speech, inside the model's fast path). */
export const FIRST_PIECE_CHARS = 70;
/** Later pieces: whole sentences up to this length (a long sentence splits at commas). */
export const PIECE_CHARS = 160;
/** A clause longer than this splits between words. */
export const HARD_PIECE_CHARS = 240;
export const SENTENCE_PAUSE = 0.3;
export const CLAUSE_PAUSE = 0.12;

/** Sentences: split after . ! ? … (plus closing quotes/brackets) followed by a space, never inside "3.5". */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[.!?…]+["')\]”’]*(?=\s|$)/g;
  let start = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    const s = text.slice(start, end).trim();
    if (s) out.push(s);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/** Clauses: split after , ; : and around dashes, each kept with its punctuation. */
function splitClauses(sentence: string): string[] {
  return sentence
    .split(/(?<=[,;:])\s+|\s+(?=[—–-]\s)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Splits a run of words into parts of at most `max` characters, between words. */
function splitWords(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf(' ', max);
    const at = cut > 0 ? cut : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Speakable text → pieces for the natural voice: whole sentences merged while they fit (very
 * short sentences sound better read together), long sentences split at clause punctuation, the
 * first piece kept short. Lengths scale with the reading speed (faster speech fits more words
 * in the same audio). Each piece carries the pause that follows it.
 */
export function speechPieces(text: string, rate = 1): SpeechPiece[] {
  const scale = Math.min(2, Math.max(0.5, rate));
  const first = Math.round(FIRST_PIECE_CHARS * scale);
  const target = Math.round(PIECE_CHARS * scale);
  const hard = Math.round(HARD_PIECE_CHARS * scale);
  const pieces: SpeechPiece[] = [];
  let current = '';
  let endsSentence = false;
  const limit = () => (pieces.length === 0 ? first : target);
  const flush = () => {
    const t = current.trim();
    if (t) pieces.push({ text: t, pause: (endsSentence ? SENTENCE_PAUSE : CLAUSE_PAUSE) / scale });
    current = '';
  };
  for (const sentence of splitSentences(text)) {
    if (current && current.length + 1 + sentence.length <= limit()) {
      current += ` ${sentence}`;
      endsSentence = true;
      continue;
    }
    flush();
    if (sentence.length <= limit()) {
      current = sentence;
      endsSentence = true;
      continue;
    }
    let clauses = splitClauses(sentence);
    // The very first words wait for this piece: a long opening clause gives up its head.
    if (pieces.length === 0 && clauses[0].length > Math.round(first * 1.6)) {
      const head = splitWords(clauses[0], first)[0];
      clauses = [head, clauses[0].slice(head.length).trim(), ...clauses.slice(1)];
    }
    clauses = clauses.flatMap((c) => (c.length > hard ? splitWords(c, target) : [c]));
    clauses.forEach((clause, i) => {
      if (current && current.length + 1 + clause.length > limit()) flush();
      current = current ? `${current} ${clause}` : clause;
      endsSentence = i === clauses.length - 1;
    });
  }
  flush();
  if (pieces.length > 0) pieces[pieces.length - 1].pause = 0;
  return pieces;
}
