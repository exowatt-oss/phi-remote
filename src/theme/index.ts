import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { DarkTheme, DefaultTheme, type Theme } from 'expo-router';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform, useColorScheme } from 'react-native';

import { fonts, palettes, type Palette } from './tokens';

export * from './tokens';

export type ThemeValue = { colors: Palette; dark: boolean };

export function useTheme(): ThemeValue {
  const dark = useColorScheme() === 'dark';
  return { colors: dark ? palettes.dark : palettes.light, dark };
}

let glassCache: boolean | null = null;

/** iOS 26+ Liquid Glass, with the runtime API present (some betas lack it). */
export function glassAvailable(): boolean {
  if (glassCache === null) {
    try {
      glassCache = Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
    } catch {
      glassCache = false;
    }
  }
  return glassCache;
}

function useAccessibilityFlag(
  read: () => Promise<boolean>,
  event: 'reduceMotionChanged' | 'reduceTransparencyChanged',
): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    void read().then((v) => alive && setOn(v));
    const sub = AccessibilityInfo.addEventListener(event, setOn);
    return () => {
      alive = false;
      sub.remove();
    };
  }, [read, event]);
  return on;
}

/** Reduce Motion: gate repeating animations (shimmer, symbol effects) on this. */
export function useReduceMotion(): boolean {
  return useAccessibilityFlag(AccessibilityInfo.isReduceMotionEnabled, 'reduceMotionChanged');
}

/** Liquid Glass, unless the user asked for less transparency. */
export function useGlass(): boolean {
  const reduce = useAccessibilityFlag(AccessibilityInfo.isReduceTransparencyEnabled, 'reduceTransparencyChanged');
  return glassAvailable() && !reduce;
}

/** expo-router (react-navigation) theme derived from the tokens. */
export function navigationTheme(dark: boolean): Theme {
  const c = dark ? palettes.dark : palettes.light;
  const base = dark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    dark,
    colors: {
      ...base.colors,
      primary: c.icon,
      background: c.bg,
      card: c.bg,
      text: c.text,
      border: c.border,
      notification: c.accent,
    },
    fonts: {
      ...base.fonts,
      regular: { fontFamily: fonts.regular, fontWeight: 'normal' },
      medium: { fontFamily: fonts.medium, fontWeight: 'normal' },
      bold: { fontFamily: fonts.bold, fontWeight: 'normal' },
      heavy: { fontFamily: fonts.bold, fontWeight: 'normal' },
    },
  };
}

/** `#RRGGBB` → `rgba(r, g, b, a)` (for gradients that fade a token colour out). */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}
