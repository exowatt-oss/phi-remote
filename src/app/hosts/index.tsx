/** Computers: paired hosts with their state, and how to add one. */

import { router } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';

import { useNow } from '@/hooks/use-now';
import { hostState } from '@/components/host-state';
import { machineSymbol } from '@/lib/format';
import { useRemote } from '@/services/remote';
import { space } from '@/theme';
import { ListRow, ListSection, StatusDot } from '@/ui';

export default function HostsScreen() {
  const now = useNow();
  const hostOrder = useRemote((s) => s.hostOrder);
  const hosts = useRemote((s) => s.hosts);
  return (
    <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      {hostOrder.length > 0 ? (
        <ListSection inset>
          {hostOrder.map((id) => {
            const h = hosts[id];
            const st = hostState(h, now);
            // Keep the right-hand detail to one short word; the longer "Seen 4m ago" goes
            // under the name instead of being truncated mid-phrase.
            const [status, since] = st.text.split(' · ');
            return (
              <ListRow
                key={id}
                icon={machineSymbol(h.name)}
                label={h.name}
                description={since ? since.charAt(0).toUpperCase() + since.slice(1) : undefined}
                detail={status}
                accessory={<StatusDot state={st.dot} />}
                chevron
                onPress={() => router.push({ pathname: '/hosts/[hubId]', params: { hubId: id } })}
              />
            );
          })}
        </ListSection>
      ) : null}
      <ListSection title="Add a computer" inset footer="Run phi remote pair on the computer.">
        <ListRow icon="qrcode.viewfinder" label="Scan pairing code" chevron onPress={() => router.push('/hosts/pair')} />
        <ListRow
          icon="keyboard"
          label="Enter code"
          chevron
          onPress={() => router.push({ pathname: '/hosts/pair', params: { mode: 'manual' } })}
        />
      </ListSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.xl, paddingBottom: space.xxxl * 2 },
});
