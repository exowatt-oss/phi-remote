/**
 * All sessions (Session history, v1 addition): every session on every paired computer in one
 * list, newest first, in date sections. Search filters the phone's copy as you type and asks each
 * computer too; a computer filter narrows it to one machine. Rows of a computer that is offline
 * stay readable from the phone's copy. Tapping a row opens the session (live ones as the live
 * thread); a stored one can be resumed from there.
 */

import { LegendList } from '@legendapp/list/react-native';
import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Pressable, StyleSheet, View, type TextInputInstance } from 'react-native';

import { copyWithFeedback } from '@/components/copy';
import { PastSessionRow } from '@/components/past-session-row';
import { SearchField } from '@/components/search-field';
import { useNow } from '@/hooks/use-now';
import { machineSymbol, sessionHref, shortCwd } from '@/lib/format';
import { historyView, nestHistory, queryWords, sectionize, UPDATE_COMMAND, type HistoryHost, type HistoryRow, type SectionedRow } from '@/lib/history';
import { toggleThreadsFolded, useFolds } from '@/services/overseer';
import { remote, useRemote } from '@/services/remote';
import { radii, space, useTheme } from '@/theme';
import { EmptyState, Icon, Notice, Text } from '@/ui';

type Row = SectionedRow | { type: 'notice'; key: string; tone: 'neutral' | 'danger'; icon?: 'wifi.slash'; message: string; action?: { title: string; onPress: () => void } };

function SectionHeader({ title }: { title: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.section} accessible accessibilityRole="header" accessibilityLabel={title}>
      <Text variant="label" weight="medium" tone="tertiary" numberOfLines={1}>
        {title}
      </Text>
      <View style={[styles.rule, { backgroundColor: colors.border }]} />
    </View>
  );
}

function Chip({ label, icon, selected, onPress }: { label: string; icon?: Parameters<typeof Icon>[0]['name']; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const fg = selected ? colors.bg : colors.textSecondary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: selected ? colors.text : pressed ? colors.surfacePressed : colors.surface },
      ]}
    >
      {icon ? <Icon name={icon} size={12} color={fg} /> : null}
      <Text variant="label" weight="medium" numberOfLines={1} style={[styles.chipText, { color: fg }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Unreachable for now (not merely reconnecting or paused in the background). */
function isOffline(status: string): boolean {
  return status === 'offline' || status === 'unauthorized' || status === 'incompatible';
}

function rowActions(row: HistoryRow): void {
  if (!row.session.cwd) return;
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  const options = ['Copy folder', 'Cancel'];
  ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: 1, title: shortCwd(row.session.cwd) }, (i) => {
    if (i === 0) copyWithFeedback(row.session.cwd);
  });
}

