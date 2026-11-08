/**
 * Pulls `{ hubId, sessionId }` out of a notification. The hub sends it as custom APNs payload
 * keys; expo-notifications exposes a raw APNs payload under `request.trigger.payload` (and
 * `content.data` only for Expo-formatted pushes), so check every place it can land.
 */

export type SessionTarget = { hubId: string; sessionId: string };

function pick(v: unknown): SessionTarget | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.hubId === 'string' && o.hubId && typeof o.sessionId === 'string' && o.sessionId) {
    return { hubId: o.hubId, sessionId: o.sessionId };
  }
  return null;
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/** Accepts a Notification (`{ request: { content, trigger } }`) or a NotificationRequest. */
export function notificationTarget(notification: unknown): SessionTarget | null {
  if (typeof notification !== 'object' || notification === null) return null;
  const n = notification as Record<string, unknown>;
  const request = (typeof n.request === 'object' && n.request !== null ? n.request : n) as Record<string, unknown>;
  const content = (request.content ?? {}) as Record<string, unknown>;
  const trigger = (request.trigger ?? {}) as Record<string, unknown>;
  const data = parseMaybeJson(content.data);
  const dataObj = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const payload = parseMaybeJson(trigger.payload);
  const payloadObj = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  return (
    pick(dataObj) ??
    pick(parseMaybeJson(dataObj.body)) ??
    pick(payloadObj) ??
    pick(parseMaybeJson(payloadObj.body)) ??
    pick(parseMaybeJson(payloadObj.data))
  );
}

/** Parses `phiremote://session/<hubId>/<sessionId>` (or the bare path). */
export function parseSessionLink(input: string): SessionTarget | null {
  const m = /^(?:phiremote:\/{1,3})?\/?session\/([^/?#]+)\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(input.trim());
  if (!m) return null;
  try {
    return { hubId: decodeURIComponent(m[1]), sessionId: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}
