// Ported from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md):
// t3code/apps/mobile/src/features/voice-input/voiceInputMetering.ts. Kept in T3's formatting so it diffs cleanly against upstream.
export const VOICE_WAVEFORM_SAMPLE_COUNT = 64;

const VOICE_NOISE_FLOOR_DECIBELS = -60;
const VOICE_NOISE_FLOOR_AMPLITUDE = 10 ** (VOICE_NOISE_FLOOR_DECIBELS / 20);

export function normalizeVoiceInputDecibels(decibels: number | undefined) {
  if (decibels === undefined || !Number.isFinite(decibels)) return 0;
  if (decibels <= VOICE_NOISE_FLOOR_DECIBELS) return 0;
  if (decibels >= 0) return 1;

  const amplitude = 10 ** (decibels / 20);
  return Math.sqrt((amplitude - VOICE_NOISE_FLOOR_AMPLITUDE) / (1 - VOICE_NOISE_FLOOR_AMPLITUDE));
}
