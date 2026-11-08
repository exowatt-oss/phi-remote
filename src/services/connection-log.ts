/** The connection log for the clipboard: every paired computer's events, the app version and the time. */

import { Platform } from 'react-native';

import { hostState } from '@/components/host-state';
import { formatTraceReport } from '@/lib/conn-trace';

import { appBuild, appVersion, connTrace, deviceName, remote } from './remote';

export function connectionReport(now = Date.now()): string {
  const s = remote.store.getState();
  return formatTraceReport({
    app: { version: appVersion, build: appBuild },
    now,
    device: `${deviceName}, iOS ${String(Platform.Version)}`,
    hosts: s.hostOrder
      .map((id) => s.hosts[id])
      .filter(Boolean)
      .map((h) => ({ hubId: h.hubId, name: h.name, status: hostState(h, now).text, urls: h.urls, events: connTrace.events(h.hubId) })),
  });
}
