/**
 * Read-aloud helpers (pure): turn assistant markdown into speakable text and pick the best
 * on-device voice. The app speaks with expo-speech (AVSpeechSynthesizer); nothing leaves
 * the phone.
 */

import { inlineText, parseMarkdown, type MdBlock, type MdInline } from './markdown';

export type VoiceLike = { identifier: string; name: string; quality: string; language: string };

const URL_RE = /\bhttps?:\/\/[^\s)>\]]+/gi;

function urlHost(url: string): string {
  const m = /^https?:\/\/(?:[^@/\s]+@)?([^/:?#\s]+)/i.exec(url);
  return (m?.[1] ?? '').replace(/^www\./i, '');
}

function spokenUrl(url: string): string {
  const host = urlHost(url);
  return host ? `link to ${host}` : 'link';
}

function speakInline(nodes: MdInline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
          return n.text;
        case 'code':
          return n.text.length > 40 || n.text.includes('\n') ? 'code' : n.text;
        case 'br':
          return ' ';
        case 'image':
          return '';
        case 'link': {
          const label = inlineText(n.children).trim();
          return !label || label === n.href || /^https?:\/\//i.test(label) ? spokenUrl(n.href) : speakInline(n.children);
        }
        default:
          return speakInline(n.children);
      }
    })
    .join('');
}

/** Ends a fragment with sentence punctuation so the synthesizer pauses between blocks. */
function sentence(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return /[.!?:;…]$/.test(t) ? t : `${t}.`;
}

type Part = { kind: 'text' | 'code'; text: string };

function codeSentence(n: number): string {
  return n === 1 ? 'Code block omitted.' : `${n} code blocks omitted.`;
}

function speakBlocks(blocks: MdBlock[], out: Part[]): void {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    switch (b.type) {
      case 'paragraph':
      case 'heading':
        out.push({ kind: 'text', text: sentence(speakInline(b.children)) });
        break;
      case 'code': {
        let n = 1;
        while (blocks[i + 1]?.type === 'code') {
          n += 1;
          i += 1;
        }
        out.push({ kind: 'code', text: codeSentence(n) });
        break;
      }
      case 'blockquote':
        speakBlocks(b.children, out);
        break;
      case 'list':
        for (const item of b.items) speakBlocks(item.children, out);
        break;
      case 'table':
        if (b.rows.length > 3) {
          out.push({ kind: 'text', text: 'Table omitted.' });
          break;
        }
        for (const row of b.rows) {
          const cells = row.map((cell, j) => {
            const head = b.header[j] ? speakInline(b.header[j]).trim() : '';
            const value = speakInline(cell).trim();
            return head && value ? `${head}: ${value}` : value;
          });
          out.push({ kind: 'text', text: sentence(cells.filter(Boolean).join(', ')) });
        }
        break;
      case 'hr':
        break;
    }
  }
}

// Paths read as their last segment: "/a/b/c.ts", "~/x/y", "src/z.tsx" → "c.ts", "y", "z.tsx".
const ABS_PATH_RE = /(^|[\s("'“‘])((?:~|\.{1,2})?\/(?:[\w.@+-]+\/)*([\w.@+-]+))(?=$|[\s)"'”’,;:!?]|\.(?:\s|$))/g;
const REL_PATH_RE = /(^|[\s("'“‘])((?:[\w.@+-]+\/)+([\w@+-]+\.[A-Za-z0-9]{1,8}))(?=$|[\s)"'”’,;:!?]|\.(?:\s|$))/g;

function cleanSpoken(text: string): string {
  return text
    .replace(URL_RE, (u) => spokenUrl(u))
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(ABS_PATH_RE, (_m, pre: string, _p: string, base: string) => `${pre}${base}`)
    .replace(REL_PATH_RE, (_m, pre: string, _p: string, base: string) => `${pre}${base}`)
    .replace(/\s*(?:->|=>|→)\s*/g, ' to ')
    .replace(/[*_~`#>|]+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Markdown → speakable text (DESIGN.md §4b rules): code blocks become "Code block omitted.",
 * long inline code becomes "code", paths read as their basename, links as their label (bare
 * URLs as "link to host"), list items and headings as sentences, small tables row by row.
 */
export function speakableText(markdown: string): string {
  const parts: Part[] = [];
  speakBlocks(parseMarkdown(markdown), parts);
  if (parts.length > 0 && parts.every((p) => p.kind === 'code')) return 'The reply is a code block.';
  return cleanSpoken(
    parts
      .map((p) => p.text)
      .filter(Boolean)
      .join(' '),
  );
}

/**
 * Splits speakable text into utterances of at most `max` characters on sentence
 * boundaries, never mid-word, so the first words start fast and stop is instant.
 */
export function chunkSpeech(text: string, max = 1000): string[] {
  const sentences = text.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g) ?? [];
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    const t = current.trim();
    if (t) chunks.push(t);
    current = '';
  };
  for (const raw of sentences) {
    let s = raw;
    if (current.length + s.length <= max) {
      current += s;
      continue;
    }
    flush();
    while (s.length > max) {
      const cut = s.lastIndexOf(' ', max);
      const at = cut > 0 ? cut : max;
      chunks.push(s.slice(0, at).trim());
      s = s.slice(at);
    }
    current = s;
  }
  flush();
  return chunks.filter(Boolean);
}

function qualityRank(v: VoiceLike): number {
  const id = v.identifier.toLowerCase();
  if (id.includes('.premium.')) return 3;
  if (v.quality === 'Enhanced' || id.includes('.enhanced.')) return 2;
  return 1;
}

/** Premium / Enhanced / Default, by identifier (expo-speech reports Premium as "Default"). */
export function voiceQuality(v: VoiceLike): 'Premium' | 'Enhanced' | 'Default' {
  const r = qualityRank(v);
  return r === 3 ? 'Premium' : r === 2 ? 'Enhanced' : 'Default';
}

/** Novelty and legacy voices (Bahh, Bells, Eloquence "Eddy", etc.) are never a good default. */
export function isNovelty(v: VoiceLike): boolean {
  const id = v.identifier.toLowerCase();
  return id.includes('speech.synthesis.voice') || id.includes('.eloquence.');
}

/**
 * Picks the best installed voice for a language tag (e.g. "en-US"): exact locale over same
 * language, Premium over Enhanced over default quality, never novelty voices. Null when no
 * voice speaks that language (let the system default decide).
 */
export function pickBestVoice(voices: VoiceLike[], languageTag: string): VoiceLike | null {
  const want = languageTag.replace('_', '-').toLowerCase();
  const base = want.split('-')[0];
  let best: { v: VoiceLike; score: number } | null = null;
  for (const v of voices) {
    if (isNovelty(v)) continue;
    const lang = v.language.replace('_', '-').toLowerCase();
    const langScore = lang === want ? 2 : lang.split('-')[0] === base ? 1 : 0;
    if (langScore === 0) continue;
    const score = qualityRank(v) * 10 + langScore;
    if (!best || score > best.score || (score === best.score && v.name.localeCompare(best.v.name) < 0)) {
      best = { v, score };
    }
  }
  return best?.v ?? null;
}

/** Display label for a voice, e.g. "Zoe (Premium)". */
export function voiceLabel(v: VoiceLike): string {
  const rank = qualityRank(v);
  return rank === 3 ? `${v.name} (Premium)` : rank === 2 ? `${v.name} (Enhanced)` : v.name;
}

/** Speech rate presets (AVSpeechUtterance rate multiplier as used by expo-speech; 1 = normal). */
export const SPEECH_RATES = [0.8, 1, 1.15, 1.3, 1.5] as const;
