/**
 * Settings › Voice › Dictionary: the words dictation should get right. Your own words first (each
 * with how dictation mishears it), then what it knows already: the built-in phi and ExampleCo names
 * and, from your computers, their skills and commands, models, names and folders.
 */

import { router } from 'expo-router';
import { useEffect } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { refreshAllHubVocabulary, useDictionary, type DictionaryListKind } from '@/services/dictionary';
import { space, useTheme } from '@/theme';
import { ListRow, ListSection } from '@/ui';

const KNOWN: { kind: DictionaryListKind; label: string }[] = [
  { kind: 'seed', label: 'phi and ExampleCo names' },
  { kind: 'command', label: 'Skills and commands' },
  { kind: 'model', label: 'Models' },
  { kind: 'host', label: 'Computers' },
  { kind: 'folder', label: 'Folders' },
];

export default function DictionaryScreen() {
  const { colors } = useTheme();
  const words = useDictionary((s) => s.file.words);
  const counts = useDictionary((s) => s.dict.counts);

  // Opening the dictionary asks every connected computer for its latest skills, models and folders.
  useEffect(() => refreshAllHubVocabulary(), []);

  return (
    <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <ListSection
        title="Your words"
        footer={'Dictation knows these words and fixes near misses ("exampleco" becomes ExampleCo). Say "slash" and a skill\'s name to write the command: "slash jev mobile" becomes /jev-mobile.'}
      >
        {words.map((w) => (
          <ListRow
            key={w.text}
            label={w.text}
            description={w.heardAs.length ? `Heard as ${w.heardAs.join(', ')}` : undefined}
            chevron
            onPress={() => router.push({ pathname: '/settings/dictionary-word', params: { word: w.text } })}
          />
        ))}
        <ListRow
          icon="plus"
          iconColor={colors.accent}
          label="Add a word"
          onPress={() => router.push('/settings/dictionary-word')}
        />
      </ListSection>

      <ListSection title="Already known" footer="Learned from your computers when they connect, and kept on this iPhone for when they are offline.">
        {KNOWN.map(({ kind, label }) => (
          <ListRow
            key={kind}
            label={label}
            detail={String(counts[kind])}
            chevron={counts[kind] > 0}
            onPress={counts[kind] > 0 ? () => router.push({ pathname: '/settings/dictionary-list', params: { kind } }) : undefined}
          />
        ))}
      </ListSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.xl, paddingBottom: space.xxxl * 2 },
});
