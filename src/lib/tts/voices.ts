/**
 * The natural (Kokoro-82M) voices Settings › Voice offers: the best-rated American English
 * voices of the model (hexgrad's VOICES.md grades: Heart A, Bella A-, the rest C+ — the next
 * tier), three women and three men. Heart is the default: the model's reference voice, calm
 * and clear, and the most intelligible in a speech-recognition round trip of sample replies.
 *
 * `Prefs.ttsVoice` holds one of these ids, or 'system' for the iPhone's own voice (then
 * `Prefs.voiceId` picks which); absent means the default natural voice.
 */

export type NaturalVoice = { id: string; name: string; detail: string };

export const NATURAL_VOICES: readonly NaturalVoice[] = [
  { id: 'af_heart', name: 'Heart', detail: 'Female, American' },
  { id: 'af_bella', name: 'Bella', detail: 'Female, American' },
  { id: 'af_sarah', name: 'Sarah', detail: 'Female, American' },
  { id: 'am_michael', name: 'Michael', detail: 'Male, American' },
  { id: 'am_fenrir', name: 'Fenrir', detail: 'Male, American' },
  { id: 'am_puck', name: 'Puck', detail: 'Male, American' },
];

export const DEFAULT_NATURAL_VOICE = 'af_heart';
export const SYSTEM_VOICE = 'system';

/** The stored choice, resolved: a natural voice id, or 'system'. Unknown ids fall back to the default. */
export function resolveTtsVoice(pref: string | undefined): string {
  if (pref === SYSTEM_VOICE) return SYSTEM_VOICE;
  return NATURAL_VOICES.some((v) => v.id === pref) ? (pref as string) : DEFAULT_NATURAL_VOICE;
}

export function naturalVoice(id: string): NaturalVoice | undefined {
  return NATURAL_VOICES.find((v) => v.id === id);
}

/** Only valid stored values survive a prefs load. */
export function isTtsVoicePref(v: unknown): v is string {
  return v === SYSTEM_VOICE || NATURAL_VOICES.some((x) => x.id === v);
}
