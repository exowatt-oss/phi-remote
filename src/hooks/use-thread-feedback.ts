/**
 * Per-thread feedback while a reply streams (DESIGN.md §2.10, §4b):
 * - a selection tick when a reply starts, then at most every 320 ms while it grows;
 * - auto-read (Settings, off by default): a reply that just finished streaming is read
 *   aloud. History and other threads are never auto-read.
 * Both stay quiet while dictating, while something is being read, or when the thread is not
 * the focused, foreground screen.
 */

import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';

import type { TranscriptItem } from '@/lib/protocol';
import { isDictating } from '@/services/dictation';
import { useRemote } from '@/services/remote';
import { speak, speechStore } from '@/services/speech';

const TICK_MS = 320;

export function useThreadFeedback(items: TranscriptItem[], { focused }: { focused: boolean }): void {
  const autoRead = useRemote((s) => !!s.prefs.autoRead);
  const tick = useRef<{ id: string; len: number; at: number } | null>(null);
  const streaming = useRef<ReadonlySet<string>>(new Set());
  const primed = useRef(false);

  useEffect(() => {
    const current = items.filter((i): i is Extract<TranscriptItem, { kind: 'assistant' }> => i.kind === 'assistant' && !!i.streaming);
    // Opening a thread mid-reply is not a "reply started" moment: note it without a tick.
    const quiet = !primed.current || !focused || isDictating() || speechStore.getState().speakingId !== null;
    if (!primed.current) {
      primed.current = true;
      const first = current[0];
      if (first) tick.current = { id: first.id, len: first.text.length, at: Date.now() };
    }

    if (!quiet) {
      const now = Date.now();
      for (const it of current) {
        const prev = tick.current;
        if (!prev || prev.id !== it.id) {
          void Haptics.selectionAsync();
          tick.current = { id: it.id, len: it.text.length, at: now };
        } else if (it.text.length > prev.len && now - prev.at >= TICK_MS) {
          void Haptics.selectionAsync();
          tick.current = { id: it.id, len: it.text.length, at: now };
        }
      }
    }

    const ids = new Set(current.map((i) => i.id));
    if (autoRead && focused && !isDictating()) {
      for (const id of streaming.current) {
        if (ids.has(id)) continue;
        const done = items.find((i) => i.id === id);
        if (done?.kind === 'assistant' && done.text.trim() && !done.error) void speak(done.id, done.text);
      }
    }
    streaming.current = ids;
  }, [items, focused, autoRead]);
}
