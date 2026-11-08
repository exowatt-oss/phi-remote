/**
 * Markdown → a small block/inline model the renderer maps to native views.
 *
 * Parsing uses `marked`'s lexer (maintained, pure JS, GFM). Rendering is our own
 * (components/markdown.tsx) so code blocks and tables scroll horizontally inside themselves
 * and nothing depends on native code.
 */

import { Lexer, type Token, type Tokens } from 'marked';

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'del'; children: MdInline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: MdInline[] }
  | { type: 'image'; alt: string; href: string }
  | { type: 'br' };

export type MdListItem = { task: boolean; checked: boolean; children: MdBlock[] };

export type MdBlock =
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'heading'; depth: number; children: MdInline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'blockquote'; children: MdBlock[] }
  | { type: 'list'; ordered: boolean; start: number; items: MdListItem[] }
  | { type: 'hr' }
  | { type: 'table'; header: MdInline[][]; rows: MdInline[][][] };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function inlines(tokens: Token[] | undefined, fallback = ''): MdInline[] {
  if (!tokens || tokens.length === 0) return fallback ? [{ type: 'text', text: decodeEntities(fallback) }] : [];
  const out: MdInline[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'strong':
      case 'em':
      case 'del':
        out.push({ type: t.type, children: inlines((t as Tokens.Strong).tokens, (t as Tokens.Strong).text) });
        break;
      case 'codespan':
        out.push({ type: 'code', text: decodeEntities((t as Tokens.Codespan).text) });
        break;
      case 'link': {
        const l = t as Tokens.Link;
        out.push({ type: 'link', href: l.href, children: inlines(l.tokens, l.text) });
        break;
      }
      case 'image': {
        const img = t as Tokens.Image;
        out.push({ type: 'image', alt: decodeEntities(img.text || ''), href: img.href });
        break;
      }
      case 'br':
        out.push({ type: 'br' });
        break;
      case 'text': {
        const tt = t as Tokens.Text;
        if (tt.tokens && tt.tokens.length > 0) out.push(...inlines(tt.tokens));
        else out.push({ type: 'text', text: decodeEntities(tt.text) });
        break;
      }
      case 'escape':
        out.push({ type: 'text', text: (t as Tokens.Escape).text });
        break;
      case 'html': {
        // `<br>` is how markdown breaks a line inside a table cell.
        const raw = (t as Tokens.HTML).raw;
        out.push(/^<br\s*\/?>$/i.test(raw.trim()) ? { type: 'br' } : { type: 'text', text: raw });
        break;
      }
      case 'checkbox':
        break;
      default: {
        const raw = (t as { raw?: string }).raw;
        if (raw) out.push({ type: 'text', text: raw });
      }
    }
  }
  return mergeText(out);
}

function mergeText(items: MdInline[]): MdInline[] {
  const out: MdInline[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (item.type === 'text' && prev?.type === 'text') out[out.length - 1] = { type: 'text', text: prev.text + item.text };
    else out.push(item);
  }
  return out;
}

function blocks(tokens: Token[]): MdBlock[] {
  const out: MdBlock[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
      case 'def':
        break;
      case 'paragraph':
        out.push({ type: 'paragraph', children: inlines((t as Tokens.Paragraph).tokens, (t as Tokens.Paragraph).text) });
        break;
      case 'text': {
        // Tight list items carry bare text tokens; treat as paragraphs.
        const tt = t as Tokens.Text;
        out.push({ type: 'paragraph', children: inlines(tt.tokens, tt.text) });
        break;
      }
      case 'heading': {
        const h = t as Tokens.Heading;
        out.push({ type: 'heading', depth: h.depth, children: inlines(h.tokens, h.text) });
        break;
      }
      case 'code': {
        const c = t as Tokens.Code;
        out.push({ type: 'code', lang: (c.lang ?? '').trim().split(/\s+/)[0] ?? '', text: c.text.replace(/\n+$/, '') });
        break;
      }
      case 'blockquote':
        out.push({ type: 'blockquote', children: blocks((t as Tokens.Blockquote).tokens) });
        break;
      case 'list': {
        const l = t as Tokens.List;
        const start = typeof l.start === 'number' ? l.start : 1;
        out.push({
          type: 'list',
          ordered: l.ordered,
          start,
          items: l.items.map((item) => ({
            task: !!item.task,
            checked: !!item.checked,
            children: blocks(item.tokens.filter((x) => x.type !== 'checkbox')),
          })),
        });
        break;
      }
      case 'hr':
        out.push({ type: 'hr' });
        break;
      case 'table': {
        const tb = t as Tokens.Table;
        out.push({
          type: 'table',
          header: tb.header.map((cell) => inlines(cell.tokens, cell.text)),
          rows: tb.rows.map((row) => row.map((cell) => inlines(cell.tokens, cell.text))),
        });
        break;
      }
      case 'html': {
        const raw = (t as Tokens.HTML).raw.trim();
        if (raw) out.push({ type: 'paragraph', children: [{ type: 'text', text: raw }] });
        break;
      }
      default: {
        const raw = (t as { raw?: string }).raw?.trim();
        if (raw) out.push({ type: 'paragraph', children: [{ type: 'text', text: raw }] });
      }
    }
  }
  return out;
}

