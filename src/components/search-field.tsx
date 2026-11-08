/**
 * The search field of All sessions, and its stand-in on the home screen (a button that looks like
 * the field and opens All sessions with the field focused).
 */

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View, type TextInputInstance } from 'react-native';

import { fonts, radii, typeScale, useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

const HEIGHT = 38;

/**
 * Uncontrolled (the native field owns the text), so fast typing never drops characters while the
 * list below re-renders.
 */
export const SearchField = forwardRef<
  TextInputInstance | null,
  { onChangeText: (text: string) => void; placeholder: string; autoFocus?: boolean }
>(function SearchField({ onChangeText, placeholder, autoFocus }, ref) {
  const { colors } = useTheme();
  const input = useRef<TextInputInstance>(null);
  useImperativeHandle(ref, () => input.current as TextInputInstance);
  const [hasText, setHasText] = useState(false);
  const change = (text: string) => {
    setHasText(text.length > 0);
    onChangeText(text);
  };
  const clear = () => {
    input.current?.clear();
    change('');
  };
  return (
    <View style={[styles.field, { backgroundColor: colors.surface }]}>
      <Icon name="magnifyingglass" size={15} color={colors.iconMuted} />
      <TextInput
        ref={input}
        onChangeText={change}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        clearButtonMode="never"
        selectionColor={colors.accent}
        cursorColor={colors.accent}
        accessibilityLabel={placeholder}
        maxFontSizeMultiplier={1.4}
        style={[styles.input, { color: colors.text }]}
      />
      {hasText ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10} onPress={clear}>
          <Icon name="xmark.circle.fill" size={16} color={colors.iconMuted} />
        </Pressable>
      ) : null}
    </View>
  );
});

/** Home: looks like the field, opens All sessions. */
export function SearchEntry({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="search"
      accessibilityLabel={label}
      accessibilityHint="Opens every session on every computer"
      onPress={onPress}
      style={({ pressed }) => [styles.field, { backgroundColor: pressed ? colors.surfacePressed : colors.surface }]}
    >
      <Icon name="magnifyingglass" size={15} color={colors.iconMuted} />
      <Text variant="body" tone="secondary" numberOfLines={1} style={styles.entryText}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  field: {
    height: HEIGHT,
    borderRadius: radii.md,
    borderCurve: 'continuous',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 11,
  },
  input: {
    flex: 1,
    height: HEIGHT,
    paddingVertical: 0,
    fontFamily: fonts.regular,
    fontSize: typeScale.body.fontSize,
  },
  entryText: { flex: 1 },
});
