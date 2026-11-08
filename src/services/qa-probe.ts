/**
 * Simulator / QA only: JS-thread stall probe. Inert unless the app is launched with
 * `-phiStallProbe <seconds>`. For that long after launch a 50 ms timer measures how late it
 * fires; every delay over 100 ms (the JS thread was busy, so timers, sockets and the UI waited)
 * is logged as `[phi-perf] {"stallMs",…}` and the list is written to
 * Documents/diagnostics/js-stalls.json, beside the connection log.
 */

import { diagnosticsFiles } from './history-files';
import { launchArg } from './launch-args';

const TICK_MS = 50;
const REPORT_OVER_MS = 100;

let started = false;

export function runStallProbeIfRequested(): void {
  const arg = launchArg('phiStallProbe');
  if (!arg || started) return;
  started = true;
  const seconds = Math.max(5, Math.min(600, Number(arg) || 120));
  const startedAt = Date.now();
  const stalls: { at: number; ms: number }[] = [];
  let worst = 0;
  let total = 0;
  let expected = Date.now() + TICK_MS;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  const write = () => {
    writeTimer = null;
    const body = { startedAt, seconds, tickMs: TICK_MS, worstMs: worst, totalStallMs: total, stalls };
    void diagnosticsFiles.write('js-stalls.json', JSON.stringify(body)).catch(() => undefined);
  };
  const tick = () => {
    const now = Date.now();
    const late = now - expected;
    if (late > REPORT_OVER_MS) {
      stalls.push({ at: expected, ms: late });
      worst = Math.max(worst, late);
      total += late;
      console.log(`[phi-perf] ${JSON.stringify({ stallMs: late, at: new Date(expected).toISOString(), sinceStartMs: expected - startedAt })}`);
      if (!writeTimer) writeTimer = setTimeout(write, 500);
    }
    if (now - startedAt >= seconds * 1000) {
      write();
      console.log(`[phi-perf] ${JSON.stringify({ done: true, seconds, worstMs: worst, totalStallMs: total, count: stalls.length })}`);
      return;
    }
    expected = now + TICK_MS;
    setTimeout(tick, TICK_MS);
  };
  setTimeout(tick, TICK_MS);
  write();
}
