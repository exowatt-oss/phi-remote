# phonon-stt (local Expo module, iOS)

On-device live dictation with [Phonon-2 Core ML](https://huggingface.co/FermionResearch/Phonon-2-CoreML) (parakeet-tdt-0.6b-v3
derivative, English) on the Neural Engine. Drop-in: copy this folder to `phi-remote/modules/phonon-stt/`; Expo autolinking
picks up `modules/*` (`expo-module.config.json` + `ios/PhononStt.podspec`), `expo prebuild` + `pod install` link it. No Swift
Package Manager integration, no config plugin, no new permission (the app already declares `NSMicrophoneUsageDescription`).

Verified 2026-10-30 in a throwaway copy of phi-remote `d9c4e3a` (Expo 58, RN 0.88.1, deployment target 16.4) on the Mac mini:
Release iOS 26.5 Simulator build + run (JS → native → live partials → final), and an unsigned `generic/platform=iOS` archive
(links the `ios-arm64` slice of `PhononTDT.xcframework`). See `../../docs/ASSET-PROVENANCE.md`.

## Files

| File | What |
|---|---|
| `index.ts` | typed JS API (`requireOptionalNativeModule`: `null` on Android / web / Expo Go) |
| `ios/PhononSttModule.swift` | Expo module definition; everything iOS 18-only behind `#available` |
| `ios/PhononEngine.swift` | state: one `Transcriber`, one live session, mic or file feed, events |
| `ios/LiveDictation.swift` | the live loop (same file as the macOS bench's `Sources/PhononLive/`) |
| `ios/MicCapture.swift` | AVAudioEngine input tap → 16 kHz mono Float32 + level |
| `ios/ModelStore.swift` | first-use download from Hugging Face (pinned revision, Range-resumable, SHA-256, no backup) + compile |
| `ios/PhononCoreML/` | vendored phonon-coreml Swift sources (Apache-2.0), one `@available` patch, see `VENDORED.md` |
| `ios/PhononTDT.xcframework` | vendored prebuilt greedy-TDT decoder (static, ios-arm64 / simulator / macOS) |

## JS API

```ts
import PhononStt, { isPhononAvailable } from '@/../modules/phonon-stt';

if (isPhononAvailable()) {
  if (!PhononStt.getModelStatus().ready) await PhononStt.downloadModel();       // onProgress {phase:'download', fraction}
  await PhononStt.prepare();                                                     // first run per iOS build: Neural Engine compile
  const sub = PhononStt.addListener('onPartial', ({ committed, tail }) => render(committed, tail));
  await PhononStt.start({ configureAudioSession: false });                        // expo-audio already set .playAndRecord
  // ✓
  const { text } = await PhononStt.stop();                                        // reads what is left of the open utterance
  sub.remove();
}
```

Events: `onPartial {committed, tail, kind, audioSeconds, decodeMs, function, decodedSeconds, t}` (~every 0.4 s while speech
arrives), `onFinal {text, latencyMs, finalDecodeMs, updates, fullPassText?, fullPassMs?}`, `onLevel {level}` (RMS, ~12/s, for the
waveform), `onProgress {phase, fraction?, file?, seconds?}` (download, "compiling", "loading enc_5s", "loaded enc_5s", ...),
`onError {message}`.

`committed` never changes except the punctuation / case of its last word, which the next utterance may correct; `tail` is the
open utterance and may change on every update (render it muted).

QA (Simulator, no microphone): `startFile(path, {speed, fullPass})` feeds a file through the same live loop in real time;
`transcribeFile(path)` is an offline read. Launch argument `-phiPhononLog YES` writes every event to the system log.

## Licences

Code: Apache-2.0 (phonon-coreml, Fermion Research; `ios/PhononCoreML/LICENSE`, `NOTICE`). Model weights (downloaded at run time,
not in this folder): CC-BY-4.0, derived from NVIDIA parakeet-tdt-0.6b-v3. Attribution goes in the app's
`THIRD_PARTY_NOTICES.md` and an about/licences screen: "Phonon-2 by Fermion Research (CC-BY-4.0), derived from NVIDIA
Parakeet TDT 0.6B v3 (CC-BY-4.0)".
