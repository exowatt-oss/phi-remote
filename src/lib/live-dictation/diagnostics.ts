/**
 * Numbers for Settings › Voice › Live dictation details, so a real-iPhone test needs no device
 * logs: the last prepare (Neural Engine compile) and the last 5 dictation sessions. No transcript
 * text is ever stored, only counts and timings.
 */

import { median, percentile } from './perf-guard';

export const MAX_SESSIONS = 5;

export type SessionOutcome = 'inserted' | 'cancelled' | 'no-speech' | 'fell-back' | 'interrupted' | 'error';

export type SessionDiag = {
  at: number;
  outcome: SessionOutcome;
  /** Live updates (re-reads) during the session. */
  updates: number;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  /** End of speech (✓) → final text. */
  finalMs: number | null;
  audioSeconds: number;
  words: number;
  footprintStartMB: number | null;
  footprintPeakMB: number | null;
  footprintEndMB: number | null;
  thermalStart: string | null;
  thermalEnd: string | null;
};

export type PrepareDiag = {
  at: number;
  /** Wall time of prepare() (the Neural Engine compile on a cold load). */
  seconds: number;
  /** One-time .mlpackage → .mlmodelc compile after the download, when it happened in this run. */
  modelCompileSeconds: number | null;
  functionSeconds: Record<string, number>;
  computeUnits: string;
  footprintBeforeMB: number | null;
  footprintAfterMB: number | null;
  footprintPeakMB: number | null;
  thermalStart: string | null;
  thermalEnd: string | null;
  osVersionString: string;
  appBuild: string;
};

export type DownloadDiag = { at: number; seconds: number };

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function summarizeSession(input: {
  at: number;
  outcome: SessionOutcome;
  decodeMs: readonly number[];
  finalMs?: number | null;
  audioSeconds?: number;
  words?: number;
  footprintStartMB?: number | null;
  footprintPeakMB?: number | null;
  footprintEndMB?: number | null;
  thermalStart?: string | null;
  thermalEnd?: string | null;
}): SessionDiag {
  const d = input.decodeMs;
  const round = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v));
  return {
    at: input.at,
    outcome: input.outcome,
    updates: d.length,
    medianMs: round(median(d)),
    p95Ms: round(percentile(d, 95)),
    maxMs: round(d.length ? Math.max(...d) : null),
    finalMs: round(input.finalMs),
    audioSeconds: Math.round((input.audioSeconds ?? 0) * 10) / 10,
    words: input.words ?? 0,
    footprintStartMB: round(input.footprintStartMB),
    footprintPeakMB: round(input.footprintPeakMB),
    footprintEndMB: round(input.footprintEndMB),
    thermalStart: input.thermalStart ?? null,
    thermalEnd: input.thermalEnd ?? null,
  };
}

/** Newest first, at most MAX_SESSIONS. */
export function pushSession(list: readonly SessionDiag[], s: SessionDiag): SessionDiag[] {
  return [s, ...list].slice(0, MAX_SESSIONS);
}

export type AneVerdict = { label: string; tone: 'success' | 'warning' | 'danger' | 'secondary' };

/**
 * Whether the encoder appears to run on the Neural Engine, from the median live-update time:
 * ~30–120 ms expected on a recent iPhone's Neural Engine, ≥ 500 ms means Core ML fell back to the CPU.
 */
export function aneVerdict(medianMs: number | null | undefined): AneVerdict {
  if (medianMs === null || medianMs === undefined) return { label: 'No live session yet', tone: 'secondary' };
  if (medianMs <= 200) return { label: 'Yes — Neural Engine speed', tone: 'success' };
  if (medianMs <= 500) return { label: 'Unclear — slower than expected', tone: 'warning' };
  return { label: 'No — CPU fallback speed', tone: 'danger' };
}

export function formatMs(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${Math.round(v)} ms`;
}

export function formatMB(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${Math.round(v)} MB`;
}

export function formatSeconds(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v < 10) return `${v.toFixed(1)} s`;
  if (v < 120) return `${Math.round(v)} s`;
  const m = Math.floor(v / 60);
  return `${m} min ${Math.round(v - m * 60)} s`;
}

/** "+107 MB" style delta between two footprints. */
export function formatDelta(from: number | null | undefined, to: number | null | undefined): string {
  if (from === null || from === undefined || to === null || to === undefined) return '—';
  const d = Math.round(to - from);
  return `${d >= 0 ? '+' : '−'}${Math.abs(d)} MB`;
}
