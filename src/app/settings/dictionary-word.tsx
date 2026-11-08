/**
 * Add or edit one dictionary word: the word as it should be written, and what dictation writes
 * instead ("heard as", comma-separated). Save in the header; Remove for an existing word.
 */

import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { cleanPhrase, parseHeardAs } from '@/lib/dictionary';
import { deleteWord, saveWord, useDictionary } from '@/services/dictionary';
import { fonts, radii, space, useTheme } from '@/theme';
import { Button, ListRow, ListSection } from '@/ui';

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default function DictionaryWordScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ word?: string }>();
  const editing = first(params.word);
  const existing = useDictionary((s) => (editing ? s.file.words.find((w) => w.text === editing) : undefined));
  const [text, setText] = useState(existing?.text ?? '');
  const [heard, setHeard] = useState(existing?.heardAs.join(', ') ?? '');
  const canSave = cleanPhrase(text).length > 0;

  const save = () => {
    if (!canSave) return;
    saveWord({ text, heardAs: parseHeardAs(heard) }, existing?.text);
    router.back();
  };
  const remove = () => {
    if (existing) deleteWord(existing.text);
    router.back();
  };

  const inputStyle = [styles.input, { color: colors.text }];

  return (
    <KeyboardAwareScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      bottomOffset={space.xl}
    >
      <Stack.Screen
        options={{
          title: existing ? 'Edit word' : 'Add a word',
          headerRight: () => <Button compact variant="plain" title="Save" disabled={!canSave} onPress={save} />,
        }}
      />
      <ListSection title="Word" footer="Written exactly like this, capitals included.">
        <View style={styles.field}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Jev"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoFocus={!existing}
            returnKeyType="next"
            selectionColor={colors.accent}
            accessibilityLabel="Word"
            style={inputStyle}
          />
        </View>
      </ListSection>
      <ListSection
        title="Heard as"
        footer="What dictation writes instead, separated by commas. Each one always becomes the word, so leave out ordinary words you also mean as themselves. Near misses are fixed without being listed."
      >
        <View style={styles.field}>
          <TextInput
            value={heard}
            onChangeText={setHeard}
            placeholder="Jeff, chev"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            returnKeyType="done"
            onSubmitEditing={save}
            selectionColor={colors.accent}
            accessibilityLabel="Heard as"
            style={inputStyle}
          />
        </View>
      </ListSection>
      {existing ? (
        <ListSection>
          <ListRow label="Remove word" destructive onPress={remove} />
        </ListSection>
      ) : null}
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.xl, paddingBottom: space.xxxl * 2 },
  field: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  input: { fontFamily: fonts.regular, fontSize: 17, paddingVertical: space.sm, borderRadius: radii.md },
});
