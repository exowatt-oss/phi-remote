/** The words the dictionary already knows from one source (built-in names, or your computers'). */

import { Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';

import { SEED, type HubVocabulary } from '@/lib/dictionary';
import { useDictionary, type DictionaryListKind } from '@/services/dictionary';
import { space } from '@/theme';
import { ListRow, ListSection } from '@/ui';

const TITLES: Record<DictionaryListKind, string> = {
  seed: 'phi and ExampleCo names',
  command: 'Skills and commands',
  model: 'Models',
  host: 'Computers',
  folder: 'Folders',
};

type Row = { label: string; description?: string };

function rows(kind: DictionaryListKind, hubs: HubVocabulary[]): Row[] {
  const unique = (items: string[]) => [...new Set(items)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  switch (kind) {
    case 'seed':
      return SEED.map((s) => ({ label: s.text, description: s.heardAs?.length ? `Heard as ${s.heardAs.join(', ')}` : undefined }));
    case 'command':
      return unique(hubs.flatMap((h) => h.commands.map((c) => `/${c.name.replace(/^skill:/, '')}`))).map((label) => ({ label }));
    case 'model':
      return unique(hubs.flatMap((h) => h.models)).map((label) => ({ label }));
    case 'host':
      return unique(hubs.map((h) => h.name).filter(Boolean)).map((label) => ({ label }));
    case 'folder':
      return unique(hubs.flatMap((h) => h.folders)).map((label) => ({ label }));
  }
}

export default function DictionaryListScreen() {
  const params = useLocalSearchParams<{ kind?: string }>();
  const kind = (Object.keys(TITLES).includes(String(params.kind)) ? params.kind : 'seed') as DictionaryListKind;
  const hubs = useDictionary((s) => s.file.hubs);
  const list = rows(kind, Object.values(hubs));

  return (
    <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <Stack.Screen options={{ title: TITLES[kind] }} />
      <ListSection>
        {list.map((r) => (
          <ListRow key={r.label} label={r.label} description={r.description} />
        ))}
      </ListSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.xl, paddingBottom: space.xxxl * 2 },
});
