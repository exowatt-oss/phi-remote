/**
 * Network path changes (expo-network, NWPathMonitor on iOS): Wi-Fi ↔ cellular, a VPN such as
 * Tailscale coming up or going away, no connection → connected. Each change reaches the
 * RemoteClient, which retries every computer that is not live at once (and checks live ones).
 * The first event is the path at launch (logged only). Bursts within 300 ms count as one.
 */

import { addNetworkStateListener, type NetworkState } from 'expo-network';

import { remote } from './remote';

const SETTLE_MS = 300;

let started = false;

export function watchNetwork(): void {
  if (started) return;
  started = true;
  let first = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: NetworkState | null = null;
  const describe = (s: NetworkState) => ({ type: String(s.type ?? 'unknown'), connected: s.isConnected !== false });
  try {
    addNetworkStateListener((state) => {
      if (first) {
        first = false;
        remote.networkChanged(describe(state), true);
        return;
      }
      latest = state;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (latest) remote.networkChanged(describe(latest));
      }, SETTLE_MS);
    });
  } catch {
    // No native module (tests, web): foreground and reconnects still trigger retries.
  }
}
