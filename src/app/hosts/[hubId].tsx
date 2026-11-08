/** One computer: where it is reached, its phi version, its connection log, reconnect and remove. */

import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Alert, ScrollView, StyleSheet } from 'react-native';

import { hostState } from '@/components/host-state';
import { useNow } from '@/hooks/use-now';
import { displayHost } from '@/lib/pairing';
import { isThread } from '@/lib/store';
import { remote, useRemote } from '@/services/remote';
import { space } from '@/theme';
import { EmptyState, ListRow, ListSection, StatusDot } from '@/ui';

export default function HostDetail() {
  const { hubId } = useLocalSearchParams<{ hubId: string }>();
  const id = String(hubId ?? '');
  const host = useRemote((s) => s.hosts[id]);
  const count = useRemote((s) => Object.values(s.sessions[id] ?? {}).filter(isThread).length);
  const now = useNow();
  if (!host) return <EmptyState title="Not paired" detail="This computer was removed." />;
  const st = hostState(host, now);
  const remove = () =>
    Alert.alert(`Remove ${host.name}?`, 'Its threads disappear from this iPhone. Pair again any time with phi remote pair.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          void remote.removeHost(id);
          router.back();
        },
      },
    ]);
  return (
    <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <Stack.Screen options={{ title: host.name }} />
      <ListSection>
        <ListRow label="Status" detail={st.text} accessory={<StatusDot state={st.dot} />} />
        <ListRow label="Threads" detail={String(count)} />
        {host.conn.hubVersion ? <ListRow label="phi remote" detail={host.conn.hubVersion} /> : null}
      </ListSection>
      <ListSection title="Addresses" footer="Tried in this order; the last one that worked goes first.">
        {host.urls.map((u) => (
          <ListRow key={u} label={displayHost(u)} selected={u === host.preferredUrl} />
        ))}
      </ListSection>
      <ListSection footer="Every attempt, failure and reconnect on this iPhone, newest first.">
        <ListRow label="Connection log" chevron onPress={() => router.push({ pathname: '/hosts/log', params: { hubId: id } })} />
      </ListSection>
      <ListSection>
        {host.conn.status === 'unauthorized' ? (
          <ListRow
            label="Pair again"
            onPress={() => router.push({ pathname: '/hosts/pair', params: { url: host.preferredUrl, name: host.name } })}
          />
        ) : (
          <ListRow label="Reconnect" onPress={() => remote.retryHost(id)} />
        )}
        <ListRow label="Remove computer" destructive onPress={remove} />
      </ListSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.xl, paddingBottom: space.xxxl * 2 },
});
