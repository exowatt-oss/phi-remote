/**
 * Thread defaults of an overseer started from this iPhone (Overseers, v1 addition): the threads'
 * model and thinking, whether they get a terminal window, and how many run at once. Saved as the
 * default (Prefs.overseer) the moment you pick, like the new-thread model. Sent to the overseer in
 * plain words with its first message, and with every "Add thread".
 */

import * as Haptics from 'expo-haptics';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { DEFAULT_OVERSEER, MAX_THREADS_MAX, MAX_THREADS_MIN, THREAD_MODELS, THREAD_WINDOWS, type OverseerDefaults } from '@/lib/overseer';
import { remote, useRemote } from '@/services/remote';
import { space, useTheme } from '@/theme';
import { Icon, ListRow, ListSection, Text, type IconName } from '@/ui';

export function useOverseerDefaults(): OverseerDefaults {
  return useRemote((s) => s.prefs.overseer) ?? DEFAULT_OVERSEER;
}

function save(patch: Partial<OverseerDefaults>, current: OverseerDefaults): void {
  void Haptics.selectionAsync();
  void remote.updatePrefs({ overseer: { ...current, ...patch } });
}

function StepButton({ icon, label, disabled, onPress }: { icon: IconName; label: string; disabled: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.step,
        { backgroundColor: colors.surfacePressed, opacity: disabled ? 0.4 : 1 },
        pressed && { backgroundColor: colors.border },
      ]}
    >
      <Icon name={icon} size={13} weight="semibold" color={colors.icon} />
    </Pressable>
  );
}

export function OverseerDefaultsForm({ overseerModel }: { overseerModel?: string | null }) {
  const d = useOverseerDefaults();
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <ListSection title="Thread model">
        {THREAD_MODELS.map((m) => (
          <ListRow
            key={m.key}
            label={m.label}
            description={m.key === 'same' ? (overseerModel ? overseerModel : 'The model the overseer runs') : m.ref}
            selected={d.threadModel === m.key}
            onPress={() => save({ threadModel: m.key }, d)}
          />
        ))}
      </ListSection>
      <ListSection title="Thread window">
        {THREAD_WINDOWS.map((w) => (
          <ListRow key={w.key} label={w.label} description={w.detail} selected={d.window === w.key} onPress={() => save({ window: w.key }, d)} />
        ))}
      </ListSection>
      <ListSection
        title="Threads at once"
        footer="Sent to the overseer in plain words with its first message and with each Add thread. Saved as your default."
      >
        <ListRow
          label="Up to"
          accessibilityLabel={`At most ${d.maxThreads} threads at a time`}
          accessory={
            <View style={styles.stepper} accessibilityRole="adjustable">
              <StepButton
                icon="minus"
                label="Fewer threads"
                disabled={d.maxThreads <= MAX_THREADS_MIN}
                onPress={() => save({ maxThreads: d.maxThreads - 1 }, d)}
              />
              <Text variant="body" weight="medium" numeric style={styles.count}>
                {d.maxThreads}
              </Text>
              <StepButton
                icon="plus"
                label="More threads"
                disabled={d.maxThreads >= MAX_THREADS_MAX}
                onPress={() => save({ maxThreads: d.maxThreads + 1 }, d)}
              />
            </View>
          }
        />
      </ListSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxxl * 2, gap: space.xl },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  step: { width: 32, height: 28, borderRadius: 8, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center' },
  count: { minWidth: 20, textAlign: 'center' },
});
