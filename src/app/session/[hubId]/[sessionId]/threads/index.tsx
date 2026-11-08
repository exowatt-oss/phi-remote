/**
 * Threads sheet (Overseers, v1 addition): an overseer's full board, ended threads included, in
 * groups (needs a look, running, exited, closed). Opened from the overseer's pinned board ("See
 * all") or from one of its threads (`from`: that thread, marked "You are here"; a row then takes
 * its place instead of piling up). Rows step into the thread.
 */

import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { Fragment, useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { BoardRow } from '@/components/overseer/board-row';
import { useAppActive } from '@/hooks/use-app-active';
import { useNow } from '@/hooks/use-now';
import { sessionHref, threadTitle } from '@/lib/format';
import { boardGroups, countBoard, countSegments } from '@/lib/overseer';
import { useOverseerBoard } from '@/services/overseer';
import { useRemote } from '@/services/remote';
import { radii, space, useTheme } from '@/theme';
import { EmptyState, Icon, Text } from '@/ui';

export default function ThreadsSheet() {
  const params = useLocalSearchParams<{ hubId: string; sessionId: string; from?: string }>();
  const hubId = String(params.hubId ?? '');
  const overseerId = String(params.sessionId ?? '');
  const from = params.from ? String(params.from) : null;
  const { colors } = useTheme();
  const appActive = useAppActive();
  const live = useRemote((s) => s.hosts[hubId]?.conn.status === 'live');
  const summary = useRemote((s) => s.sessions[hubId]?.[overseerId]);
  const past = useRemote((s) => s.history[hubId]?.byId[overseerId]);
  const board = useOverseerBoard(hubId, overseerId, appActive && live);
  const tick = useNow(15_000);
  const now = Math.max(tick, board.entry.updatedAt);
  const groups = useMemo(() => boardGroups(board.threads, now), [board.threads, now]);
  const segments = useMemo(() => countSegments(countBoard(board.threads, now)), [board.threads, now]);
  const title = summary ? threadTitle(summary.name, summary.lastText) : board.name || (past ? threadTitle(past.title) : 'Overseer');

  const open = (threadId: string) => {
    void Haptics.selectionAsync();
    // Close the sheet first: threads belong on the main stack, not inside the sheet.
    router.back();
    if (from) router.replace(sessionHref(hubId, threadId));
    else router.push(sessionHref(hubId, threadId));
  };
  const add = live && summary ? () => {
    void Haptics.selectionAsync();
    router.back();
    router.push(`${sessionHref(hubId, overseerId)}/add-thread`);
  } : null;

  if (board.threads.length === 0) {
    return (
      <EmptyState
        title={board.entry.source === 'pending' && live ? 'Loading threads…' : 'No threads yet'}
        detail="Threads this overseer starts show up here."
      />
    );
  }
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <View style={styles.head} accessible accessibilityLabel={`${title}. ${segments.map((s) => s.text).join(', ')}`}>
        <Text variant="footnote" weight="medium" numberOfLines={1}>
          {title}
        </Text>
        <Text variant="label" tone="secondary" numeric numberOfLines={1}>
          {segments.map((s, i) => (
            <Fragment key={i}>
              {i ? ' · ' : ''}
              {s.tone === 'danger' || s.tone === 'warning' ? (
                <Text variant="label" tone={s.tone} numeric>
                  {s.text}
                </Text>
              ) : (
                s.text
              )}
            </Fragment>
          ))}
        </Text>
      </View>
      {groups.map((g) => (
        <View key={g.key} style={styles.group}>
          <Text variant="label" weight="medium" tone="tertiary" numberOfLines={1} style={styles.groupTitle} accessibilityRole="header">
            {`${g.title} · ${g.threads.length}`}
          </Text>
          <View style={[styles.card, { backgroundColor: colors.bgElevated, borderColor: colors.border }]}>
            {g.threads.map((t, i) => (
              <BoardRow
                key={t.sessionId}
                thread={t}
                now={now}
                active={appActive}
                first={i === 0}
                current={t.sessionId === from}
                offline={!live}
                onOpen={open}
              />
            ))}
          </View>
        </View>
      ))}
      {add ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add thread"
          accessibilityHint="Asks the overseer to start one more thread"
          onPress={add}
          style={({ pressed }) => [styles.add, { backgroundColor: colors.bgElevated, borderColor: colors.border }, pressed && { backgroundColor: colors.rowPressed }]}
        >
          <Icon name="plus" size={14} weight="semibold" color={colors.icon} />
          <Text variant="footnote" weight="medium">
            Add thread
          </Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg },
  head: { gap: 2, paddingHorizontal: space.xs },
  group: { gap: space.sm },
  groupTitle: { paddingHorizontal: space.xs },
  card: { borderRadius: radii.md, borderCurve: 'continuous', borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  add: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    minHeight: 44,
    borderRadius: radii.md,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
  },
});
