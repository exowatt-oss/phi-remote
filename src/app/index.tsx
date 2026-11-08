/**
 * Threads (home): every phi session on every paired computer, in sections by project
 * folder (host + cwd). Compose and computers live in the bottom toolbar; settings in the
 * header.
 *
 * Overseers (v1 addition): an overseer's threads sit under it, indented, wherever their folder
 * is, and fold away from its summary line; they are not rows of their own.
 */

import { LegendList } from '@legendapp/list/react-native';
import * as Haptics from 'expo-haptics';
import { router, Stack } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, Pressable, StyleSheet, View } from 'react-native';

import { copyWithFeedback } from '@/components/copy';
import { HomeTitle } from '@/components/home-header';
import { BoardRow } from '@/components/overseer/board-row';
import { NestedFrame } from '@/components/overseer/nesting';
import { PastSessionRow } from '@/components/past-session-row';
import { SearchEntry } from '@/components/search-field';
import { ThreadRow } from '@/components/thread-row';
import { useDelayed } from '@/hooks/use-delayed';
import { useNow } from '@/hooks/use-now';
import { describeError } from '@/lib/client';
import { machineSymbol, sessionHref } from '@/lib/format';
import { historyView, nestHistory, type HistoryRow, type RowNest } from '@/lib/history';
import { countLive, countSegments, isOverseerSession, threadFromSummary, threadOfCaption, type BoardThread, type CountSegment } from '@/lib/overseer';
import type { SessionSummary, SubagentCounts } from '@/lib/protocol';
import { countsByParent, tmuxAttachCommand } from '@/lib/subagents';
import { groupByProject, reachOf, UNREACHABLE_LINE, type HostView, type ProjectGroup } from '@/lib/store';
import { toggleThreadsFolded, useFolds } from '@/services/overseer';
import { remote, useRemote } from '@/services/remote';
import { motion, radii, space, useTheme } from '@/theme';
import { Button, EmptyState, Icon, Notice, PhiMark, Text } from '@/ui';

type HomeRow =
  | { type: 'notice'; key: string; host: HostView }
  | { type: 'section'; key: string; group: ProjectGroup; showHost: boolean; offline: boolean }
  | {
      type: 'row';
      key: string;
      session: SessionSummary;
      hubId: string;
      offline: boolean;
      connecting: boolean;
      first: boolean;
      subagents?: SubagentCounts;
      overseer?: { segments: CountSegment[]; folded: boolean; foldKey: string | null };
      caption?: string | null;
    }
  | { type: 'thread'; key: string; thread: BoardThread; hubId: string; offline: boolean; first: boolean; last: boolean }
  | { type: 'past-section'; key: string }
  | { type: 'past'; key: string; row: HistoryRow; first: boolean; nest?: RowNest }
  | { type: 'all'; key: string };

/** Stored sessions shown under the live threads (the rest are one tap away in All sessions). */
const PAST_ON_HOME = 3;

function PastHeader() {
  const { colors } = useTheme();
  return (
    <View style={styles.section} accessible accessibilityRole="header" accessibilityLabel="Past sessions">
      <Text variant="label" weight="medium" tone="tertiary" numberOfLines={1} style={styles.sectionLabel}>
        Past sessions
      </Text>
      <View style={[styles.rule, { backgroundColor: colors.border }]} />
    </View>
  );
}

function AllSessionsRow() {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="All sessions"
      accessibilityHint="Every session on every computer, with search"
      onPress={() => router.push('/sessions')}
      style={({ pressed }) => [styles.allRow, pressed && { backgroundColor: colors.rowPressed }]}
    >
      <View style={[styles.divider, { backgroundColor: colors.separator }]} />
      <Icon name="clock.arrow.circlepath" size={17} color={colors.iconMuted} />
      <Text variant="body" weight="medium" style={styles.allLabel}>
        All sessions
      </Text>
      <Icon name="chevron.right" size={13} color={colors.chevron} />
    </Pressable>
  );
}

