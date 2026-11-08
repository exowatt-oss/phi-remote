/**
 * Thread: the live transcript of one phi session (folded turns, work log, streaming reply)
 * with the glass composer docked above the keyboard.
 *
 * A stored session (Session history, v1 addition) opens here too: its transcript from the phone's
 * copy, then from the computer, paged the same way. Sending a message (or Resume) resumes it under
 * the same id and the screen turns into the live thread in place: same items, now streaming.
 *
 * Subagent threads (Subagents, v1 addition) use the same screen: titled with the run's name
 * under "Subagent of <parent>", a composer that only steers or stops the run (no model, photos
 * or slash commands), and a quiet "Finished · 3m 12s" footer instead once the run is over.
 * A parent thread pins its running subagents in a tray just above the composer.
 *
 * Overseers (v1 addition): an overseer pins its Threads board there instead (counts, the threads
 * that run, See all, Add thread) and its transcript shows its thread cards and updates. A thread
 * of an overseer says so under its title ("Thread of …", back to the overseer) and lists its
 * siblings from the header.
 */

import { KeyboardAwareLegendList, useKeyboardChatComposerInset } from '@legendapp/list/keyboard';
import type { LegendListRef } from '@legendapp/list/react-native';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router, Stack, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { KeyboardStickyView, useKeyboardState } from 'react-native-keyboard-controller';
import { useAnimatedReaction, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Composer } from '@/components/composer';
import { FloatingControls } from '@/components/floating-controls';
import { OverseerScope } from '@/components/overseer/scope';
import { ThreadsTray, type ThreadsTrayView } from '@/components/overseer/threads-tray';
import { SubagentScope, useSubagentChildren } from '@/components/subagents/scope';
import { SubagentStatusGlyph } from '@/components/subagents/subagent-row';
import { SubagentTray } from '@/components/subagents/subagent-tray';
import { useSubagentTray } from '@/components/subagents/use-subagent-tray';
import { HeaderIconButton, ReadLatestButton, ThreadTitle } from '@/components/thread-header';
import { showError } from '@/components/toast';
import { FoldRow, TranscriptRow, WorkingTail } from '@/components/transcript/items';
import { useAppActive } from '@/hooks/use-app-active';
import { useNow } from '@/hooks/use-now';
import { useThreadFeedback } from '@/hooks/use-thread-feedback';
import { describeError, ResumeError, type ResumeRequest } from '@/lib/client';
import { buildFeed, latestReply, turnStartedAt, type FeedEntry } from '@/lib/feed';
import { modelLabel, relativeTime, sessionHref, shortCwd, threadTitle } from '@/lib/format';
import { describeNewThreadDefault } from '@/lib/new-thread';
import { activeThreads, countBoard, countSegments, liveThreadsOf } from '@/lib/overseer';
import { HISTORY_FEATURE, type PastSession, type PromptImage, type PromptMode, type SessionSummary } from '@/lib/protocol';
import { selectTranscript, transcriptKey } from '@/lib/store';
import {
  looksLikeSubagentId,
  steerErrorText,
  steerPlaceholder,
  subagentFooter,
  subagentSubtitle,
  subagentTitle,
} from '@/lib/subagents';
import { orderedItems } from '@/lib/transcript';
import { moveDraft } from '@/services/drafts';
import { setForegroundThread } from '@/services/push';
import { ackTrayRun } from '@/services/subagent-tray';
import { useHubModels } from '@/services/new-thread';
import { useOverseerBoard } from '@/services/overseer';
import { pastBlockReason, pastComposerNote, sendToPast } from '@/lib/past-session';
import { remote, useRemote } from '@/services/remote';
import { useSpeakingId } from '@/services/speech';
import { glassAvailable, layout, radii, space, useTheme, withAlpha } from '@/theme';
import { Button, EmptyState, Surface, Text } from '@/ui';

function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/** The last summary seen for this thread, so a subagent removed with its parent still says what it was. */
function useLastKnown(session: SessionSummary | undefined): SessionSummary | undefined {
  const [known, setKnown] = useState(session);
  if (session && session !== known) setKnown(session);
  return session ?? known;
}

/**
 * Replaces the composer of a subagent that is no longer running: the composer's capsule, quiet,
 * holding one line ("Finished · 3m 12s · 14 tool calls").
 */
