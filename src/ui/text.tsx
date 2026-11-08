import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';

import {
  fontScaleCap,
  fonts,
  logType,
  typeScale,
  useTheme,
  type FontWeightName,
  type Palette,
  type TypeVariant,
} from '@/theme';

export type Tone = 'primary' | 'secondary' | 'tertiary' | 'accent' | 'danger' | 'success' | 'warning' | 'onAccent';

const TONE: Record<Tone, keyof Palette> = {
  primary: 'text',
  secondary: 'textSecondary',
  tertiary: 'textTertiary',
  accent: 'accent',
  danger: 'danger',
  success: 'success',
  warning: 'warning',
  onAccent: 'onAccent',
};

export type TextProps = RNTextProps & {
  variant?: TypeVariant;
  weight?: FontWeightName;
  tone?: Tone;
  /** Menlo at the tool-output size (12/18). */
  mono?: boolean;
  /**
   * System font with tabular figures, for numbers that tick (timers, times). DM Sans has
   * no tabular figures.
   */
  numeric?: boolean;
  align?: TextStyle['textAlign'];
};

const SYSTEM_WEIGHT: Record<FontWeightName, TextStyle['fontWeight']> = { regular: '400', medium: '500', bold: '700' };

/** All app text: T3 type roles, DM Sans faces by family (never fontWeight), role-based Dynamic Type caps. */
export function Text({
  variant = 'body',
  weight = 'regular',
  tone = 'primary',
  mono,
  numeric,
  align,
  style,
  maxFontSizeMultiplier,
  ...rest
}: TextProps) {
  const { colors } = useTheme();
  const scale = mono ? logType : typeScale[variant];
  const face: TextStyle = mono
    ? { fontFamily: fonts.mono }
    : numeric
      ? { fontWeight: SYSTEM_WEIGHT[weight], fontVariant: ['tabular-nums'] }
      : { fontFamily: fonts[weight] };
  return (
    <RNText
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? (mono ? 1.6 : fontScaleCap[variant])}
      style={[scale, face, { color: colors[TONE[tone]], textAlign: align }, style]}
      {...rest}
    />
  );
}
