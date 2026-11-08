/**
 * Which dictation engine a new dictation uses. Phonon-2 live (words appear as you speak) only when
 * everything holds; otherwise Apple SpeechAnalyzer's record → transcribe path, unchanged. Phonon
 * never blocks the mic: while its model downloads or prepares, SpeechAnalyzer dictates.
 */

export type DictationEngine = 'phonon' | 'speech';

export type EngineInput = {
  /** Apple SpeechTranscriber is usable for the device language (iOS 26+). */
  speechAvailable: boolean;
  /** The Phonon native module is present and this is iOS 18+. */
  phononSupported: boolean;
  /** Settings › Voice › Live dictation (off unless the user turned it on). */
  enabled: boolean;
  /** The performance guard turned it off on this iPhone (cleared by re-enabling or an app/OS update). */
  slow: boolean;
  /** The device language is English, or the Voice setting forces English. */
  english: boolean;
  /** The model is downloaded and loaded in this app process (prepare() finished). */
  prepared: boolean;
};

/** The user wants live dictation and this iPhone can run it (the model should be fetched and prepared). */
export function liveWanted(i: Omit<EngineInput, 'speechAvailable' | 'prepared'>): boolean {
  return i.phononSupported && i.enabled && !i.slow && i.english;
}

/** Live dictation is wanted but not ready yet: dictate with SpeechAnalyzer and say so once. */
export function liveGettingReady(i: EngineInput): boolean {
  return liveWanted(i) && !i.prepared;
}

export function chooseEngine(i: EngineInput): DictationEngine | null {
  if (liveWanted(i) && i.prepared) return 'phonon';
  return i.speechAvailable ? 'speech' : null;
}

/** "en", "en-US", "en_GB", … (Phonon-2 is English only). */
export function isEnglishLocale(locale: string | null | undefined): boolean {
  const l = (locale ?? '').replaceAll('_', '-').toLowerCase();
  return l === 'en' || l.startsWith('en-');
}