function SubagentFooter({ info }: { info: NonNullable<SessionSummary['subagent']> }) {
  const footer = subagentFooter(info);
  const rest = footer.text.slice(footer.title.length);
  return (
    <Surface radius={radii.composer} shadow="pill" style={styles.finished} accessible accessibilityLabel={footer.text}>
      <SubagentStatusGlyph status={info.status} />
      <Text variant="footnote" weight="medium" tone="secondary" numeric numberOfLines={1} style={styles.finishedText}>
        <Text variant="footnote" weight="medium" tone={footer.tone === 'danger' ? 'danger' : 'primary'}>
          {footer.title}
        </Text>
        {rest}
      </Text>
    </Surface>
  );
}

/** Header action of a stored session: resume it without a message. */
function ResumeButton({ busy, onPress }: { busy: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  if (busy) return <ActivityIndicator style={styles.resumeButton} color={colors.textSecondary} />;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Resume"
      accessibilityHint="Starts this session again on its computer"
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.resumeButton, pressed && { opacity: 0.55 }]}
    >
      <Text variant="body" weight="bold" tone="accent">
        Resume
      </Text>
    </Pressable>
  );
}

/** Vertical space after an entry, from T3's feed rhythm. */
function gapAfter(entry: FeedEntry, next: FeedEntry | undefined, working: boolean): number {
  if (!next) return 0;
  if (entry.type === 'fold') return space.xs;
  const item = entry.item;
  if (item.kind === 'user') return space.xl;
  if (item.kind === 'note') return 0;
  if (item.kind === 'tool') return next.type === 'item' && next.item.kind === 'tool' ? 1 : space.xs;
  const endsTurn = next.type === 'item' && next.item.kind === 'user';
  return endsTurn && !(item.streaming && working) ? space.xl : space.xs;
}

