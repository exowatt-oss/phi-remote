import { SymbolView, type AnimationSpec, type SFSymbol, type SymbolWeight } from 'expo-symbols';
import type { ColorValue, StyleProp, ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

export type IconName = SFSymbol;

/** SF Symbol, monochrome, tinted from tokens (default `icon`). */
export function Icon({
  name,
  size = 20,
  color,
  weight = 'regular',
  animationSpec,
  style,
}: {
  name: IconName;
  size?: number;
  color?: ColorValue;
  weight?: SymbolWeight;
  animationSpec?: AnimationSpec;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <SymbolView
      name={name}
      size={size}
      weight={weight}
      type="monochrome"
      tintColor={color ?? colors.icon}
      animationSpec={animationSpec}
      resizeMode="scaleAspectFit"
      style={[{ width: size, height: size }, style]}
    />
  );
}