/** Parses markdown. Never throws: on a parser failure the text comes back as one paragraph. */
export function parseMarkdown(text: string): MdBlock[] {
  if (!text) return [];
  try {
    return blocks(Lexer.lex(text, { gfm: true, breaks: false }));
  } catch {
    return [{ type: 'paragraph', children: [{ type: 'text', text }] }];
  }
}

/**
 * Makes a partial (still streaming) reply parse like the finished one will: an unclosed
 * code fence is closed so a half-written block renders as code, not literal backticks.
 */
export function closeOpenFence(text: string): string {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    const fence = m[1];
    if (open === null) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length && line.trim() === fence) open = null;
  }
  if (open === null) return text;
  return `${text}${text.endsWith('\n') ? '' : '\n'}${open}`;
}

// DM Sans advance widths in 1/1000 em for ASCII 32-126, read from the hmtx tables of the TTFs
// app.config.ts embeds (400Regular, 700Bold; Italic is within 1% of Regular). Menlo is
// monospaced at 1233/2048 em.
// prettier-ignore
const DM_SANS_REGULAR = [266,250,291,804,580,786,734,159,373,373,480,550,182,541,198,392,684,312,576,591,607,610,628,534,608,628,202,227,550,550,550,524,1005,664,603,717,688,565,535,758,681,234,501,584,527,841,691,774,580,774,594,580,561,655,669,968,603,580,541,314,392,314,622,660,213,544,626,572,627,568,340,558,575,240,243,504,223,891,574,593,626,627,370,502,392,573,527,763,496,556,458,427,234,427,550];
// prettier-ignore
const DM_SANS_BOLD = [235,309,367,857,604,902,781,197,405,405,513,579,246,576,252,427,704,364,577,603,650,622,634,537,633,635,254,278,579,579,579,538,1046,709,638,738,707,583,556,778,714,272,541,653,558,886,729,784,614,784,631,604,597,685,706,1018,670,635,577,377,427,377,677,725,235,586,655,607,655,602,371,596,618,274,274,578,267,941,617,610,655,655,409,532,433,616,565,820,571,604,490,470,272,470,579];
const MENLO_EM = 1233 / 2048;

/** Width in points of one line of text, from the font's advance widths (kerning only narrows it). */
export function textAdvance(text: string, font: 'regular' | 'bold' | 'mono', size: number): number {
  let em = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (font === 'mono') em += c >= 0x1100 ? 1 : MENLO_EM;
    else if (c >= 32 && c <= 126) em += (font === 'bold' ? DM_SANS_BOLD : DM_SANS_REGULAR)[c - 32] / 1000;
    else em += c >= 0x1100 ? 1 : 0.7; // CJK, emoji, dashes: a full em; other non-ASCII letters: a wide letter
  }
  return em * size;
}

/**
 * Table columns on a phone: each column as wide as its longest cell line (header in bold),
 * between `minContent` and `maxContent` points of text, so short labels never wrap and long
 * prose wraps at a readable measure. The renderer stretches the columns to fill the message
 * when they fit and scrolls the table sideways when they do not. Sizes match the renderer:
 * cell text is footnote 14 pt, inline code Menlo at 0.9 x body.
 */
export const TABLE_CELL = { textSize: 14, codeSize: 14.4, padding: 20, slack: 3, minContent: 32, maxContent: 232, maxContentCap: 280 } as const;

function cellLines(nodes: MdInline[], bold: boolean, lines: number[]): void {
  const { textSize, codeSize } = TABLE_CELL;
  const add = (text: string, font: 'regular' | 'bold' | 'mono', size: number) =>
    text.split('\n').forEach((part, i) => {
      if (i > 0) lines.push(0);
      lines[lines.length - 1] += textAdvance(part, font, size);
    });
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        add(n.text, bold ? 'bold' : 'regular', textSize);
        break;
      case 'code':
        add(n.text, 'mono', codeSize);
        break;
      case 'image':
        add(n.alt, bold ? 'bold' : 'regular', textSize);
        break;
      case 'br':
        lines.push(0);
        break;
      case 'strong':
        cellLines(n.children, true, lines);
        break;
      default:
        cellLines(n.children, bold, lines);
    }
  }
}

/** Column widths in points (padding included) for a markdown table at a Dynamic Type scale. */
export function tableColumnWidths(header: MdInline[][], rows: MdInline[][][], fontScale = 1): number[] {
  const { padding, slack, minContent, maxContent, maxContentCap } = TABLE_CELL;
  const count = Math.max(header.length, ...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let col = 0; col < count; col++) {
    let content = 0;
    [header, ...rows].forEach((row, r) => {
      if (!row[col]) return;
      const lines = [0];
      cellLines(row[col], r === 0, lines);
      content = Math.max(content, ...lines);
    });
    const max = Math.min(maxContent * fontScale, maxContentCap);
    widths.push(Math.ceil(Math.min(max, Math.max(minContent, content) * fontScale) + padding + slack));
  }
  return widths;
}

/** Flattens inline nodes to plain text (for accessibility labels and copying). */
export function inlineText(nodes: MdInline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
        case 'code':
          return n.text;
        case 'image':
          return n.alt;
        case 'br':
          return '\n';
        default:
          return inlineText(n.children);
      }
    })
    .join('');
}
