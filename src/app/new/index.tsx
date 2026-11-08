/**
 * New thread (T3 NewTaskDraftScreen, stripped down): "What should we build in {folder}?",
 * a computer control when more than one is paired, and the composer. Sending starts a
 * headless phi there (session.spawn) with the saved model and effort (Prefs.newThread) and
 * opens it once the hub acknowledges.
 *
 * A Thread / Overseer switch in the header (Overseers, v1 addition): an overseer is asked "What
 * should the threads work on in {folder}?" and starts named "Overseer · <goal>", with a first
 * message that invokes the overseer skill and spells out the thread defaults (Prefs.overseer).
 * Computers whose phi predates overseers say so instead of starting one.
 */

import * as Haptics from 'expo-haptics';
import { router, Stack } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Composer } from '@/components/composer';
import { useOverseerDefaults } from '@/components/overseer/defaults-form';
import { describeError } from '@/lib/client';
import { expandHome, inferHome, machineSymbol, sessionHref, shortCwd } from '@/lib/format';
import { resolveNewThread } from '@/lib/new-thread';
import { describeOverseerDefaults, overseerCommand, overseerName, overseerPrompt } from '@/lib/overseer';
import { basename, HubError } from '@/lib/protocol';
import { commandsDonor, selectCommands } from '@/lib/store';
import { remote, useRemote } from '@/services/remote';
import { newThreadStore, setNewThread, useHubModels, useNewThread, useNewThreadHubId } from '@/services/new-thread';
import { layout, space, useTheme } from '@/theme';
import { Pill, Segmented, Text } from '@/ui';

const MODES = [
  { key: 'thread', label: 'Thread' },
  { key: 'overseer', label: 'Overseer' },
] as const;

