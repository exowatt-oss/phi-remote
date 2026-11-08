/**
 * Design tokens — the only place the app's look lives. Screens and components read these
 * through useTheme(); restyling means editing this file (and the primitives in src/ui).
 *
 * Values follow T3 Code's neutral surfaces, type, radii and motion, with
 * a neutral blue accent. Change the palette accents to theme your own build.
 */

import { Platform } from 'react-native';

export type Palette = {
  /** Screen, sheet and feed background. */
  bg: string;
  /** Cards. */
  bgElevated: string;
  /** Grouped-list background (= screen). */
  bgGrouped: string;
  /** Grouped cells, quiet fills, chips. */
  surface: string;
  /** Pressed fill on `surface`. */
  surfacePressed: string;
  border: string;
  borderStrong: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  /** Text and icons on accent fills. */
  onAccent: string;
  accent: string;
  accentPressed: string;
  /** Tinted accent background (disabled send, selected chip). */
  accentSoft: string;
  success: string;
  danger: string;
  dangerSoft: string;
  warning: string;
  warningSoft: string;
  codeBg: string;
  codeBorder: string;
  codeText: string;
  /** Fenced code inside a user bubble. */
  userCodeBg: string;
  /** Inline code text. */
  inlineCode: string;
  /** Backdrop behind modals and small overlay controls. */
  scrim: string;
  shadow: string;
  userBubble: string;
  /** Pressed list row on `bg`. */
  rowPressed: string;
  /** Pressed work-log row. */
  subtle: string;
  /** Pressed row on a glass or translucent surface (slash-command menu). */
  pressedOverlay: string;
  /** Hairline row dividers. */
  separator: string;
  /** Opaque composer / floating-control fallback when Liquid Glass is unavailable. */
  composerSurface: string;
  composerBorder: string;
  icon: string;
  iconMuted: string;
  chevron: string;
  /** Camera viewfinder backdrop and the text drawn over it. */
  camera: string;
  onCamera: string;
  cameraHint: string;
};

const light: Palette = {
  bg: '#FCFCFC',
  bgElevated: '#FFFFFF',
  bgGrouped: '#FCFCFC',
  surface: '#F4F4F5',
  surfacePressed: '#E4E4E7',
  border: '#E4E4E7',
  borderStrong: '#D4D4D8',
  text: '#27272A',
  textSecondary: '#6F6F79',
  textTertiary: '#71717B',
  onAccent: '#FFFFFF',
  accent: '#2659A8',
  accentPressed: '#194580',
  accentSoft: 'rgba(38, 89, 168, 0.10)',
  success: '#009966',
  danger: '#C10007',
  dangerSoft: '#FCEBEC',
  warning: '#BB4D00',
  warningSoft: '#FCF4E8',
  codeBg: '#FFFFFF',
  codeBorder: '#E4E4E7',
  codeText: '#27272A',
  userCodeBg: 'rgba(0, 0, 0, 0.16)',
  inlineCode: '#6F6F79',
  scrim: 'rgba(0, 0, 0, 0.22)',
  shadow: '#000000',
  userBubble: '#EFEFF1',
  rowPressed: '#F4F4F5',
  subtle: '#FAFAFA',
  pressedOverlay: 'rgba(0, 0, 0, 0.06)',
  separator: 'rgba(228, 228, 231, 0.55)',
  composerSurface: 'rgba(244, 244, 245, 0.94)',
  composerBorder: 'rgba(228, 228, 231, 0.8)',
  icon: '#27272A',
  iconMuted: '#71717B',
  chevron: 'rgba(113, 113, 123, 0.42)',
  camera: '#000000',
  onCamera: '#FFFFFF',
  cameraHint: 'rgba(0, 0, 0, 0.6)',
};

const dark: Palette = {
  bg: '#0A0A0A',
  bgElevated: '#111111',
  bgGrouped: '#0A0A0A',
  surface: '#1A1B1B',
  surfacePressed: '#252626',
  border: '#191919',
  borderStrong: '#1E1E1E',
  text: '#F5F5F5',
  textSecondary: '#838383',
  textTertiary: '#818181',
  onAccent: '#0A0A0A',
  accent: '#7FAEFF',
  accentPressed: '#608CE0',
  accentSoft: 'rgba(127, 174, 255, 0.14)',
  success: '#00D492',
  danger: '#FF6467',
  dangerSoft: '#301214',
  warning: '#FFB900',
  warningSoft: '#312108',
  codeBg: '#111111',
  codeBorder: '#191919',
  codeText: '#F5F5F5',
  userCodeBg: 'rgba(0, 0, 0, 0.28)',
  inlineCode: '#838383',
  scrim: 'rgba(0, 0, 0, 0.48)',
  shadow: '#000000',
  userBubble: '#161616',
  rowPressed: '#141414',
  subtle: '#111111',
  pressedOverlay: 'rgba(255, 255, 255, 0.08)',
  separator: 'rgba(25, 25, 25, 0.55)',
  composerSurface: 'rgba(26, 27, 27, 0.9)',
  composerBorder: 'rgba(25, 25, 25, 0.8)',
  icon: '#F5F5F5',
  iconMuted: '#818181',
  chevron: 'rgba(129, 129, 129, 0.42)',
  camera: '#000000',
  onCamera: '#FFFFFF',
  cameraHint: 'rgba(0, 0, 0, 0.6)',
};

export const palettes = { light, dark } as const;

