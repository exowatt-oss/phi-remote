/** Settings › Voice › Dictionary: one row into the dictation dictionary. */

import { router } from 'expo-router';

import { useDictionary } from '@/services/dictionary';
import { ListRow, ListSection } from '@/ui';

export function DictionarySection() {
  const mine = useDictionary((s) => s.file.words.length);
  const commands = useDictionary((s) => s.dict.counts.command);
  const models = useDictionary((s) => s.dict.counts.model);
  const parts: string[] = [];
  if (mine > 0) parts.push(mine === 1 ? '1 of your words' : `${mine} of your words`);
  if (commands > 0) parts.push(`${commands} skills and commands`);
  if (models > 0) parts.push(`${models} models`);
  if (!parts.length) parts.push('phi and ExampleCo names');
  return (
    <ListSection title="Dictionary" footer="Names, skills, models, computers and folders dictation should get right.">
      <ListRow label="Dictionary" description={parts.join(' · ')} chevron onPress={() => router.push('/settings/dictionary')} />
    </ListSection>
  );
}
