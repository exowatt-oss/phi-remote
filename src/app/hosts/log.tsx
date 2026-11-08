/**
 * Settings › Computers › a computer › Connection log: what this iPhone's connection to the
 * computer did (attempts, failures with their reason and timing, backoff waits, network changes,
 * foreground/background), newest first, in plain monospace. Copy shares every computer's log
 * with the app version and the time.
 */

import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useSyncExternalStore } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { copyWithFeedback } from '@/components/copy';
import { hostState } from '@/components/host-state';
import { useNow } from '@/hooks/use-now';
import { TRACE_LIMIT, traceRows } from '@/lib/conn-trace';
import { connectionReport } from '@/services/connection-log';
import { connTrace, useRemote } from '@/services/remote';
import { radii, space, useTheme } from '@/theme';
import { Button, EmptyState, Text } from '@/ui';

const subscribe = (listener: () => void) => connTrace.subscribe(listener);
const version = () => connTrace.version;

export default function ConnectionLogScreen() {
  const { colors } = useTheme();
  const { hubId } = useLocalSearchParams<{ hubId: string }>();
  const id = String(hubId ?? '');
  const host = useRemote((s) => s.hosts[id]);
  const now = useNow(5_000);
  const v = useSyncExternalStore(subscribe, version);
  const rows = useMemo(() => (v >= 0 ? traceRows(connTrace.events(id)) : []), [id, v]);
  if (!host) return <EmptyState title="Not paired" detail="This computer was removed." />;
  return (
    <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <Stack.Screen
        options={{
          headerRight: () => (
            <Button compact variant="plain" title="Copy" onPress={() => copyWithFeedback(connectionReport(), 'Connection log copied')} />
          ),
        }}
      />
      <Text variant="footnote" tone="secondary">
        {`${host.name}: ${hostState(host, now).text}. Newest first, the last ${TRACE_LIMIT} events. Copy includes every computer, the app version and the time.`}
      </Text>
      <View style={[styles.card, { backgroundColor: colors.surface }]} accessibilityLabel="Connection log">
        {rows.length === 0 ? (
          <Text variant="footnote" tone="tertiary">
            Nothing yet.
          </Text>
        ) : (
          rows.map((r) => (
            <Text key={r.key} mono tone={r.day ? 'tertiary' : 'primary'} selectable style={r.day ? styles.day : undefined}>
              {r.line.replace(/(\d) (ms|s)\b/g, '$1\u00A0$2')}
            </Text>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.md, paddingBottom: space.xxxl * 2 },
  card: { borderRadius: radii.group, borderCurve: 'continuous', paddingVertical: space.md, paddingHorizontal: space.lg, gap: 2 },
  day: { marginTop: space.sm },
});
