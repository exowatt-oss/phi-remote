/**
 * What the composer shows while live dictation runs: the draft with the recognized words at the
 * caret (or in place of the selection), split so committed words render in the normal colour and
 * the unstable tail muted. The spacing is exactly `resolveTranscriptCommit`'s, so ✓ lands the
 * same text that was on screen (minus a tail period the next update would remove).
 */

export type LivePreview = {
  /** Draft before the caret, plus a separating space when the insertion needs one. */
  before: string;
  /** Final words (never change again, except the last word's punctuation / case). */
  committed: string;
  /** " " between committed and tail when both are non-empty. */
  gap: string;
  /** The open utterance (may still change), trailing period hidden. */
  tail: string;
  /** A separating space when needed, plus the draft after the caret / selection. */
  after: string;
  /** Offset of the end of the recognized text (where the caret sits and the input scrolls to). */
  caret: number;
};

/** A partial ends with a period the next update usually removes; hide it until the words are final. */
export function displayTail(tail: string): string {
  const t = tail.replace(/\s+$/, '');
  return t.endsWith('.') && !t.endsWith('..') ? t.slice(0, -1) : t;
}

function englishSpacing(locale: string): boolean {
  const l = locale.replaceAll('_', '-').toLowerCase();
  return l === 'en' || l.startsWith('en-');
}

export function livePreview(
  draft: string,
  selection: { start: number; end: number },
  committed: string,
  tail: string,
  locale: string,
  opts: { hideTrailingPeriod?: boolean } = {},
): LivePreview | null {
  const c = committed.trim();
  const t = (opts.hideTrailingPeriod ?? true) ? displayTail(tail.trim()) : tail.trim();
  if (!c && !t) return null;
  const start = Math.max(0, Math.min(draft.length, selection.start));
  const end = Math.max(start, Math.min(draft.length, selection.end));
  let leftGap = '';
  let rightGap = '';
  // Same rule as resolveTranscriptCommit: only for a caret (no selection) and English spacing.
  if (start === end && englishSpacing(locale)) {
    const left = draft[start - 1];
    const right = draft[start];
    if (left !== undefined && /[A-Za-z0-9.!?,:;)\]}'"]/.test(left) && (right === undefined || /\s/.test(right))) leftGap = ' ';
    if (right !== undefined && /[A-Za-z0-9([{'"]/.test(right) && (left === undefined || /\s/.test(left))) rightGap = ' ';
  }
  const before = draft.slice(0, start) + leftGap;
  const gap = c && t ? ' ' : '';
  return {
    before,
    committed: c,
    gap,
    tail: t,
    after: rightGap + draft.slice(end),
    caret: before.length + c.length + gap.length + t.length,
  };
}

/** The whole preview as one string (what the input holds). */
export function previewText(p: LivePreview): string {
  return p.before + p.committed + p.gap + p.tail + p.after;
}
