import type { ConnStatus } from '../connection';
import { connectionTitle, initialConnInfo, reachOf, UNREACHABLE_LINE, type HostView } from '../store';

function host(name: string, status: ConnStatus): HostView {
  return {
    hubId: `hub-${name}`,
    name,
    urls: [],
    preferredUrl: '',
    deviceId: 'd',
    pairedAt: 1,
    lastSeenAt: null,
    conn: { ...initialConnInfo, status },
    features: null,
  };
}

describe('connecting vs offline vs all unreachable', () => {
  it('reads the first attempts as connecting, not offline', () => {
    const hosts = [host('MY-MAC', 'connecting'), host('devbox', 'idle'), host('mac-mini', 'live')];
    const r = reachOf(hosts);
    expect(r.connecting.map((h) => h.name)).toEqual(['MY-MAC', 'devbox']);
    expect(r.offline).toEqual([]);
    expect(r.allUnreachable).toBe(false);
    expect(connectionTitle(hosts)).toEqual({ text: 'Connecting to 2 computers…', spinner: true });
  });

  it('is all unreachable only when every computer failed its first attempts', () => {
    const offline = [host('a', 'offline'), host('b', 'offline'), host('c', 'offline')];
    expect(reachOf(offline).allUnreachable).toBe(true);
    expect(connectionTitle(offline)).toEqual({ text: 'Offline', spinner: false });
    // One still trying, or one live: not all unreachable.
    expect(reachOf([...offline.slice(0, 2), host('c', 'connecting')]).allUnreachable).toBe(false);
    expect(reachOf([...offline.slice(0, 2), host('c', 'live')]).allUnreachable).toBe(false);
    // Unpaired / incompatible computers have their own notice and do not count.
    expect(reachOf([...offline.slice(0, 2), host('c', 'unauthorized')]).allUnreachable).toBe(true);
    expect(reachOf([]).allUnreachable).toBe(false);
    expect(UNREACHABLE_LINE).toBe("Can't reach your computers. Check Tailscale on this iPhone.");
  });

  it('titles one, some and all computers', () => {
    expect(connectionTitle([host('a', 'live'), host('b', 'live')])).toBeNull();
    expect(connectionTitle([host('a', 'live'), host('MY-MAC', 'connecting')])).toEqual({ text: 'Connecting to MY-MAC…', spinner: true });
    expect(connectionTitle([host('a', 'live'), host('MY-MAC', 'offline')])).toEqual({ text: 'MY-MAC is offline', spinner: false });
    expect(connectionTitle([host('a', 'connecting'), host('b', 'offline')])).toEqual({ text: 'Connecting…', spinner: true });
    expect(connectionTitle([host('a', 'live'), host('b', 'offline'), host('c', 'offline')])).toEqual({ text: '2 computers offline', spinner: false });
  });
});
