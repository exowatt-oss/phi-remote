import { GlassView } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { glassShadows, shadows, useGlass, useTheme } from '@/theme';

export type SurfaceGlass = 'regular' | 'clear' | 'none';

/**
 * Port of T3 GlassSurface: Liquid Glass on iOS 26+, otherwise an opaque fill with a
 * hairline border and a soft shadow so the fallback looks intentional. Only the composer,
 * the floating working pill and the scroll-to-bottom circle use it.
 */
export function Surface({
  glass = 'regular',
  radius,
  chrome = 'default',
  interactive,
  shadow = 'floating',
  style,
  children,
  ...rest
}: {
  glass?: SurfaceGlass;
  radius: number;
  chrome?: 'default' | 'none';
  interactive?: boolean;
  shadow?: 'floating' | 'composer' | 'pill' | 'none';
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
} & Omit<ViewProps, 'style'>) {
  const { colors, dark } = useTheme();
  const useGlassView = useGlass() && glass !== 'none';
  const shape: ViewStyle = { borderRadius: radius, borderCurve: 'continuous' };
  const shade =
    shadow === 'none'
      ? null
      : shadow === 'composer'
        ? shadows.composer(dark)
        : shadow === 'pill'
          ? shadows.pill
          : shadows.floating(dark);
  if (useGlassView) {
    const view = (
      <GlassView
        glassEffectStyle={glass}
        tintColor="transparent"
        isInteractive={interactive}
        colorScheme={dark ? 'dark' : 'light'}
        style={[shape, styles.clip, style]}
        {...rest}
      >
        {children}
      </GlassView>
    );
    if (shadow === 'none' || chrome === 'none') return view;
    // Glass alone all but disappears on a plain light screen; the soft shadow T3 puts under
    // its glass gives the capsule an edge. It sits on a wrapper so the glass clip keeps it.
    return (
      <View pointerEvents="box-none" style={[shape, { boxShadow: glassShadows[shadow](dark) }]}>
        {view}
      </View>
    );
  }
  return (
    <View
      style={[
        shape,
        { backgroundColor: colors.composerSurface },
        chrome === 'default' && { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.composerBorder },
        chrome === 'default' && shade,
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
});
