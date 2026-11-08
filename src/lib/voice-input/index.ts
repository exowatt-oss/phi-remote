// Ported from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md):
// t3code/packages/client-runtime/src/voice-input/index.ts. Kept in T3's formatting so it diffs cleanly against upstream.
export {
  replaceTextRange,
  resetVoiceInputGlobalsForTests,
  resolveTranscriptCommit,
  VoiceInputController,
  VOICE_RECORDING_LIMIT_SECONDS,
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceInputPhase,
  type VoiceInputState,
  type VoiceRecorder,
  type VoiceRecorderStatus,
} from "./controller";
export {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionErrorCode,
  type VoiceTranscriptionOptions,
} from "./transcription";
