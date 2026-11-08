// Ported from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md):
// t3code/apps/mobile/src/native/voiceTranscription.ts. Kept in T3's formatting so it diffs cleanly against upstream.
import type { VoiceTranscriber } from "@/lib/voice-input";

export function getLocalVoiceTranscriber(
  _contextualStrings: () => readonly string[] = () => [],
): VoiceTranscriber | null {
  return null;
}
