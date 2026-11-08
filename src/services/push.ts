/**
 * APNs registration for "notify me when a thread finishes". The hub talks to APNs directly
 * (docs/PROTOCOL.md); the app only hands every paired hub its device token.
 */

import * as Application from 'expo-application';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { PushRegistration } from '@/lib/client';
import { notificationTarget } from '@/lib/notification-target';

import { remote } from './remote';

const BUNDLE_ID = 'com.example.phiremote';

export type PushResult = { ok: true; registration: PushRegistration } | { ok: false; denied: boolean; message: string };

/**
 * APNs environment: read from the signed aps-environment entitlement when iOS exposes it,
 * else infer from the build (__DEV__ → sandbox, release → production).
 */
async function pushEnv(): Promise<PushRegistration['env']> {
  try {
    const env = await Application.getIosPushNotificationServiceEnvironmentAsync();
    if (env === 'development') return 'sandbox';
    if (env === 'production') return 'production';
  } catch {
    // not available (simulator / Android)
  }
  return __DEV__ ? 'sandbox' : 'production';
}

/** Gets (optionally asking for permission) the APNs token and registration payload. */
export async function getPushRegistration(askPermission: boolean): Promise<PushResult> {
  if (Platform.OS !== 'ios') return { ok: false, denied: false, message: 'Notifications are only available on iPhone.' };
  let perm = await Notifications.getPermissionsAsync();
  if (!perm.granted && askPermission && perm.canAskAgain) {
    perm = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
  }
  if (!perm.granted) {
    return { ok: false, denied: true, message: 'Notifications are turned off for phi in iOS Settings.' };
  }
  try {
    const token = await Notifications.getDevicePushTokenAsync();
    const apnsToken = typeof token.data === 'string' ? token.data : '';
    if (!apnsToken) return { ok: false, denied: false, message: 'iOS did not provide a push token.' };
    return {
      ok: true,
      registration: { apnsToken, env: await pushEnv(), bundleId: Application.applicationId ?? BUNDLE_ID },
    };
  } catch (err) {
    return {
      ok: false,
      denied: false,
      message: err instanceof Error ? err.message : 'Could not register for notifications.',
    };
  }
}

/** Turns notifications on (registering with every hub) or off. */
export async function setNotificationsEnabled(enabled: boolean): Promise<PushResult | { ok: true; registration: null }> {
  if (!enabled) {
    await remote.setPush(null);
    return { ok: true, registration: null };
  }
  const result = await getPushRegistration(true);
  if (result.ok) await remote.setPush(result.registration);
  return result;
}

let offered = false;

/**
 * After pairing, and at launch with a paired computer: if the user has never chosen (no
 * pref), turn notifications on once — iOS asks for permission, then every hub gets the token.
 * Never asks again after a no: the pref is 'off', or iOS reports the permission as denied.
 */
export async function offerNotifications(): Promise<void> {
  if (Platform.OS !== 'ios' || offered) return;
  await remote.init();
  if (offered || remote.notificationsPref !== undefined) return;
  if (remote.store.getState().hostOrder.length === 0) return;
  offered = true;
  const perm = await Notifications.getPermissionsAsync();
  if (!perm.granted && !perm.canAskAgain) return;
  await setNotificationsEnabled(true);
}

/** At launch: if the user turned notifications on before, re-register silently. */
export async function restorePushRegistration(): Promise<void> {
  await remote.init();
  if (remote.notificationsPref !== 'on') return;
  const result = await getPushRegistration(false);
  if (result.ok) remote.restorePush(result.registration);
}

let focused: { hubId: string; sessionId: string } | null = null;

/** Mirrors the focused thread so a banner for it is not shown while it is on screen. */
export function setForegroundThread(target: { hubId: string; sessionId: string } | null): void {
  focused = target;
  remote.setFocus(target);
}

export function configureForegroundNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const target = notificationTarget(notification);
      const onScreen = !!target && !!focused && target.hubId === focused.hubId && target.sessionId === focused.sessionId;
      return {
        shouldShowBanner: !onScreen,
        shouldShowList: true,
        shouldPlaySound: !onScreen,
        shouldSetBadge: false,
      };
    },
  });
}
