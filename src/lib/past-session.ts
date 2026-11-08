/**
 * The composer of a stored (not running) session. It is never pre-emptively blocked: `resumable`
 * is not consulted, an offline computer or an older phi only fails the send (the draft is kept),
 * and only a computer that is no longer paired stops it.
 */

import type { HostView } from './store';

type Host = Pick<HostView, 'name' | 'conn'> | null | undefined;

/** Why sending cannot even be tried: only an unpaired computer. Never `resumable`, never offline. */
export function pastBlockReason(host: Host): string | null {
  if (!host) return 'This computer is no longer paired';
  if (host.conn.status === 'unauthorized') return `${host.name} unpaired this iPhone`;
  return null;
}

/** The quiet line under a stored session's composer: where it stands. */
export function pastComposerNote(opts: {
  host: Host;
  legacy: boolean;
  fromPhoneCopy: boolean;
  /** "2h ago", "on Oct 3", "" … */
  ago: string;
}): string {
  const { host, legacy, fromPhoneCopy, ago } = opts;
  const blocked = pastBlockReason(host);
  if (blocked) return `${blocked}.`;
  const name = host?.name ?? 'this computer';
  if (legacy) return `Update phi on ${name} to resume its sessions.`;
  if (host?.conn.status === 'offline') return fromPhoneCopy ? `${name} is offline. This is the copy saved on this iPhone.` : `${name} is offline.`;
  return `Not running${ago ? ` \u00b7 last active ${ago}` : ''}. Send a message to resume it.`;
}

/**
 * Sends to a stored session: always tries the resume. A failure is shown like any failed send and
 * reported as `false`, so the composer keeps the typed text and photos.
 */
export async function sendToPast(run: () => Promise<unknown>, onError: (message: string) => void, describe: (err: unknown) => string): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (err) {
    onError(describe(err));
    return false;
  }
}
