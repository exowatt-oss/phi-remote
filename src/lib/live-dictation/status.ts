/**
 * The live-dictation model lifecycle as a small state machine, kept pure so the Settings status
 * line, the network gating and "what to do next" are unit-tested:
 *
 *   absent ──(toggle on + network allows)──▶ downloading ──▶ compiling ──▶ downloaded
 *   downloaded ──▶ prepare: idle ──▶ preparing ──▶ prepared ("Ready")
 *
 * Nothing downloads or prepares while the toggle is off (its default).
 */

import type { SlowRecord } from './perf-guard';

/** The model on disk. */
export type ModelPhase = 'absent' | 'downloading' | 'compiling' | 'downloaded';
/** The model in memory (this app process). */
export type PreparePhase = 'idle' | 'preparing' | 'prepared' | 'failed';

export type NetworkState = {
  /** null until the first NWPathMonitor update. */
  connected: boolean | null;
  /** Cellular or personal hotspot. */
  expensive: boolean;
  /** Low Data Mode. */
  constrained: boolean;
};

export type LiveState = {
  /** Native module present and iOS 18+. */
  supported: boolean;
  /** Settings toggle (default off). */
  enabled: boolean;
  /** "Download on cellular" (default off). */
  cellular: boolean;
  /** The device language is English or the "always English" switch is on. */
  english: boolean;
  slow: SlowRecord | null;
  model: ModelPhase;
  /** Download progress 0…1 (bytes on disk / download size). */
  fraction: number;
  prepare: PreparePhase;
  /** No successful prepare recorded for this app build + OS build: expect the one-time Neural Engine compile. */
  coldPrepare: boolean;
  /** Last download / prepare error (shown under the status). */
  error: string | null;
  network: NetworkState;
};

/** Wi-Fi rule: without "Download on cellular", only an inexpensive, unconstrained network. */
export function downloadAllowed(network: NetworkState, allowCellular: boolean): boolean {
  if (network.connected === false) return false;
  if (allowCellular) return true;
  // Unknown (no path update yet) counts as not allowed: the next update triggers the download.
  if (network.connected === null) return false;
  return !network.expensive && !network.constrained;
}

export type NextAction = 'download' | 'prepare' | 'none';

/** What the manager should start now (it also checks nothing is already in flight). */
export function nextAction(s: LiveState): NextAction {
  if (!s.supported || !s.enabled || s.slow || !s.english) return 'none';
  if (s.model === 'absent') return downloadAllowed(s.network, s.cellular) ? 'download' : 'none';
  if (s.model === 'downloaded' && s.prepare === 'idle') return 'prepare';
  return 'none';
}

export type StatusTone = 'secondary' | 'success' | 'warning' | 'danger';
export type StatusLine = { label: string; tone: StatusTone };

export const PREPARE_COLD_LABEL = 'Preparing (one time, about 2 min)';

export function statusLine(s: LiveState): StatusLine {
  if (!s.supported) return { label: 'Needs iOS 18 or later', tone: 'secondary' };
  if (s.slow) return { label: 'Off (too slow on this iPhone)', tone: 'warning' };
  if (s.model === 'downloading') {
    const pct = Math.max(0, Math.min(99, Math.floor(s.fraction * 100)));
    const waiting = !downloadAllowed(s.network, s.cellular);
    return { label: `Downloading ${pct}%${waiting ? ' · waiting for Wi-Fi' : ''}`, tone: 'secondary' };
  }
  if (s.model === 'compiling' || s.prepare === 'preparing') {
    return { label: s.coldPrepare ? PREPARE_COLD_LABEL : 'Preparing…', tone: 'secondary' };
  }
  if (s.prepare === 'failed') return { label: 'Could not prepare — turn it off and on to retry', tone: 'danger' };
  if (s.model === 'downloaded') {
    if (!s.enabled) return { label: 'Downloaded · off', tone: 'secondary' };
    if (!s.english) return { label: 'Off (English only)', tone: 'secondary' };
    return s.prepare === 'prepared' ? { label: 'Ready', tone: 'success' } : { label: 'Preparing…', tone: 'secondary' };
  }
  // absent (possibly with a partial download on disk)
  if (s.enabled && s.english) {
    if (s.error) return { label: `Not downloaded · ${s.error}`, tone: 'warning' };
    if (!downloadAllowed(s.network, s.cellular)) {
      const offline = s.network.connected === false;
      const partial = s.fraction > 0 ? ` (${Math.floor(s.fraction * 100)}%)` : '';
      return { label: `Not downloaded${partial} · ${offline ? 'offline' : 'waiting for Wi-Fi'}`, tone: 'secondary' };
    }
  }
  if (s.enabled && !s.english) return { label: 'Off (English only)', tone: 'secondary' };
  return { label: 'Not downloaded', tone: 'secondary' };
}

/** "~345 MB download, ~330 MB on this iPhone, English only" */
export const SIZE_NOTE = '~345 MB download, ~330 MB on this iPhone, English only';