function SectionHeader({ group, showHost, offline }: { group: ProjectGroup; showHost: boolean; offline: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={styles.section}
      accessible
      accessibilityRole="header"
      accessibilityLabel={`${group.title}${showHost ? ` on ${group.hostName}` : ''}, ${group.sessions.length} thread${group.sessions.length === 1 ? '' : 's'}`}
    >
      <Text variant="label" weight="medium" tone="tertiary" numberOfLines={1} style={styles.sectionLabel}>
        {group.title}
      </Text>
      {showHost ? (
        <Pressable onPress={() => router.push('/hosts')} hitSlop={8} style={[styles.badge, { backgroundColor: colors.surface }]}>
          <Icon name={offline ? 'wifi.slash' : machineSymbol(group.hostName)} size={10} color={colors.iconMuted} />
          <Text variant="micro" weight="medium" tone={offline ? 'tertiary' : 'secondary'} numberOfLines={1}>
            {group.hostName}
          </Text>
        </Pressable>
      ) : null}
      <View style={[styles.rule, { backgroundColor: colors.border }]} />
    </View>
  );
}

function threadActions(hubId: string, s: SessionSummary): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  const headless = s.kind === 'headless';
  const tmux = s.tmux;
  const options = ['Copy directory', ...(tmux ? ['Copy tmux attach command'] : []), ...(headless ? ['Close session'] : []), 'Cancel'];
  ActionSheetIOS.showActionSheetWithOptions(
    {
      options,
      cancelButtonIndex: options.length - 1,
      destructiveButtonIndex: headless ? options.indexOf('Close session') : undefined,
    },
    (i) => {
      if (options[i] === 'Copy directory') copyWithFeedback(s.cwd);
      if (options[i] === 'Copy tmux attach command' && tmux) copyWithFeedback(tmuxAttachCommand(tmux));
      if (options[i] === 'Close session') {
        remote.closeSession(hubId, s.sessionId).catch((err) => Alert.alert('Could not close the session', describeError(err)));
      }
    },
  );
}

function TerminalNotice({ host }: { host: HostView }) {
  const revoked = host.conn.status === 'unauthorized';
  return (
    <Notice
      card
      tone="danger"
      message={revoked ? `Pairing with ${host.name} expired. Pair again.` : `Update phi on ${host.name}.`}
      action={
        revoked
          ? { title: 'Pair', onPress: () => router.push({ pathname: '/hosts/pair', params: { url: host.preferredUrl, name: host.name } }) }
          : undefined
      }
      style={styles.notice}
    />
  );
}

