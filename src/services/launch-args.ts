/**
 * Simulator / QA launch arguments. iOS puts `-key value` launch arguments in NSUserDefaults'
 * argument domain, which RN `Settings` reads; an App Store or TestFlight install never has them.
 */

import { Platform, Settings } from 'react-native';

export function launchArg(key: string): string | null {
  if (Platform.OS !== 'ios') return null;
  try {
    const value = Settings.get(key);
    if (typeof value === 'number') return String(value);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}
