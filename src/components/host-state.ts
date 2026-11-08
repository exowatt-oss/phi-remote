import { lastSeen } from '@/lib/format';
import type { HostView } from '@/lib/store';
import type { DotState } from '@/ui';

/** A computer's state as a dot and a short phrase ("Live", "Offline · seen 4m ago"). */
export function hostState(h: HostView, now: number): { dot: DotState; text: string } {
  switch (h.conn.status) {
    case 'live':
      return { dot: 'live', text: 'Live' };
    case 'connecting':
    case 'idle':
      return { dot: 'connecting', text: 'Connecting…' };
    case 'paused':
      return { dot: 'idle', text: lastSeen(h.lastSeenAt, now) };
    case 'offline':
      return { dot: 'offline', text: h.lastSeenAt ? `Offline · ${lastSeen(h.lastSeenAt, now).toLowerCase()}` : 'Offline' };
    case 'unauthorized':
      return { dot: 'error', text: 'Pairing expired' };
    case 'incompatible':
      return { dot: 'error', text: 'Needs a newer phi' };
  }
}
