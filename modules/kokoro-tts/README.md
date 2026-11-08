# kokoro-tts

Local Expo module: read-aloud with [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) on the iPhone (iOS 18+), through
FluidAudio's English ANE-v3 Core ML runtime (vendored in `ios/FluidKokoro`, see `VENDORED.md`).

- `ios/KokoroModelStore.swift`: first-use download of the pinned Core ML files from
  [FluidInference/kokoro-82m-coreml](https://huggingface.co/FluidInference/kokoro-82m-coreml) (59 files, 227 MB, SHA-256
  checked, resumable with HTTP ranges, Wi-Fi unless allowed), voice JSON → flat packs, `.mlpackage` → `.mlmodelc`, then
  Application Support/KokoroModels/ (excluded from backup). Same flow as `modules/phonon-stt`'s ModelStore.
- `ios/KokoroEngine.swift`: text → Misaki lexicon (+ overrides) → BART G2P for unknown words → the v3 pipeline → 24 kHz audio.
- `ios/KokoroPlayer.swift`: one AVAudioEngine + player node; pieces are trimmed of edge silence, padded with the requested
  pause and scheduled back to back. Output only: it uses the app's audio session and never the microphone.
- `ios/KokoroLoader.swift`: one load with one set of compute units (`ane` | `gpu` | `cpu`) under a deadline, the warm-up
  (one piece per synthesis path, checked for real speech), unload that rejects a waiting load at once, a load with the same
  units taking over an attempt still running, the native log and the QA launch flags (`-phiTtsForceFail`, `-phiTtsForceHang`,
  `-phiTtsForceBadAudio`). The app walks Neural Engine → GPU → CPU (`src/services/natural-voice.ts`).
- `ios/KokoroTtsModule.swift`: the JS API (`index.ts`), the model lifecycle, `diagnostics()` and QA helpers (`writeWav`,
  `writeSystemWav`).

Measured on the Mac mini (M6, macOS 27, 2026-11-05): load 1.0 s warm (17.7 s the first time: Neural Engine compile),
~180 MB loaded, synthesis 0.03× real time for pieces up to ~5 s (the static fast path), 0.07× above. All three compute plans
make clean speech there (macOS harness, 2026-11-05): CPU loads in 0.9 s + 1.9 s warm-up (0.05× real time), GPU 2.2 s + 7.5 s,
Neural Engine 17.6 s cold + 0.8 s.
