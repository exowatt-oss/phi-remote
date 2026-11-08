/**
 * Composer — T3's glass capsule (DESIGN.md §3.11). Collapsed: [+] [one-line input] [mic]
 * [send/stop]. Expanded (focused, draft, photos or dictating): photo strip, a taller
 * input, and a toolbar with the model chip. While dictating the toolbar flips to ✕ · wave · ✓;
 * the words are inserted at the caret after ✓ (T3's record-then-transcribe, §4a). With live
 * dictation (Phonon) the input shows the words at the caret as they are recognized — committed
 * words in the text colour, the unstable tail muted — and scrolls to them; the draft itself is
 * untouched until ✓, so ✕ restores it exactly.
 *
 * Slash commands: a `/` token at the caret opens the command menu above the capsule (filtered
 * as you type, tap to insert `/name `, Return/space completes a single exact match); known
 * commands at the start of a line are drawn in the accent colour inside the input (styled
 * <Text> children of the TextInput, so the caret and selection stay native).
 */

import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Keyboard, Text as RNText, StyleSheet, TextInput, View, type TextInputInstance } from 'react-native';
import Animated, { FlipInXDown, LinearTransition, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  caretAfterEdit,
  commandNames,
  completeOnInsert,
  detectSlashTrigger,
  highlightSegments,
  insertCommand,
  rankCommands,
  type Edit,
  type Selection,
} from '@/lib/commands';
import { livePreview } from '@/lib/live-dictation/preview';
import type { CommandInfo, PromptImage, PromptMode } from '@/lib/protocol';
import { commandsDonor, selectCommands } from '@/lib/store';
import { MAX_ATTACHMENTS, MAX_TOTAL_BYTES, pickImages, totalBytes, type Attachment } from '@/services/attachments';
import { useDictation } from '@/services/dictation';
import { getDraft, saveDraft } from '@/services/drafts';
import { remote, useRemote } from '@/services/remote';
import { fonts, layout, motion, radii, space, typeScale, useTheme } from '@/theme';
import { IconButton, Pill, Surface, Text } from '@/ui';

import { AttachmentStrip } from './attachment-strip';
import { CommandMenu } from './command-menu';
import { DictationBar } from './dictation-bar';
import { PrimaryAction, primaryState } from './primary-action';

const layoutAnim = LinearTransition.duration(motion.composer).reduceMotion(ReduceMotion.System);

/**
 * Where slash commands come from. A thread uses its own session; the new-thread sheet passes
 * `sessionId: null` and borrows the list of the most recent session on that computer (skills
 * and prompt templates are per machine), without the built-ins that act on an existing session.
 */
export type CommandScope = { hubId: string; sessionId: string | null };

const NO_COMMANDS: CommandInfo[] = [];
const LINE_START_SLASH = /(^|\n)[ \t]*\//;

function useScopedCommands(scope: CommandScope | null | undefined) {
  const hubId = scope?.hubId ?? null;
  const donor = useRemote((s) => (scope && !scope.sessionId ? commandsDonor(s, scope.hubId) : null));
  const sessionId = scope?.sessionId ?? donor;
  const all = useRemote((s) => (hubId ? selectCommands(s, hubId, sessionId) : NO_COMMANDS));
  const newThread = !!scope && !scope.sessionId;
  const commands = useMemo(() => (newThread ? all.filter((c) => c.source !== 'builtin') : all), [all, newThread]);
  const ensure = useCallback(() => {
    if (hubId && sessionId) remote.ensureCommands(hubId, sessionId);
  }, [hubId, sessionId]);
  return { commands, ensure };
}

export type ComposerProps = {
  /** Draft memory key (one per thread; one for the new-thread sheet). */
  draftKey: string;
  placeholder: string;
  working: boolean;
  /** Set when sending is impossible (computer offline); the draft is kept. */
  blockedReason?: string | null;
  /** Says why in full instead of "<reason> — your draft is kept." (a stored session). */
  blockedNote?: string | null;
  /** Model pill; `suffix` (the effort) stays visible when the name truncates. */
  model?: { label: string; suffix?: string; onPress: () => void } | null;
  autoFocus?: boolean;
  /** Photo attachments (off for new threads: session.spawn takes text only). */
  allowAttachments?: boolean;
  /** Enables the slash-command menu. */
  commandScope?: CommandScope | null;
  /** The command menu opened or closed (the thread hides its floating controls under it). */
  onMenuChange?: (open: boolean) => void;
  /** Steering only, no "send when done" (a running subagent). */
  steerOnly?: boolean;
  /** A message shown under the capsule (e.g. a refused steer); the draft is kept. */
  notice?: string | null;
  /** Returns true when the message was accepted (the draft is then cleared). */
  onSend: (text: string, images: PromptImage[], mode: PromptMode) => Promise<boolean>;
  onStop?: () => Promise<void>;
  onError: (message: string) => void;
};

