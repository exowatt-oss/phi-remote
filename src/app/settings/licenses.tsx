/**
 * THIRD_PARTY_NOTICES.md, as shipped, laid out for reading: one section per notice, the
 * license text reflowed to the screen (it is hard-wrapped at 80 columns in the file), and
 * the runtime packages as a list. Nothing scrolls sideways.
 */

import { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { THIRD_PARTY_NOTICES } from '@/generated/third-party-notices';
import { radii, space, useTheme } from '@/theme';
import { ListRow, ListSection, Text } from '@/ui';

type Block =
  | { kind: 'prose'; text: string }
  | { kind: 'license'; text: string }
  | { kind: 'packages'; items: { name: string; version: string; license: string }[] };
type Section = { title: string; blocks: Block[] };

/** Joins hard-wrapped lines; short lines (titles, URLs, copyright lines) keep their break. */
function reflow(lines: string[]): string {
  const paragraphs: string[] = [];
  let current = '';
  let prevLong = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^-{5,}$/.test(line.trim())) continue;
    if (!line.trim()) {
      if (current) paragraphs.push(current);
      current = '';
      prevLong = false;
      continue;
    }
    current = current ? `${current}${prevLong ? ' ' : '\n'}${line.trim()}` : line.trim();
    prevLong = line.length >= 60;
  }
  if (current) paragraphs.push(current);
  return paragraphs.join('\n\n');
}

function parseNotices(md: string): Section[] {
  const sections: Section[] = [];
  let section: Section | null = null;
  let fence: string[] | null = null;
  let prose: string[] = [];
  const flushProse = () => {
    const text = prose.join(' ').trim();
    if (text && section) section.blocks.push({ kind: 'prose', text });
    prose = [];
  };
  for (const line of md.split('\n')) {
    if (fence) {
      if (/^```/.test(line)) {
        section?.blocks.push({ kind: 'license', text: reflow(fence) });
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (/^##\s+/.test(line)) {
      flushProse();
      section = { title: line.replace(/^##\s+/, '').trim(), blocks: [] };
      sections.push(section);
    } else if (/^```/.test(line)) {
      flushProse();
      fence = [];
    } else if (/^-\s+/.test(line) && section) {
      flushProse();
      const m = /^-\s+(\S+)\s+(\S+)\s+—\s+(.+)$/.exec(line);
      const item = m ? { name: m[1], version: m[2], license: m[3] } : { name: line.replace(/^-\s+/, ''), version: '', license: '' };
      const last = section.blocks[section.blocks.length - 1];
      if (last?.kind === 'packages') last.items.push(item);
      else section.blocks.push({ kind: 'packages', items: [item] });
    } else if (/^#\s+/.test(line)) {
      continue;
    } else if (!line.trim()) {
      flushProse();
    } else {
      prose.push(line.trim());
    }
  }
  flushProse();
  return sections;
}

export default function LicensesScreen() {
  const { colors } = useTheme();
  const sections = useMemo(() => parseNotices(THIRD_PARTY_NOTICES), []);
  return (
    <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      {sections.map((s) => (
        <View key={s.title} style={styles.section}>
          <Text variant="headline" weight="bold" accessibilityRole="header">
            {s.title}
          </Text>
          {s.blocks.map((b, i) =>
            b.kind === 'prose' ? (
              <Text key={i} variant="footnote" tone="secondary">
                {b.text}
              </Text>
            ) : b.kind === 'license' ? (
              <View key={i} style={[styles.license, { backgroundColor: colors.surface }]}>
                <Text variant="caption" tone="secondary" selectable>
                  {b.text}
                </Text>
              </View>
            ) : (
              <ListSection key={i}>
                {b.items.map((p) => (
                  <ListRow key={p.name} label={p.name} description={p.version || undefined} detail={p.license || undefined} />
                ))}
              </ListSection>
            ),
          )}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: space.xxxl * 2, gap: space.xxl },
  section: { gap: space.md },
  license: { borderRadius: radii.group, borderCurve: 'continuous', padding: space.lg },
});