export default function NewThreadScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const hostOrder = useRemote((s) => s.hostOrder);
  const hosts = useRemote((s) => s.hosts);
  const sessions = useRemote((s) => s.sessions);
  const saved = useRemote((s) => s.prefs.newThread);

  const hubId = useNewThreadHubId();
  const host = hubId ? hosts[hubId] : undefined;
  const live = host?.conn.status === 'live';

  const cwds = useNewThread((s) => (hubId ? s.cwds[hubId] : undefined));
  const { models } = useHubModels(hubId, live);
  const typed = useNewThread((s) => (hubId ? s.folder[hubId] : undefined));
  const choice = useMemo(() => resolveNewThread(saved, models), [saved, models]);
  const [starting, setStarting] = useState(false);
  // Skills and prompt templates come from any session on that computer (see Composer).
  const commandScope = useMemo(() => (hubId ? { hubId, sessionId: null } : null), [hubId]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode = useNewThread((s) => s.mode);
  const overseer = mode === 'overseer';
  const defaults = useOverseerDefaults();
  const canOverseer = !!host?.features?.includes('overseer');
  // The overseer skill's command on that computer (from any session's command list).
  const donor = useRemote((s) => commandsDonor(s, hubId));
  const command = useRemote((s) => (hubId && donor ? overseerCommand(selectCommands(s, hubId, donor)) : null));
  useEffect(() => {
    if (overseer && hubId && donor && live) remote.ensureCommands(hubId, donor);
  }, [overseer, hubId, donor, live]);

  useEffect(() => {
    if (!hubId || !live) return;
    const state = newThreadStore.getState();
    if (!state.cwds[hubId]) {
      remote
        .recentCwds(hubId)
        .then((list) => setNewThread((s) => ({ cwds: { ...s.cwds, [hubId]: list } })))
        .catch(() => setNewThread((s) => ({ cwds: { ...s.cwds, [hubId]: [] } })));
    }
  }, [hubId, live]);

  const home = useMemo(
    () => inferHome([...(cwds ?? []), ...Object.values(sessions[hubId ?? ''] ?? {}).map((s) => s.cwd)]),
    [cwds, sessions, hubId],
  );
  const folder = typed ?? (cwds?.[0] ? shortCwd(cwds[0]) : '');
  const cwd = expandHome(folder, home);
  const validFolder = cwd.startsWith('/');

  const chooseHost = () => {
    const ids = hostOrder;
    const note = (status: string) => (status === 'live' ? '' : status === 'connecting' || status === 'idle' ? ' (connecting)' : ' (offline)');
    const labels = ids.map((id) => `${hosts[id].name}${note(hosts[id].conn.status)}`);
    ActionSheetIOS.showActionSheetWithOptions({ title: 'Computer', options: [...labels, 'Cancel'], cancelButtonIndex: ids.length }, (i) => {
      if (i < ids.length) setNewThread(() => ({ hubId: ids[i] }));
    });
  };

  const start = async (text: string): Promise<boolean> => {
    if (!hubId || !validFolder) return false;
    setStarting(true);
    setError(null);
    try {
      const own = choice.model ? { provider: choice.model.provider, id: choice.model.id, thinkingLevel: choice.thinkingLevel } : null;
      const sessionId = await remote.spawn(hubId, {
        cwd,
        prompt: overseer ? overseerPrompt({ goal: text, defaults, command, overseer: own }) : text || undefined,
        provider: choice.model?.provider,
        modelId: choice.model?.id,
        thinkingLevel: choice.thinkingLevel ?? undefined,
        name: overseer ? overseerName(text) : undefined,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.dismissTo('/');
      router.push(sessionHref(hubId, sessionId));
      return true;
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      // not_found from spawn = unknown model (describeError would say the session ended).
      setError(err instanceof HubError && err.code === 'not_found' ? err.message : describeError(err));
      return false;
    } finally {
      setStarting(false);
    }
  };

  const blocked = !host
    ? 'Pair a computer first'
    : !live
      ? `${host.name} is offline`
      : overseer && !canOverseer
        ? `Update phi on ${host.name} to start overseers`
        : !validFolder
          ? 'Choose a folder'
          : starting
            ? 'Starting'
            : null;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <Segmented
              options={MODES}
              value={mode}
              onChange={(m) => setNewThread(() => ({ mode: m }))}
              accessibilityLabel="Start a thread or an overseer"
            />
          ),
        }}
      />
      {/* The command menu opens over the hero; fade the hero so the two never mix. */}
      <View style={[styles.hero, menuOpen && styles.heroHidden]} accessibilityElementsHidden={menuOpen}>
        <Text variant="largeTitle" weight="medium" align="center" style={styles.heroText}>
          {overseer ? 'What should the threads' : 'What should we build'}
        </Text>
        <View style={styles.heroLine}>
          <Text variant="largeTitle" weight="medium" style={styles.heroText}>
            {overseer ? 'work on in ' : 'in '}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Folder ${folder || 'not chosen'}`}
            accessibilityHint="Chooses the folder"
            onPress={() => router.push('/new/folder')}
            style={[styles.dir, { borderBottomColor: colors.textSecondary }]}
          >
            <Text variant="largeTitle" weight="bold" numberOfLines={1} style={styles.heroText}>
              {folder ? basename(cwd) || folder : 'a folder'}
            </Text>
          </Pressable>
          <Text variant="largeTitle" weight="medium" style={styles.heroText}>
            ?
          </Text>
        </View>
        {folder ? (
          <Text variant="label" tone="tertiary" align="center" numberOfLines={1} ellipsizeMode="head">
            {shortCwd(cwd)}
          </Text>
        ) : cwds === undefined && live ? (
          <ActivityIndicator color={colors.textSecondary} />
        ) : null}
        {overseer && canOverseer ? (
          <Pill
            icon="slider.horizontal.3"
            label={describeOverseerDefaults(defaults)}
            chevron="right"
            maxWidth="100%"
            onPress={() => router.push('/new/overseer')}
            accessibilityLabel={`Thread defaults: ${describeOverseerDefaults(defaults)}. Change`}
            style={styles.defaultsPill}
          />
        ) : null}
        {hostOrder.length > 1 && host ? (
          <Pill
            icon={machineSymbol(host.name)}
            label={host.name}
            emphasized
            onPress={chooseHost}
            accessibilityLabel={`Computer ${host.name}. Change`}
            style={styles.hostPill}
          />
        ) : null}
        {starting ? (
          <View style={styles.starting} accessibilityLiveRegion="polite">
            <ActivityIndicator size="small" color={colors.textSecondary} />
            <Text variant="footnote" tone="secondary">
              {overseer ? `Starting an overseer in ${basename(cwd)}…` : `Starting phi in ${basename(cwd)}…`}
            </Text>
          </View>
        ) : null}
        {error ? (
          <Text variant="footnote" tone="danger" align="center">
            {error}
          </Text>
        ) : null}
      </View>

      <KeyboardStickyView offset={{ closed: 0, opened: Math.max(space.sm, insets.bottom) - space.sm }} style={styles.dock}>
        <View style={[styles.dockInner, { paddingBottom: Math.max(space.sm, insets.bottom) }]}>
          <Composer
            draftKey={`new:${hubId ?? ''}`}
            placeholder={overseer ? 'Describe the work…' : 'Ask anything…'}
            working={false}
            allowAttachments={false}
            commandScope={commandScope}
            onMenuChange={setMenuOpen}
            blockedReason={blocked === 'Starting' ? null : blocked}
            model={live && models ? { label: choice.name, suffix: choice.effort && `· ${choice.effort}`, onPress: () => router.push('/new/model') } : null}
            onSend={(text) => start(text)}
            onError={setError}
          />
        </View>
      </KeyboardStickyView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  hero: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: space.sm, paddingHorizontal: space.xxl, paddingBottom: 120 },
  heroHidden: { opacity: 0 },
  heroText: { letterSpacing: -0.4 },
  heroLine: { flexDirection: 'row', alignItems: 'baseline', maxWidth: '100%' },
  dir: { borderBottomWidth: 1, flexShrink: 1 },
  hostPill: { alignSelf: 'center', marginTop: space.sm },
  defaultsPill: { alignSelf: 'center', marginTop: space.xs },
  starting: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md },
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  dockInner: { paddingHorizontal: layout.composerInset },
});
