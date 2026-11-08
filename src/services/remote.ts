/**
 * The app's single RemoteClient, wired to the platform: React Native WebSocket and fetch,
 * AppState, expo-secure-store for host tokens, expo-application for the app version.
 */

import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';
import { useStore } from 'zustand';

import { RemoteClient } from '@/lib/client';
import { ConnTrace } from '@/lib/conn-trace';
import type { SocketLike } from '@/lib/connection';
import { HistoryCache } from '@/lib/history-cache';
import type { FetchLike } from '@/lib/pairing';
import { HostStorage, type SecureKV } from '@/lib/storage';
import type { RemoteState } from '@/lib/store';

import { diagnosticsFiles, historyFiles } from './history-files';
import { launchArg } from './launch-args';

// Readable after first unlock so a reconnect right after a reboot (before unlock) fails
// cleanly instead of losing the token; never synced off this device.
const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const secureKV: SecureKV = {
  get: (key) => SecureStore.getItemAsync(key, STORE_OPTIONS),
  set: (key, value) => SecureStore.setItemAsync(key, value, STORE_OPTIONS),
  remove: (key) => SecureStore.deleteItemAsync(key, STORE_OPTIONS),
};

export const appVersion = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '0.1.0';
export const appBuild = Application.nativeBuildVersion ?? '0';
export const deviceName = Constants.deviceName || 'iPhone';

export const fetchImpl: FetchLike = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

/**
 * The connection log, kept in Documents/diagnostics/connection-log.json. QA: launched with
 * `-phiConnTraceLog 1`, every event is also logged (`[phi-conn] {"hub","at","kind",…}`), which
 * reaches the Simulator's unified log in Release builds.
 */
const logTrace = launchArg('phiConnTraceLog') !== null;
export const connTrace = new ConnTrace({
  files: diagnosticsFiles,
  saveDelayMs: logTrace ? 250 : 1_000,
  onEvent: logTrace ? (hubId, e) => console.log(`[phi-conn] ${JSON.stringify({ hub: hubId, ...e })}`) : undefined,
});

export const remote = new RemoteClient({
  storage: new HostStorage(secureKV),
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  fetch: fetchImpl,
  app: { version: appVersion, build: appBuild },
  deviceName,
  appState: AppState,
  historyCache: new HistoryCache(historyFiles),
  trace: connTrace,
  log: __DEV__ ? (message, error) => console.warn(`[remote] ${message}`, error ?? '') : undefined,
});

/** Subscribe a component to a slice of the remote state. Return stable values or use useShallow. */
export function useRemote<T>(selector: (state: RemoteState) => T): T {
  return useStore(remote.store, selector);
}