/** DM Sans is embedded natively by the expo-font config plugin (app.config.ts). */
export const fonts = {
  regular: 'DMSans-Regular',
  italic: 'DMSans-Italic',
  medium: 'DMSans-Medium',
  bold: 'DMSans-Bold',
  mono: Platform.select({ ios: 'Menlo', default: 'monospace' }) as string,
} as const;

export type FontWeightName = 'regular' | 'medium' | 'bold';

/** Type scale (T3 MOBILE_TYPOGRAPHY). */
export const typeScale = {
  micro: { fontSize: 11, lineHeight: 14 },
  caption: { fontSize: 12, lineHeight: 16 },
  label: { fontSize: 13, lineHeight: 17 },
  footnote: { fontSize: 14, lineHeight: 19 },
  body: { fontSize: 16, lineHeight: 23 },
  headline: { fontSize: 18, lineHeight: 23 },
  title: { fontSize: 21, lineHeight: 28 },
  largeTitle: { fontSize: 26, lineHeight: 32 },
  display: { fontSize: 30, lineHeight: 36 },
} as const;

export type TypeVariant = keyof typeof typeScale;

/**
 * Dynamic Type caps by role: chrome (badges, pills, timers, captions) stops at 1.3×,
 * reading text at 1.6× so long replies stay usable at accessibility sizes.
 */
export const fontScaleCap: Record<TypeVariant, number> = {
  micro: 1.3,
  caption: 1.3,
  label: 1.3,
  footnote: 1.6,
  body: 1.6,
  headline: 1.6,
  title: 1.6,
  largeTitle: 1.4,
  display: 1.4,
};

/** Monospace sizes: code blocks 13/19, tool output 12/18. */
export const codeType = { fontSize: 13, lineHeight: 19 } as const;
export const logType = { fontSize: 12, lineHeight: 18 } as const;

/** Markdown heading sizes (h1…h6); line height is size × 1.35. */
export const headingSizes = [21, 19, 17, 15, 15, 15] as const;

export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

/** T3 shape vocabulary. Use `borderCurve: 'continuous'` on everything ≥ 12. */
export const radii = {
  xs: 6,
  sm: 8,
  md: 12,
  lg: 14,
  notice: 16,
  bubble: 20,
  card: 22,
  group: 24,
  composerExpanded: 26,
  composer: 27,
  glass: 32,
  pill: 999,
} as const;

/** Durations in ms (T3 MOBILE_MOTION and friends). */
export const motion = {
  adjust: 120,
  enter: 200,
  exit: 150,
  composer: 220,
  disclosure: 180,
  detailIn: 140,
  detailOut: 120,
  fresh: 220,
  /** Items younger than this animate in; older ones (history, reconnects) do not. */
  freshWindow: 3000,
  shimmerSweep: 1350,
  shimmerPause: 1450,
  floatingIn: 180,
  floatingOut: 120,
  statusDelay: 800,
  statusFade: 250,
  waveformSample: 100,
  readingBar: 200,
  copied: 1500,
} as const;

/** Layout constants (DESIGN.md §2.4). */
export const layout = {
  feedPadding: 16,
  rowPaddingH: 20,
  rowPaddingV: 10,
  touch: 44,
  circle: 30,
  workRowMin: 28,
  workIconSlot: 24,
  toolOutputMax: 240,
  composerInset: 12,
  composerCollapsedInput: 36,
  composerExpandedMin: 140,
  composerInputMin: 72,
  composerInputMax: 160,
  floatingHeight: 44,
  /** iOS navigation bar height below the status bar (44 on every iPhone, iOS 26 included). */
  navBarHeight: 44,
  bubbleMaxWidth: '85%',
  listCellMin: 56,
  listCellMinWithDescription: 72,
} as const;

/** iOS shadows. */
export const shadows = {
  floating: (dark: boolean) => ({
    shadowColor: '#000000',
    shadowOpacity: dark ? 0.22 : 0.08,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 14 },
  }),
  composer: (dark: boolean) => ({
    shadowColor: '#000000',
    shadowOpacity: dark ? 0.35 : 0.15,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 6 },
  }),
  pill: {
    shadowColor: '#000000',
    shadowOpacity: 0.1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 4 },
  },
} as const;

/**
 * The same shadows as CSS `boxShadow` strings, for Liquid Glass surfaces: a native layer
 * shadow would be clipped by the glass view's rounded clip, a box shadow on a wrapper is not.
 */
export const glassShadows = {
  floating: (dark: boolean) => `0px 14px 28px rgba(0, 0, 0, ${dark ? 0.22 : 0.08})`,
  composer: (dark: boolean) => `0px 6px 28px rgba(0, 0, 0, ${dark ? 0.35 : 0.15})`,
  pill: (dark: boolean) => `0px 4px 12px rgba(0, 0, 0, ${dark ? 0.3 : 0.1})`,
} as const;

/** Alpha masks (only their alpha channel matters). */
export const masks = {
  /** T3 shimmer window: 0 → .12 → .55 → 1 → .55 → .12 → 0. */
  shimmer: {
    colors: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.12)', 'rgba(0,0,0,0.55)', 'rgba(0,0,0,1)', 'rgba(0,0,0,0.55)', 'rgba(0,0,0,0.12)', 'rgba(0,0,0,0)'],
    stops: [0, 0.15, 0.35, 0.5, 0.65, 0.85, 1],
  },
} as const;