export default function AllSessionsScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ focus?: string }>();
  const now = useNow();
  const hostOrder = useRemote((s) => s.hostOrder);
  const hosts = useRemote((s) => s.hosts);
  const history = useRemote((s) => s.history);
  const live = useRemote((s) => s.sessions);
  const search = useRemote((s) => s.search);
  const historyReady = useRemote((s) => s.historyReady);
  const [typed, setTyped] = useState('');
  // The list follows the field a beat behind, so typing stays smooth on a long list.
  const query = useDeferredValue(typed);
  const [hubFilter, setHubFilter] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const inputRef = useRef<TextInputInstance>(null);

  useEffect(() => () => remote.search(''), []);
  // A computer that was removed while it was the filter.
  const filter = hubFilter && hosts[hubFilter] ? hubFilter : null;

  const historyHosts = useMemo<HistoryHost[]>(
    () =>
      hostOrder
        .filter((id) => hosts[id])
        .map((id) => ({ hubId: id, name: hosts[id].name, connected: hosts[id].conn.status === 'live', offline: isOffline(hosts[id].conn.status) })),
    [hostOrder, hosts],
  );
  const view = useMemo(
    () => historyView({ hosts: historyHosts, history, live, hubId: filter, query, search }),
    [historyHosts, history, live, filter, query, search],
  );
  const searching = queryWords(query).length > 0;
  const showHost = historyHosts.length > 1 && !filter;

  const notices = useMemo(() => {
    const out: Row[] = [];
    for (const h of historyHosts) {
      if (filter && h.hubId !== filter) continue;
      const host = hosts[h.hubId];
      const hist = history[h.hubId];
      const supported = host.features ? host.features.includes('history') : hist?.support === 'history';
      if (host.features && !supported) {
        out.push({
          type: 'notice',
          key: `n:old:${h.hubId}`,
          tone: 'neutral',
          message: `Update phi on ${h.name} to see its past sessions.`,
          action: { title: 'Copy command', onPress: () => copyWithFeedback(UPDATE_COMMAND, 'Command copied') },
        });
      } else if (h.offline) {
        const cached = (hist?.order.length ?? 0) > 0;
        out.push({
          type: 'notice',
          key: `n:off:${h.hubId}`,
          tone: 'neutral',
          icon: 'wifi.slash',
          message: cached ? `${h.name} is offline. Its sessions below are the copy on this iPhone.` : `${h.name} is offline.`,
        });
      } else if (h.connected && hist?.error) {
        out.push({
          type: 'notice',
          key: `n:err:${h.hubId}`,
          tone: 'danger',
          message: `Could not load sessions from ${h.name}.`,
          action: { title: 'Retry', onPress: () => void remote.refreshPast(h.hubId) },
        });
      }
    }
    return out;
  }, [historyHosts, hosts, history, filter]);

  // Overseers (v1 addition): threads under their overseer, folded until opened.
  const folds = useFolds();
  const rows = useMemo<Row[]>(
    () => [...notices, ...sectionize(nestHistory(view.rows, (key) => folds[key] ?? true), now)],
    [notices, view.rows, now, folds],
  );

  const onEndReached = useCallback(() => {
    if (view.loadMore.length === 0) return;
    if (searching) void remote.loadMoreSearch(view.loadMore);
    else void remote.loadMorePast(view.loadMore);
  }, [view.loadMore, searching]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await remote.refresh();
    } finally {
      setRefreshing(false);
    }
  }, []);

  const onChangeQuery = useCallback((text: string) => {
    setTyped(text);
    remote.search(text);
  }, []);

  const renderItem = ({ item }: { item: Row }) => {
    switch (item.type) {
      case 'notice':
        return <Notice card message={item.message} tone={item.tone} icon={item.icon} action={item.action} announce={false} style={styles.notice} />;
      case 'section':
        return <SectionHeader title={item.title} />;
      case 'row':
        return (
          <PastSessionRow
            row={item.row}
            now={now}
            showHost={showHost}
            nest={item.nest}
            onToggleFold={(key) => toggleThreadsFolded(key, true)}
            first={item.first}
            onPress={() => router.push(sessionHref(item.row.hubId, item.row.session.sessionId))}
            onLongPress={() => rowActions(item.row)}
          />
        );
    }
  };

  const loadingFirst = view.rows.length === 0 && (view.loading || !historyReady);
  let empty = null;
  if (loadingFirst) {
    empty = (
      <View style={styles.center}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    );
  } else if (view.rows.length === 0) {
    empty = searching ? (
      <EmptyState title="No matches" detail={`No session matches \u201c${query.trim()}\u201d${filter ? ` on ${hosts[filter]?.name}` : ''}.`} />
    ) : (
      <EmptyState title="No sessions yet" detail="Sessions you run with phi on your computers show up here." />
    );
  }

  const header = (
    <View style={styles.header}>
      <SearchField ref={inputRef} onChangeText={onChangeQuery} placeholder="Search all sessions" autoFocus={params.focus === '1'} />
      {historyHosts.length > 1 ? (
        <View style={styles.chips}>
          <Chip label="All computers" selected={!filter} onPress={() => setHubFilter(null)} />
          {historyHosts.map((h) => (
            <Chip
              key={h.hubId}
              label={h.name}
              icon={h.connected ? machineSymbol(h.name) : 'wifi.slash'}
              selected={filter === h.hubId}
              onPress={() => setHubFilter((cur) => (cur === h.hubId ? null : h.hubId))}
            />
          ))}
        </View>
      ) : null}
    </View>
  );

  const loadingMore = view.rows.length > 0 && (view.loading || view.loadMore.some((id) => (searching ? search?.hubs[id]?.loading : history[id]?.loading)));

  return (
    <>
      <Stack.Screen options={{ title: 'All sessions' }} />
      <LegendList
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.type}
        renderItem={renderItem}
        extraData={now}
        estimatedItemSize={76}
        recycleItems={false}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onRefresh={onRefresh}
        refreshing={refreshing}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.6}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={
          <View style={styles.footer}>{loadingMore ? <ActivityIndicator color={colors.textSecondary} /> : null}</View>
        }
        style={{ backgroundColor: colors.bg }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xs, gap: space.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    height: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    maxWidth: '100%',
  },
  chipText: { flexShrink: 1 },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: space.lg,
    marginBottom: 6,
    paddingHorizontal: 20,
  },
  rule: { flex: 1, height: 1 },
  notice: { marginHorizontal: space.lg, marginTop: space.sm },
  center: { alignItems: 'center', paddingTop: 80 },
  footer: { minHeight: space.xxxl * 2, alignItems: 'center', justifyContent: 'center' },
});