export default function ThreadsScreen() {
  const { colors } = useTheme();
  const now = useNow();
  const hostOrder = useRemote((s) => s.hostOrder);
  const hosts = useRemote((s) => s.hosts);
  const sessions = useRemote((s) => s.sessions);
  const sessionsLoaded = useRemote((s) => s.sessionsLoaded);
  const history = useRemote((s) => s.history);
  const folds = useFolds();
  const [refreshing, setRefreshing] = useState(false);

  const hostList = useMemo(() => hostOrder.map((id) => hosts[id]).filter(Boolean), [hostOrder, hosts]);
  const groups = useMemo(() => groupByProject({ hostOrder, hosts, sessions }), [hostOrder, hosts, sessions]);
  const paired = hostList.length > 0;
  const anyLoaded = hostOrder.some((id) => sessionsLoaded[id]);
  const terminal = hostList.filter((h) => h.conn.status === 'unauthorized' || h.conn.status === 'incompatible');
  // Every computer failed its first attempts at once: one quiet line, the cached list stays.
  const reach = reachOf(hostList);
  const { allUnreachable } = reach;
  // The toolbar warns only about computers that are offline, not ones still connecting.
  const offlineCount = reach.offline.length;
  const showConnecting = useDelayed(paired && !anyLoaded && !allUnreachable, motion.statusDelay);
  // The newest stored sessions that are not running (running ones are the threads above).
  const pastRows = useMemo(() => {
    const historyHosts = hostList.map((h) => ({
      hubId: h.hubId,
      name: h.name,
      connected: h.conn.status === 'live',
      offline: h.conn.status === 'offline' || h.conn.status === 'unauthorized' || h.conn.status === 'incompatible',
    }));
    const view = historyView({ hosts: historyHosts, history, live: sessions, hubId: null, query: '', search: null });
    // An overseer's threads sit under it (folded until opened), so they never crowd it out.
    const nested = nestHistory(
      view.rows.filter((r) => !r.running),
      (key) => folds[key] ?? true,
    );
    const out: typeof nested = [];
    let top = 0;
    for (const item of nested) {
      if (!item.nest?.nested && ++top > PAST_ON_HOME) break;
      out.push(item);
    }
    return out;
  }, [hostList, history, sessions, folds]);

  const rows = useMemo(() => {
    const out: HomeRow[] = terminal.map((host) => ({ type: 'notice', key: `n:${host.hubId}`, host }));
    const showHost = hostList.length > 1;
    const counts = new Map<string, Map<string, SubagentCounts>>();
    const countsFor = (hubId: string) => {
      let c = counts.get(hubId);
      if (!c) counts.set(hubId, (c = countsByParent(sessions[hubId])));
      return c;
    };
    for (const group of groups) {
      // Offline only once the first attempts failed; reconnecting rows read as usual.
      const status = hosts[group.hubId]?.conn.status;
      const offline = status === 'offline' || status === 'unauthorized' || status === 'incompatible';
      const connecting = !offline && status !== 'live';
      out.push({ type: 'section', key: `s:${group.key}`, group, showHost, offline });
      const subagents = countsFor(group.hubId);
      group.sessions.forEach((session, i) => {
        const threads = group.threads[session.sessionId] ?? [];
        const isOverseer = isOverseerSession(session, threads.length);
        const counts = session.threadCounts ?? countLive(threads);
        const foldKey = threads.length > 0 ? `l:${group.hubId}:${session.sessionId}` : null;
        const folded = foldKey ? (folds[foldKey] ?? false) : false;
        out.push({
          type: 'row',
          key: `r:${group.hubId}:${session.sessionId}`,
          session,
          hubId: group.hubId,
          offline,
          connecting,
          first: i === 0,
          subagents: subagents.get(session.sessionId),
          overseer: isOverseer ? { segments: counts ? countSegments(counts) : [{ text: 'Overseer' }], folded, foldKey } : undefined,
          // Its overseer is not running (or on another computer): say whose thread it is.
          caption: threadOfCaption(session.overseer),
        });
        if (folded) return;
        threads.forEach((t, j) => {
          out.push({
            type: 'thread',
            key: `t:${group.hubId}:${t.sessionId}`,
            thread: threadFromSummary(t),
            hubId: group.hubId,
            offline: offline || connecting,
            first: j === 0,
            last: j === threads.length - 1,
          });
        });
      });
    }
    if (pastRows.length > 0) {
      out.push({ type: 'past-section', key: 'past' });
      let first = true;
      for (const { row, nest } of pastRows) {
        out.push({ type: 'past', key: `p:${row.key}`, row, first, nest });
        first = false;
      }
      out.push({ type: 'all', key: 'all' });
    }
    return out;
  }, [terminal, groups, hostList.length, hosts, sessions, pastRows, folds]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await remote.refresh();
    } finally {
      setRefreshing(false);
    }
  }, []);

  const renderItem = ({ item }: { item: HomeRow }) => {
    switch (item.type) {
      case 'notice':
        return <TerminalNotice host={item.host} />;
      case 'section':
        return <SectionHeader group={item.group} showHost={item.showHost} offline={item.offline} />;
      case 'past-section':
        return <PastHeader />;
      case 'past':
        return (
          <PastSessionRow
            row={item.row}
            now={now}
            showHost={hostList.length > 1}
            first={item.first}
            nest={item.nest}
            onToggleFold={(key) => toggleThreadsFolded(key, true)}
            onPress={() => router.push(sessionHref(item.row.hubId, item.row.session.sessionId))}
          />
        );
      case 'all':
        return <AllSessionsRow />;
      case 'row':
        return (
          <ThreadRow
            session={item.session}
            subagents={item.subagents}
            now={now}
            offline={item.offline}
            connecting={item.connecting}
            first={item.first}
            overseer={
              item.overseer
                ? {
                    segments: item.overseer.segments,
                    folded: item.overseer.folded,
                    onToggle: item.overseer.foldKey ? () => toggleThreadsFolded(item.overseer!.foldKey!, false) : undefined,
                  }
                : null
            }
            caption={item.caption}
            onPress={() => router.push(sessionHref(item.hubId, item.session.sessionId))}
            onLongPress={() => threadActions(item.hubId, item.session)}
          />
        );
      case 'thread':
        return (
          <NestedFrame last={item.last}>
            <BoardRow
              thread={item.thread}
              now={now}
              active
              first={item.first}
              variant="nested"
              offline={item.offline}
              onOpen={(id) => router.push(sessionHref(item.hubId, id))}
            />
          </NestedFrame>
        );
    }
  };

  let empty = null;
  if (!paired) {
    empty = (
      <EmptyState
        mark={<PhiMark size={48} />}
        title="Connect a computer"
        detail="Run phi remote pair on your Mac or Linux box, then scan the code."
        action={<Button title="Scan pairing code" icon="qrcode.viewfinder" onPress={() => router.push('/hosts/pair')} />}
      />
    );
  } else if (!anyLoaded) {
    empty = showConnecting && !allUnreachable ? (
      <View style={styles.connecting}>
        <ActivityIndicator color={colors.textSecondary} />
        <Text variant="footnote" tone="secondary" align="center">
          {`Connecting to ${hostList.map((h) => h.name).join(', ')}…`}
        </Text>
      </View>
    ) : null;
  } else if (groups.length === 0 && pastRows.length === 0) {
    empty = (
      <EmptyState
        title="No threads yet"
        detail="Start one here, or run phi on your computer."
        action={<Button title="New thread" icon="square.and.pencil" onPress={() => router.push('/new')} />}
      />
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          // Names the back button VoiceOver reads on pushed screens (otherwise "index").
          title: 'Threads',
          headerTitle: () => <HomeTitle hosts={hostList} />,
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Settings"
              hitSlop={10}
              onPress={() => router.push('/settings')}
              style={styles.headerButton}
            >
              <Icon name="ellipsis" size={20} color={colors.icon} />
            </Pressable>
          ),
        }}
      />
      <Stack.Toolbar placement="bottom">
        <Stack.Toolbar.Button
          icon={offlineCount > 0 ? 'desktopcomputer.trianglebadge.exclamationmark' : 'desktopcomputer'}
          accessibilityLabel={offlineCount > 0 ? `Computers, ${offlineCount} offline` : reach.connecting.length > 0 ? 'Computers, connecting' : 'Computers'}
          tintColor={offlineCount > 0 ? colors.danger : colors.icon}
          onPress={() => router.push('/hosts')}
        />
        <Stack.Toolbar.Spacer />
        <Stack.Toolbar.Button
          icon="square.and.pencil"
          accessibilityLabel="New thread"
          separateBackground
          tintColor={colors.icon}
          disabled={!paired}
          onPress={() => router.push('/new')}
        />
      </Stack.Toolbar>
      <LegendList
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.type}
        renderItem={renderItem}
        extraData={now}
        estimatedItemSize={76}
        recycleItems={false}
        contentInsetAdjustmentBehavior="automatic"
        onRefresh={paired ? onRefresh : undefined}
        refreshing={refreshing}
        ListHeaderComponent={
          paired ? (
            <View style={styles.search}>
              <SearchEntry label="Search all sessions" onPress={() => router.push('/sessions?focus=1')} />
              {allUnreachable ? <Notice icon="wifi.slash" message={UNREACHABLE_LINE} style={styles.unreachable} /> : null}
            </View>
          ) : null
        }
        ListEmptyComponent={empty}
        ListFooterComponent={rows.length > 0 && groups.length === 0 && empty ? empty : <View style={{ height: space.xxxl }} />}
        style={{ backgroundColor: colors.bg }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: space.lg,
    marginBottom: 6,
    paddingHorizontal: 20,
  },
  sectionLabel: { flexShrink: 1, maxWidth: '55%' },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radii.pill,
    paddingHorizontal: 6,
    paddingVertical: 2,
    maxWidth: 140,
  },
  rule: { flex: 1, height: 1 },
  notice: { marginHorizontal: space.lg, marginTop: space.sm },
  search: { paddingHorizontal: space.lg, paddingTop: space.xs, paddingBottom: space.xs },
  unreachable: { paddingHorizontal: space.xs, paddingTop: space.md, paddingBottom: space.xs },
  divider: { position: 'absolute', top: 0, left: 20, right: 0, height: StyleSheet.hairlineWidth },
  allRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: 20, paddingVertical: 14 },
  allLabel: { flex: 1 },
  connecting: { alignItems: 'center', gap: space.md, paddingTop: 120, paddingHorizontal: space.xxxl },
  headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