export function Composer({
  draftKey,
  placeholder,
  working,
  blockedReason,
  blockedNote,
  model,
  autoFocus,
  allowAttachments = true,
  commandScope,
  onMenuChange,
  steerOnly,
  notice,
  onSend,
  onStop,
  onError,
}: ComposerProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const initial = getDraft(draftKey);
  const [text, setText] = useState(initial.text);
  const textRef = useRef(initial.text);
  // Caret, for inserting dictated words where the user left it (end of the draft by default).
  const selectionRef = useRef<Selection | null>(null);
  const [selection, setSelection] = useState<Selection>({ start: initial.text.length, end: initial.text.length });
  const textListeners = useRef(new Set<() => void>());
  const [attachments, setAttachments] = useState<Attachment[]>(initial.attachments);
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<TextInputInstance>(null);
  const pendingCaret = useRef<number | null>(null);

  const updateText = (t: string) => {
    textRef.current = t;
    setText(t);
    for (const listener of textListeners.current) listener();
  };
  const updateSelection = (sel: Selection) => {
    selectionRef.current = sel;
    setSelection((prev) => (prev.start === sel.start && prev.end === sel.end ? prev : sel));
  };
  /** A programmatic edit: new text, caret placed explicitly once the input has the text. */
  const applyEdit = (edit: Edit) => {
    pendingCaret.current = edit.caret;
    updateSelection({ start: edit.caret, end: edit.caret });
    updateText(edit.text);
  };
  useEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    inputRef.current?.setSelection(caret, caret);
  }, [text]);

  useEffect(() => {
    saveDraft(draftKey, { text, attachments });
  }, [draftKey, text, attachments]);

  const dictation = useDictation({
    ownerKey: draftKey,
    getText: () => textRef.current,
    getSelection: () => {
      const len = textRef.current.length;
      const sel = selectionRef.current;
      return sel && sel.end <= len ? sel : { start: len, end: len };
    },
    setText: (t, sel) => {
      // Place the native caret after the inserted words too (and scroll to it).
      pendingCaret.current = sel.end;
      updateSelection(sel);
      updateText(t);
    },
    subscribe: (onChange) => {
      textListeners.current.add(onChange);
      return () => textListeners.current.delete(onChange);
    },
  });
  const dictating = dictation.phase !== 'idle' && dictation.phase !== 'error';
  // Live dictation: the draft with the recognized words at the caret captured when it started
  // (the caret is frozen while dictating: the input is read-only and selection events are ignored).
  const preview = useMemo(() => {
    if (!dictation.live) return null;
    const len = text.length;
    const sel = selection.end <= len ? selection : { start: len, end: len };
    return livePreview(text, sel, dictation.live.committed, dictation.live.tail, 'en-US');
  }, [dictation.live, text, selection]);
  const previewCaret = preview?.caret ?? null;
  useEffect(() => {
    // Keep the newest words in view: long dictation grows the input to its max height, then scrolls.
    if (previewCaret !== null) inputRef.current?.setSelection(previewCaret, previewCaret);
  }, [previewCaret]);
  const hasDraft = text.trim().length > 0 || attachments.length > 0;
  const expanded = focused || hasDraft || dictating;
  const state = primaryState({ working, hasDraft, blocked: !!blockedReason });

  // ---- slash commands ----
  const { commands, ensure: ensureCommands } = useScopedCommands(commandScope);
  const wantsCommands = !!commandScope && LINE_START_SLASH.test(text);
  useEffect(() => {
    // Fetched on the first `/` (or a restored draft that starts with one), cached per session.
    if (wantsCommands) ensureCommands();
  }, [wantsCommands, ensureCommands]);
  const trigger = useMemo(
    () => (commandScope && focused && !dictating ? detectSlashTrigger(text, selection) : null),
    [commandScope, focused, dictating, text, selection],
  );
  useEffect(() => {
    if (trigger) ensureCommands();
  }, [trigger, ensureCommands]);
  // Nothing matching (a path being typed, a typo): no menu at all rather than an empty one.
  const menuItems = useMemo(() => {
    const items = trigger && commands.length ? rankCommands(commands, trigger.query) : [];
    return items.length ? items : null;
  }, [trigger, commands]);
  const menuOpen = menuItems !== null;
  useEffect(() => {
    onMenuChange?.(menuOpen);
  }, [menuOpen, onMenuChange]);
  const names = useMemo(() => commandNames(commands), [commands]);
  const segments = useMemo(() => highlightSegments(text, names), [text, names]);

  // Room for the menu: from the top of the capsule up to the navigation bar.
  const rootRef = useRef<ComponentRef<typeof View>>(null);
  const [menuSpace, setMenuSpace] = useState(320);
  const measureMenuSpace = useCallback(() => {
    rootRef.current?.measureInWindow((_x, y) => {
      if (Number.isFinite(y) && y > 0) setMenuSpace(Math.max(0, y - insets.top - layout.navBarHeight - space.lg));
    });
  }, [insets.top]);
  useEffect(() => {
    if (!menuOpen) return;
    measureMenuSpace();
    const sub = Keyboard.addListener('keyboardDidShow', measureMenuSpace);
    return () => sub.remove();
  }, [menuOpen, measureMenuSpace]);

  const onChangeText = (next: string) => {
    const prev = textRef.current;
    // Return or space right after a token that names exactly one command completes it.
    const completion = commands.length && !dictating ? completeOnInsert(prev, next, commands) : null;
    if (completion) {
      void Haptics.selectionAsync();
      applyEdit(completion);
      return;
    }
    const caret = caretAfterEdit(prev, next);
    updateSelection({ start: caret, end: caret });
    updateText(next);
  };

  const selectCommand = (command: CommandInfo) => {
    if (!trigger) return;
    void Haptics.selectionAsync();
    applyEdit(insertCommand(textRef.current, trigger, command));
  };

  const send = async (mode: PromptMode) => {
    if (!hasDraft || busy || blockedReason) return;
    if (totalBytes(attachments) > MAX_TOTAL_BYTES) {
      onError('Those photos are too large to send together.');
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setBusy(true);
    try {
      const ok = await onSend(
        text.trim(),
        attachments.map(({ mimeType, data }) => ({ mimeType, data })),
        mode === 'auto' && working ? 'steer' : mode,
      );
      if (ok) {
        // Clear the stored draft now: a successful send may navigate away before re-render.
        saveDraft(draftKey, { text: '', attachments: [] });
        updateText('');
        setAttachments([]);
      }
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!onStop) return;
    setBusy(true);
    try {
      await onStop();
    } finally {
      setBusy(false);
    }
  };

  const attach = async () => {
    const res = await pickImages(MAX_ATTACHMENTS - attachments.length);
    if (res.attachments.length) setAttachments((a) => [...a, ...res.attachments].slice(0, MAX_ATTACHMENTS));
    if (res.error) onError(res.error);
  };

  const mic = !dictation.available ? null : dictation.denied ? (
    <IconButton icon="mic.slash" label="Open microphone settings" onPress={dictation.openSettings} color={colors.iconMuted} />
  ) : (
    <IconButton
      icon="mic"
      label="Dictate"
      hint="Transcribed on this iPhone"
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        dictation.start();
      }}
    />
  );
  const plus = allowAttachments ? (
    <IconButton icon="plus" label="Attach photos" onPress={attach} disabled={attachments.length >= MAX_ATTACHMENTS || dictating} />
  ) : (
    <View style={styles.noPlus} />
  );
  const primary = <PrimaryAction state={state} busy={busy} steerOnly={steerOnly} onSend={(m) => void send(m)} onStop={() => void stop()} />;

  const input = (
    <TextInput
      ref={inputRef}
      onChangeText={onChangeText}
      onSelectionChange={(e) => {
        if (!dictating) updateSelection(e.nativeEvent.selection);
      }}
      multiline
      autoFocus={autoFocus}
      readOnly={dictating}
      scrollEnabled={expanded}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      placeholder={dictation.phase === 'recording' ? 'Listening…' : dictation.phase === 'transcribing' ? 'Transcribing…' : placeholder}
      placeholderTextColor={colors.textSecondary}
      selectionColor={colors.accent}
      cursorColor={colors.accent}
      accessibilityLabel="Message"
      maxFontSizeMultiplier={1.6}
      style={[
        styles.input,
        { color: colors.text },
        expanded ? styles.inputExpanded : styles.inputCollapsed,
      ]}
    >
      {/* Controlled through children (RN's tokenized-text pattern) so known commands can be
          styled in place; `value` and children cannot be combined. */}
      {preview ? (
        <RNText>
          {preview.before}
          {preview.committed}
          {preview.gap}
          <RNText style={{ color: colors.textSecondary }}>{preview.tail}</RNText>
          {preview.after}
        </RNText>
      ) : (
        <RNText>
          {segments.map((seg, i) =>
            seg.command ? (
              <RNText key={i} style={[styles.command, { color: colors.accent }]}>
                {seg.text}
              </RNText>
            ) : (
              seg.text
            ),
          )}
        </RNText>
      )}
    </TextInput>
  );

  return (
    <View ref={rootRef} onLayout={menuOpen ? measureMenuSpace : undefined}>
      {menuItems ? <CommandMenu items={menuItems} maxHeight={menuSpace} onSelect={selectCommand} /> : null}
      {dictation.notice ? (
        <Text variant="caption" tone="secondary" numberOfLines={2} style={styles.notice} accessibilityLiveRegion="polite">
          {dictation.notice}
        </Text>
      ) : null}
      <Animated.View layout={layoutAnim}>
        <Surface
          radius={expanded ? radii.composerExpanded : radii.composer}
          shadow="composer"
          style={expanded ? styles.surfaceExpanded : styles.surfaceCollapsed}
        >
          {expanded ? (
            <>
              <AttachmentStrip items={attachments} onRemove={(id) => setAttachments((l) => l.filter((a) => a.id !== id))} />
              {input}
              {dictating ? (
                <DictationBar dictation={dictation} />
              ) : (
                <Animated.View entering={FlipInXDown.duration(motion.composer).reduceMotion(ReduceMotion.System)} style={styles.toolbar}>
                  {plus}
                  <View style={styles.modelSlot}>
                    {model ? (
                      // The slot is already the flexible part of the toolbar; let the pill use all
                      // of it ("Claude Opus 5.5 · high" was cut to "· hi…" with room to spare).
                      <Pill icon="cpu" label={model.label} suffix={model.suffix} onPress={model.onPress} accessibilityHint="Changes the model" maxWidth="100%" />
                    ) : null}
                  </View>
                  {mic}
                  {primary}
                </Animated.View>
              )}
            </>
          ) : (
            <View style={styles.row}>
              {plus}
              <AttachmentStrip compact items={attachments} onRemove={() => undefined} />
              {input}
              {mic}
              {primary}
            </View>
          )}
        </Surface>
      </Animated.View>
      {dictation.error ? (
        <Text variant="footnote" tone="danger" numberOfLines={2} style={styles.note} accessibilityLiveRegion="polite">
          {dictation.error}
        </Text>
      ) : blockedReason ? (
        <Text variant="caption" tone="secondary" numberOfLines={2} style={styles.note}>
          {blockedNote ?? `${blockedReason} — your draft is kept.`}
        </Text>
      ) : notice ? (
        <Text variant="caption" tone="secondary" numberOfLines={2} style={styles.note} accessibilityLiveRegion="polite">
          {notice}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  surfaceCollapsed: { paddingVertical: 2, paddingHorizontal: 2 },
  surfaceExpanded: {
    minHeight: layout.composerExpandedMin,
    paddingTop: 14,
    paddingBottom: 6,
    paddingHorizontal: 2,
    justifyContent: 'space-between',
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  input: {
    fontFamily: fonts.regular,
    fontSize: typeScale.body.fontSize,
    lineHeight: typeScale.body.lineHeight,
  },
  inputCollapsed: {
    flex: 1,
    height: layout.composerCollapsedInput,
    paddingTop: 7,
    paddingBottom: 6,
    paddingHorizontal: space.xs,
  },
  inputExpanded: {
    minHeight: layout.composerInputMin,
    maxHeight: layout.composerInputMax,
    paddingHorizontal: 14,
    paddingTop: 0,
    paddingBottom: space.xs,
    textAlignVertical: 'top',
  },
  command: { fontFamily: fonts.bold },
  toolbar: { flexDirection: 'row', alignItems: 'center' },
  noPlus: { width: space.sm },
  modelSlot: { flex: 1, flexDirection: 'row', minWidth: 0 },
  note: { marginTop: 6, paddingHorizontal: space.md },
  notice: { marginBottom: 6, paddingHorizontal: space.md },
});