export default function ThreadScreen() {
  const params = useLocalSearchParams<{ hubId: string; sessionId: string }>();
  const hubId = param(params.hubId);
  const sessionId = param(params.sessionId);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const appActive = useAppActive();

  const session = useRemote((s) => s.sessions[hubId]?.[sessionId]);
  const known = useLastKnown(session);
  // Subagents (v1 addition): a worker launched by another thread's `subagent` tool.
  const subagent = known?.kind === 'subagent' ? known : null;
  const isSubagent = !!subagent || looksLikeSubagentId(sessionId);
  const parentId = subagent?.parentSessionId;
  const parent = useRemote((s) => (parentId ? s.sessions[hubId]?.[parentId] : undefined));
  const children = useSubagentChildren(hubId, sessionId);
  // Overseers (v1 addition): how many live threads name this session as their overseer.
  const liveThreadCount = useRemote((s) => (isSubagent ? 0 : liveThreadsOf(s.sessions[hubId], sessionId).length));
  const host = useRemote((s) => s.hosts[hubId]);
  const hostCount = useRemote((s) => s.hostOrder.length);
  const loaded = useRemote((s) => !!s.sessionsLoaded[hubId]);
  const transcript = useRemote((s) => selectTranscript(s, hubId, sessionId));
  // Session history (v1 addition): what the computer keeps about this session when it is not running.
  const past: PastSession | undefined = useRemote((s) => s.history[hubId]?.byId[sessionId]);
  const historySupport = useRemote((s) => {
    const features = s.hosts[hubId]?.features;
    return features ? (features.includes(HISTORY_FEATURE) ? 'history' : 'legacy') : (s.history[hubId]?.support ?? 'unknown');
  });
  const resuming = useRemote((s) => !!s.resuming[transcriptKey(hubId, sessionId)]);
  // After a resume whose recorded folder was gone: one quiet line under the composer.
  const resumeNote = useRemote((s) => s.resumeNotes[transcriptKey(hubId, sessionId)]) ?? null;
  const now = useNow(60_000);
  const newThreadDefault = useRemote((s) => s.prefs.newThread);
  // The computer's models, for the stored session's model name (the index has only its id).
  const { models: hubModels } = useHubModels(past && !session ? hubId : null, host?.conn.status === 'live');
  // Resume with the saved new-thread model and effort, only when picked (else the session's own).
  const [resumeWithDefault, setResumeWithDefault] = useState(false);

  useEffect(() => remote.subscribe(hubId, sessionId), [hubId, sessionId]);

  // /new (and /resume, /fork …) continue the conversation under a new session id: follow it,
  // carrying the draft. Waits for an in-flight send so its cleared draft is what moves.
  const replacedBy = useRemote((s) => s.replacements[transcriptKey(hubId, sessionId)]);
  const sendingRef = useRef(false);
  const [followTick, setFollowTick] = useState(0);
  useEffect(() => {
    if (!replacedBy || sendingRef.current) return;
    moveDraft(transcriptKey(hubId, sessionId), transcriptKey(hubId, replacedBy));
    router.replace(sessionHref(hubId, replacedBy));
  }, [replacedBy, hubId, sessionId, followTick]);

  const [menuOpen, setMenuOpen] = useState(false);
  const [steerNotice, setSteerNotice] = useState<string | null>(null);
  // Subagents take no slash commands (the hub refuses commands.list for them).
  const commandScope = useMemo(() => (isSubagent ? null : { hubId, sessionId }), [hubId, sessionId, isSubagent]);
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      setForegroundThread({ hubId, sessionId });
      return () => {
        setFocused(false);
        setForegroundThread(null);
      };
    }, [hubId, sessionId]),
  );

  const items = useMemo(() => orderedItems(transcript), [transcript]);
  // An overseer: the hub says so, a live thread names it, or it has called the overseer tool.
  const callsOverseer = useMemo(() => !isSubagent && items.some((i) => i.kind === 'tool' && i.name === 'overseer'), [items, isSubagent]);
  const isOverseer =
    !isSubagent && (!!session?.isOverseer || (session?.threadCounts?.total ?? 0) > 0 || liveThreadCount > 0 || !!past?.isOverseer || callsOverseer);
  const live = host?.conn.status === 'live';
  /** Not running: read from the computer's stored copy (or the phone's), resumable from here. */
  // Once the resumed session streams (its session.upsert may still be on the way) it is live.
  const pastMode = !session && !isSubagent && transcript.source !== 'live' && (!!past || transcript.source === 'stored');
  const working = live && (transcript.live?.status ?? session?.status) === 'working';
  const activity = transcript.live?.activity ?? session?.activity;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const feed = useMemo(() => buildFeed(items, { working, expanded }), [items, working, expanded]);
  const latest = useMemo(() => latestReply(items), [items]);
  const itemIds = useMemo(() => new Set(transcript.order), [transcript.order]);
  const speakingId = useSpeakingId();
  const showReadButton = !!latest || (speakingId !== null && itemIds.has(speakingId));
  // A subagent's turn can start before the loaded page: its run started then at the latest.
  const runStartedAt = session?.subagent?.status === 'running' ? session.subagent.startedAt : 0;
  const since = turnStartedAt(items) ?? (runStartedAt || null);
  useThreadFeedback(items, { focused: focused && appActive });

  // ---- list, follow-at-end, composer inset ----
  const listRef = useRef<LegendListRef>(null);
  const composerRef = useRef<ComponentRef<typeof View>>(null);
  const { contentInsetEndAdjustment: composerInset, onComposerLayout } = useKeyboardChatComposerInset(
    listRef,
    // The hook only calls measure(); its declared View type predates RN's element refs.
    composerRef as unknown as Parameters<typeof useKeyboardChatComposerInset>[1],
    120,
  );
  // The pinned subagent tray sits on top of the composer: its height (animated on the UI thread)
  // joins the list's end inset frame by frame, so the last message rides up with it. The home
  // indicator's inset is added too: the list's own end (scrollToEnd, follow-at-end) leaves out
  // the safe area iOS adds, which kept the last reply's time and copy row under the composer.
  const trayHeight = useSharedValue(0);
  const listInset = useSharedValue(120);
  const safeBottom = insets.bottom;
  useAnimatedReaction(
    () => composerInset.value + trayHeight.value + safeBottom,
    (inset) => {
      listInset.value = inset;
    },
  );
  const [following, setFollowing] = useState(true);
  const [away, setAway] = useState(false);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement, contentInset } = e.nativeEvent;
    const distance = contentSize.height + (contentInset?.bottom ?? 0) - (contentOffset.y + layoutMeasurement.height);
    if (distance < 24) setFollowing(true);
    const far = distance > 120;
    setAway((prev) => (prev === far ? prev : far));
  }, []);
  const scrollToEnd = useCallback(() => {
    setFollowing(true);
    void listRef.current?.scrollToEnd({ animated: true });
  }, []);

  const toggleFold = useCallback((turnId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  }, []);

  const sessionModel = session?.model?.id;
  // ---- pinned subagent tray ----
  const threadKey = transcriptKey(hubId, sessionId);
  const { height: windowHeight } = useWindowDimensions();
  const tray = useSubagentTray({
    threadKey,
    items,
    children,
    working,
    enabled: live && !!session && !isSubagent && !isOverseer,
    // Small phones keep more of the transcript: two slots instead of three.
    cap: windowHeight < 740 ? 2 : 3,
  });
  // ---- pinned Threads board (overseers) ----
  const board = useOverseerBoard(hubId, isOverseer ? sessionId : null, isOverseer && live && focused && appActive);
  const boardView = useMemo<ThreadsTrayView | null>(() => {
    if (!isOverseer || board.threads.length === 0) return null;
    // The board changes every few seconds; its relative times use the clock of each change.
    const at = Math.max(now, board.entry.updatedAt);
    const running = activeThreads(board.threads, at);
    const cap = windowHeight < 740 ? 2 : 3;
    return { segments: countSegments(countBoard(board.threads, at)), rows: running.slice(0, cap), more: Math.max(0, running.length - cap), now: at };
  }, [isOverseer, board.threads, board.entry.updatedAt, now, windowHeight]);
  const overseerScope = useMemo(
    () => (isOverseer ? { hubId, overseerId: sessionId, threads: board.threads } : null),
    [isOverseer, hubId, sessionId, board.threads],
  );
  // While typing, the tray tucks down to its summary line; a tap shows it again until the keyboard goes.
  const keyboardUp = useKeyboardState((s) => s.isVisible);
  const [keyboardSeen, setKeyboardSeen] = useState(keyboardUp);
  const [peek, setPeek] = useState(false);
  if (keyboardSeen !== keyboardUp) {
    setKeyboardSeen(keyboardUp);
    setPeek(false);
  }
  // The overseer's board shares the tray's place and its folded state.
  const trayCollapsed = tray.collapsed || (keyboardUp && !peek);
  const toggleTray = () => {
    if (trayCollapsed) {
      tray.setCollapsed(false);
      setPeek(keyboardUp);
    } else {
      tray.setCollapsed(true);
      setPeek(false);
    }
  };
  const openSubagent = useCallback(
    (child: string) => {
      void Haptics.selectionAsync();
      router.push(sessionHref(hubId, child));
    },
    [hubId],
  );
  const trayPinned = !!tray.view && !trayCollapsed;
  const openBoard = useCallback(() => router.push(`${sessionHref(hubId, sessionId)}/threads`), [hubId, sessionId]);
  const addThread = useCallback(() => router.push(`${sessionHref(hubId, sessionId)}/add-thread`), [hubId, sessionId]);
  const subagentScope = useMemo(
    () => ({ hubId, parentSessionId: sessionId, active: focused && appActive, pinned: trayPinned }),
    [hubId, sessionId, focused, appActive, trayPinned],
  );
  const renderItem = ({ item: entry, index }: { item: FeedEntry; index: number }) => {
    const gap = gapAfter(entry, feed[index + 1], working);
    return (
      <View style={gap ? { marginBottom: gap } : undefined}>
        {entry.type === 'fold' ? (
          <FoldRow label={entry.label} expanded={entry.expanded} hidden={entry.hidden} onToggle={() => toggleFold(entry.turnId)} />
        ) : (
          <TranscriptRow item={entry.item} sessionWorking={working} hideThinking={entry.hideThinking} sessionModel={sessionModel} />
        )}
      </View>
    );
  };

  const last = items[items.length - 1];
  // The live reply already shows its own progress (streaming text, or its "Thinking"
  // disclosure); a second "Thinking" tail under it read as a duplicate.
  const progressVisible =
    !!last &&
    ((last.kind === 'tool' && last.status === 'running') || (last.kind === 'assistant' && !!last.streaming && (!!last.text || !!last.thinking)));
  const tailLabel = activity ? (activity.summary ?? activity.tool) : 'Thinking';

  const model = session ? modelLabel(session.model) : '';
  const parentTitle = parent ? threadTitle(parent.name, parent.lastText) : null;
  const title = subagent
    ? subagentTitle(subagent)
    : session
      ? threadTitle(session.name, session.lastText)
      : past
        ? threadTitle(past.title)
        : isSubagent
          ? 'Subagent'
          : 'Thread';
  const where = session ? shortCwd(session.cwd) : past ? shortCwd(past.cwd) : '';
  // Overseers (v1 addition): this session is one of an overseer's threads.
  const link = isSubagent ? undefined : (session?.overseer ?? past?.overseer);
  const overseerId = link?.sessionId;
  const overseerSummary = useRemote((s) => (overseerId ? s.sessions[hubId]?.[overseerId] : undefined));
  const overseerPast = useRemote((s) => (overseerId ? s.history[hubId]?.byId[overseerId] : undefined));
  const overseerTitle = overseerSummary
    ? threadTitle(overseerSummary.name, overseerSummary.lastText)
    : (link?.name?.trim() || (overseerPast ? threadTitle(overseerPast.title) : 'its overseer'));
  const subtitle = isSubagent
    ? subagentSubtitle(parentTitle, subagent ? modelLabel(subagent.model) : null)
    : link
      ? `Thread of ${overseerTitle}`
      : [isOverseer && !/^overseer\b/i.test(title) ? 'Overseer' : null, hostCount > 1 ? host?.name : null, where].filter(Boolean).join(' · ');
  // Back to the parent: pops to it when it is under this screen, else opens it in place.
  const openParent = parent && parentId ? () => router.dismissTo(sessionHref(hubId, parentId)) : undefined;
  // Back to the overseer: pops to it when it is under this screen (through siblings), else
  // takes this screen's place, so thread → overseer → thread never piles up.
  const navigation = useNavigation();
  const openOverseer = overseerId
    ? () => {
        void Haptics.selectionAsync();
        const state = navigation.getState();
        const routes = state?.routes ?? [];
        const at = state?.index ?? routes.length - 1;
        for (let i = at - 1; i >= 0; i--) {
          const p = routes[i].params as { hubId?: string; sessionId?: string } | undefined;
          if (routes[i].name === routes[at]?.name && p?.hubId === hubId && p?.sessionId === overseerId) {
            router.dismiss(at - i);
            return;
          }
        }
        router.replace(sessionHref(hubId, overseerId));
      }
    : undefined;
  const openSiblings = overseerId ? () => router.push(`${sessionHref(hubId, overseerId)}/threads?from=${encodeURIComponent(sessionId)}`) : undefined;
  const runInfo = subagent?.subagent;
  const running = runInfo?.status === 'running';
  // Opening a failed subagent is what lets go of it in its parent's tray.
  const runStatus = runInfo?.status;
  useEffect(() => {
    if (focused && parentId && runStatus === 'failed') ackTrayRun(transcriptKey(hubId, parentId), sessionId);
  }, [focused, parentId, runStatus, hubId, sessionId]);
  const thinking = session?.thinkingLevel && session.thinkingLevel !== 'off' ? session.thinkingLevel : null;

  const blocked = !host
    ? 'This computer is no longer paired'
    : host.conn.status === 'unauthorized'
      ? `${host.name} unpaired this iPhone`
      : !live
        ? 'Not connected'
        : null;

  // ---- stored session: resume ----
  const hostName = host?.name ?? 'this computer';
  // Never pre-emptively blocked: sending always tries session.resume (offline, an old phi or a
  // refusal shows as a normal send failure and the draft is kept). Only an unpaired computer stops it.
  const pastBlocked = pastBlockReason(host);
  const canResume = pastMode && !pastBlocked && !resuming;
  const named = past?.model ? hubModels?.models.find((m) => m.provider === past.model!.provider && m.id === past.model!.id)?.name : undefined;
  const sessionModelLabel = past?.model ? (named ?? modelLabel(past.model)) : 'Its own model';
  const resumeChoice = (): Pick<ResumeRequest, 'model' | 'thinkingLevel'> =>
    resumeWithDefault && newThreadDefault
      ? { model: newThreadDefault.model ? { provider: newThreadDefault.model.provider, id: newThreadDefault.model.id } : undefined, thinkingLevel: newThreadDefault.thinkingLevel }
      : {};
  const pickResumeModel = () => {
    const keep = `Keep ${sessionModelLabel}`;
    const def = newThreadDefault ? `Use my default: ${describeNewThreadDefault(newThreadDefault)}` : null;
    const options = def ? [keep, def, 'Cancel'] : [keep, 'Cancel'];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Model when resuming',
        message: def ? undefined : 'Pick a default in Settings \u203a New threads to resume with it instead.',
        options,
        cancelButtonIndex: options.length - 1,
      },
      (i) => {
        if (options[i] === keep) setResumeWithDefault(false);
        else if (def && options[i] === def) setResumeWithDefault(true);
      },
    );
  };
  const resume = (prompt?: string, images?: PromptImage[]): Promise<boolean> =>
    sendToPast(
      async () => {
        await remote.resume(hubId, sessionId, { prompt, images, ...resumeChoice() });
        setTimeout(scrollToEnd, 50);
      },
      showError,
      (err) => (err instanceof ResumeError ? err.message : describeError(err)),
    );

  const send = async (text: string, images: PromptImage[], mode: PromptMode): Promise<boolean> => {
    // A stored session: the message resumes it (delivered once it is live again).
    if (pastMode) return resume(text, images);
    sendingRef.current = true;
    setSteerNotice(null);
    try {
      await remote.prompt(hubId, sessionId, text, images, mode);
      // A new prompt puts the tray's failed subagents behind the user.
      if (!isSubagent) tray.ackFailures();
      setTimeout(scrollToEnd, 50);
      return true;
    } catch (err) {
      // A subagent refuses steering while it starts or exits: say so under the composer.
      if (isSubagent) setSteerNotice(steerErrorText(title, describeError(err)));
      else showError(describeError(err));
      return false;
    } finally {
      sendingRef.current = false;
      // After the composer has cleared its draft: follow a replacement that arrived meanwhile.
      if (remote.store.getState().replacements[transcriptKey(hubId, sessionId)]) setTimeout(() => setFollowTick((n) => n + 1), 0);
    }
  };
  const stop = async () => {
    try {
      await remote.abort(hubId, sessionId);
    } catch (err) {
      showError(describeError(err));
    }
  };

  const glass = glassAvailable();
  const ended = loaded && !session && !pastMode && transcript.phase === 'error';
  const lastActive = past ? relativeTime(Math.max(past.modifiedAt, items[items.length - 1]?.ts ?? 0), now) : '';
  const ago = lastActive ? (/^\d/.test(lastActive) ? `${lastActive} ago` : lastActive === 'now' ? 'just now' : `on ${lastActive}`) : '';
  // Under the composer of a stored session: where it stands.
  const pastNote = pastMode
    ? pastComposerNote({ host, legacy: historySupport === 'legacy', fromPhoneCopy: transcript.source === 'cache', ago })
    : null;
  // A finished subagent cannot be steered: a quiet footer replaces the composer.
  const finished = !!runInfo && !running && !!session;
  const dockPad = Math.max(space.sm, insets.bottom);
  const keyboardGap = dockPad - space.sm;

  let body;
  if (ended && isSubagent) {
    body = (
      <EmptyState
        title="This subagent is no longer available"
        detail={parent ? undefined : 'The thread that started it has ended.'}
        action={
          openParent ? (
            <Button title="Open parent thread" onPress={openParent} />
          ) : (
            <Button title="Back to threads" onPress={() => router.dismissTo('/')} />
          )
        }
      />
    );
  } else if (ended) {
    body = (
      <EmptyState
        title="This session ended"
        detail={`It is no longer running on ${host?.name ?? 'this computer'}.`}
        action={<Button title="Back to threads" onPress={() => router.dismissTo('/')} />}
      />
    );
  } else if (host?.conn.status === 'offline' && items.length === 0) {
    // A spinner that never resolves reads as broken; say what the wait is for.
    body = (
      <EmptyState
        title={`${host.name} is offline`}
        detail={pastMode ? 'This session is not saved on this iPhone yet. It loads when the computer is back.' : 'This thread loads when the computer is back.'}
      />
    );
  } else if ((transcript.phase === 'loading' || transcript.phase === 'empty') && items.length === 0) {
    body = <ActivityIndicator color={colors.textSecondary} />;
  } else if (transcript.phase === 'error' && items.length === 0) {
    body = (
      <EmptyState
        title="Could not load this thread"
        detail={transcript.error ?? undefined}
        action={<Button title="Try again" variant="plain" onPress={() => remote.resubscribe(hubId, sessionId)} />}
      />
    );
  } else if (items.length === 0) {
    body = (
      <Text variant="footnote" tone="tertiary" align="center">
        Nothing here yet.
      </Text>
    );
  } else {
    body = (
      <KeyboardAwareLegendList
        ref={listRef}
        data={feed}
        keyExtractor={(e) => e.key}
        getItemType={(e) => (e.type === 'fold' ? 'fold' : e.item.kind)}
        renderItem={renderItem}
        extraData={working}
        estimatedItemSize={180}
        drawDistance={500}
        recycleItems={false}
        alignItemsAtEnd
        initialScrollAtEnd
        maintainScrollAtEnd={following ? { animated: false, on: { dataChange: true, itemLayout: true, layout: true } } : false}
        maintainVisibleContentPosition={!following}
        onStartReached={transcript.hasMore ? () => void remote.loadOlder(hubId, sessionId) : undefined}
        onStartReachedThreshold={0.5}
        contentInsetEndAdjustment={listInset}
        keyboardOffset={keyboardGap}
        keyboardLiftBehavior="whenAtEnd"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        onScroll={onScroll}
        onScrollBeginDrag={() => setFollowing(false)}
        scrollEventThrottle={16}
        ListHeaderComponent={transcript.loadingOlder ? <ActivityIndicator style={styles.older} color={colors.textSecondary} /> : null}
        ListFooterComponent={
          working ? (
            <View style={styles.footer}>
              {!progressVisible ? <WorkingTail label={tailLabel} active={focused} /> : null}
            </View>
          ) : resuming ? (
            <View style={styles.footer}>
              <WorkingTail label={`Resuming on ${hostName}`} active={focused} />
            </View>
          ) : null
        }
        contentContainerStyle={styles.listContent}
      />
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Stack.Screen
        options={{
          title,
          headerTitle: () => (
            <ThreadTitle
              title={title}
              subtitle={subtitle}
              chip={!!link}
              rightButtons={pastMode && (canResume || resuming) ? 2 : openSiblings ? (showReadButton ? 2 : 1) : 1}
              reconnecting={!!host && !live && host.conn.status !== 'unauthorized'}
              onPress={openParent ?? openOverseer}
              accessibilityHint={openParent ? 'Opens the parent thread' : openOverseer ? 'Opens its overseer' : undefined}
            />
          ),
          // An item that renders nothing still gets an empty glass circle on iOS 26: omit it instead.
          headerRight:
            pastMode && (canResume || resuming)
              ? () => <ResumeButton busy={resuming} onPress={() => void resume()} />
              : openSiblings
                ? () => (
                    <View style={styles.headerButtons}>
                      <HeaderIconButton icon="rectangle.stack" label="Threads" hint="This overseer's threads" onPress={openSiblings} />
                      {showReadButton ? <ReadLatestButton latest={latest} threadItemIds={itemIds} /> : null}
                    </View>
                  )
                : showReadButton
                  ? () => <ReadLatestButton latest={latest} threadItemIds={itemIds} />
                  : undefined,
          ...(glass
            ? {
                headerTransparent: true,
                // The native soft edge never reaches this list: react-native-screens looks for the
                // scroll view down the first-child chain, and the keyboard-aware list sits behind
                // a decorator view, so feed text ran sharp under the title. The scrim below does
                // the job instead (the home list does get the native edge).
                scrollEdgeEffects: { top: 'hidden' as const },
              }
            : { headerTransparent: false, headerStyle: { backgroundColor: colors.bg } }),
        }}
      />
      <SubagentScope.Provider value={subagentScope}>
        <OverseerScope.Provider value={overseerScope}>
          {items.length > 0 && !ended ? body : <View style={styles.centerBox}>{body}</View>}
        </OverseerScope.Provider>
      </SubagentScope.Provider>
      {glass && items.length > 0 && !ended ? (
        // Top scrim under the transparent header, the mirror of the composer backdrop.
        <LinearGradient
          pointerEvents="none"
          colors={[withAlpha(colors.bg, 0.98), withAlpha(colors.bg, 0.93), withAlpha(colors.bg, 0)]}
          // The fade ends where the list's top padding ends, so the first message is never
          // washed out when the thread is scrolled all the way up.
          locations={[0, (insets.top + layout.navBarHeight) / (insets.top + layout.navBarHeight + space.md), 1]}
          style={[styles.topScrim, { height: insets.top + layout.navBarHeight + space.md }]}
        />
      ) : null}
      {ended ? null : (
        <KeyboardStickyView offset={{ closed: 0, opened: keyboardGap }} style={styles.dock} pointerEvents="box-none">
          <LinearGradient
            pointerEvents="none"
            colors={[withAlpha(colors.bg, 0), withAlpha(colors.bg, 0.6), withAlpha(colors.bg, 0.9)]}
            style={styles.backdrop}
          />
          <View style={[styles.dockInner, { paddingBottom: insets.bottom }]} pointerEvents="box-none">
            {/* The floating row hangs off this padding-free anchor: a percentage inset on a
                padded parent resolves against its content box and sank the row into the
                composer on phones with a home indicator. */}
            <View pointerEvents="box-none">
              {/* Hidden under the slash-command menu, which opens in the same place. */}
              <View
                style={[styles.floating, menuOpen && styles.hidden]}
                pointerEvents={menuOpen ? 'none' : 'box-none'}
                accessibilityElementsHidden={menuOpen}
              >
                <FloatingControls
                  working={working}
                  since={since}
                  tool={activity?.tool}
                  showArrow={away && !following}
                  onScrollToEnd={scrollToEnd}
                />
              </View>
              {isSubagent ? null : isOverseer ? (
                <ThreadsTray
                  view={boardView}
                  height={trayHeight}
                  collapsed={trayCollapsed}
                  hidden={menuOpen}
                  active={focused && appActive && live}
                  onToggle={toggleTray}
                  onOpen={openSubagent}
                  onSeeAll={openBoard}
                  onAdd={live && session ? addThread : null}
                />
              ) : (
                <SubagentTray
                  view={tray.view}
                  height={trayHeight}
                  collapsed={trayCollapsed}
                  hidden={menuOpen}
                  active={focused && appActive}
                  onToggle={toggleTray}
                  onOpen={openSubagent}
                  onMore={() => router.push(`${sessionHref(hubId, sessionId)}/subagents`)}
                />
              )}
              {/* Never flattened: the composer's layout transition measures its frame against its
                  mounted parent, and this one stays put while the tray above it grows or shrinks
                  (flattened, the composer lagged a frame behind every tray height step). */}
              <View ref={composerRef} onLayout={onComposerLayout} collapsable={false} style={{ paddingBottom: dockPad - insets.bottom }}>
                {finished && runInfo ? (
                  <SubagentFooter info={runInfo} />
                ) : isSubagent ? (
                  <Composer
                    draftKey={transcriptKey(hubId, sessionId)}
                    placeholder={steerPlaceholder(title)}
                    // The run is live between turns too: an empty composer offers Stop.
                    working={working || running}
                    blockedReason={blocked}
                    allowAttachments={false}
                    steerOnly
                    notice={steerNotice}
                    onSend={send}
                    onStop={stop}
                    onError={showError}
                  />
                ) : (
                  <Composer
                    draftKey={transcriptKey(hubId, sessionId)}
                    placeholder={pastMode ? 'Continue this session\u2026' : 'Message phi\u2026'}
                    working={working}
                    blockedReason={pastMode ? pastBlocked : blocked}
                    blockedNote={pastMode ? pastNote : null}
                    notice={pastMode ? (!pastBlocked && !resuming ? pastNote : null) : resumeNote}
                    commandScope={pastMode ? null : commandScope}
                    onMenuChange={setMenuOpen}
                    model={
                      pastMode
                        ? {
                            label: resumeWithDefault && newThreadDefault ? describeNewThreadDefault(newThreadDefault) : sessionModelLabel,
                            onPress: pickResumeModel,
                          }
                        : model
                          ? { label: thinking ? `${model} · ${thinking}` : model, onPress: () => router.push(`${sessionHref(hubId, sessionId)}/model`) }
                          : null
                    }
                    onSend={send}
                    onStop={stop}
                    onError={showError}
                  />
                )}
              </View>
            </View>
          </View>
        </KeyboardStickyView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topScrim: { position: 'absolute', top: 0, left: 0, right: 0 },
  centerBox: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingBottom: 160 },
  older: { paddingVertical: space.md },
  listContent: { paddingTop: space.md, paddingHorizontal: layout.feedPadding, paddingBottom: space.md },
  footer: { paddingTop: space.xs, minHeight: layout.floatingHeight + space.md },
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  backdrop: { position: 'absolute', left: 0, right: 0, top: -space.xxl, bottom: 0 },
  dockInner: { paddingHorizontal: layout.composerInset },
  floating: { position: 'absolute', left: 0, right: 0, bottom: '100%', paddingBottom: space.sm },
  hidden: { opacity: 0 },
  finished: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  finishedText: { flexShrink: 1 },
  resumeButton: { minWidth: 44, height: 44, paddingHorizontal: space.sm, alignItems: 'center', justifyContent: 'center' },
  headerButtons: { flexDirection: 'row', alignItems: 'center' },
});
