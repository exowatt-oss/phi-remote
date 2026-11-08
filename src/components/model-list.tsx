/** Models grouped by provider, plus optional effort (thinking level) chips. Shared by the thread and new-thread sheets. */

import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { ModelInfo } from '@/lib/protocol';
import { radii, space, useTheme } from '@/theme';
import { ListRow, ListSection, Text } from '@/ui';

export const modelKey = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

export function ModelList({
  models,
  selected,
  pending,
  onChoose,
  thinking,
  error,
  header,
}: {
  models: ModelInfo[] | null;
  selected: string | null;
  pending?: string | null;
  onChoose: (m: ModelInfo | null) => void;
  thinking?: { levels: string[]; current?: string; onChoose: (level: string) => void } | null;
  error?: string | null;
  /** Rows above the providers (e.g. "Default"), with an optional footnote under them. */
  header?: { label: string; description?: string; selected: boolean; onPress: () => void; footer?: string } | null;
}) {
  const { colors } = useTheme();
  if (error && !models) {
    return (
      <Text variant="footnote" tone="secondary" style={styles.message}>
        {error}
      </Text>
    );
  }
  if (!models) return <ActivityIndicator style={styles.loading} color={colors.textSecondary} />;
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
  return (
    <ScrollView contentContainerStyle={styles.content}>
      {error ? (
        <Text variant="footnote" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      {thinking && thinking.levels.length > 0 ? (
        <View style={styles.thinking}>
          <Text variant="footnote" weight="medium" tone="secondary" style={styles.title}>
            Effort
          </Text>
          <View style={styles.levels} accessibilityRole="radiogroup" accessibilityLabel="Effort">
            {thinking.levels.map((level) => {
              const on = level === thinking.current;
              return (
                <Pressable
                  key={level}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  onPress={() => thinking.onChoose(level)}
                  style={({ pressed }) => [
                    styles.level,
                    { backgroundColor: on ? colors.accentSoft : colors.surface },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text variant="label" weight="medium" tone={on ? 'accent' : 'primary'}>
                    {level}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
      {header ? (
        <ListSection footer={header.footer}>
          <ListRow label={header.label} description={header.description} selected={header.selected} onPress={header.onPress} />
        </ListSection>
      ) : null}
      {[...byProvider.entries()].map(([provider, list]) => (
        <ListSection key={provider} title={provider}>
          {list.map((m) => {
            const k = modelKey(m);
            return (
              <ListRow
                key={k}
                label={m.name}
                description={m.name !== m.id ? m.id : undefined}
                selected={k === selected && pending !== k}
                accessory={pending === k ? <ActivityIndicator size="small" color={colors.iconMuted} /> : null}
                onPress={() => onChoose(m)}
              />
            );
          })}
        </ListSection>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg, paddingBottom: space.xxxl * 2, gap: space.xl },
  loading: { marginTop: space.xxxl },
  message: { padding: space.xl },
  thinking: { gap: space.sm },
  title: { paddingHorizontal: space.sm },
  levels: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  level: { paddingHorizontal: 14, paddingVertical: space.sm, borderRadius: radii.pill },
});
