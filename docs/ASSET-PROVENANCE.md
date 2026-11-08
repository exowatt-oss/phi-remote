# Bundled asset provenance (2026-11-08)

This inventory was prepared from the private pre-release history of phi remote (2026-11-08) before its public initial commit. It covers all 13 tracked image/audio/native-binary files, plus fonts and model weights that are **not** tracked. No real photos, recordings of people, scans, or embedded model weights are present. The six audio previews contain only the synthetic sentence “This is how phi reads replies aloud.” They are not microphone recordings or user dictation.

| File | Origin and evidence | Terms | Verdict |
|---|---|---|---|
| `assets/icon.png` | Pre-release project history (2026-10-30); regenerable with `scripts/generate-icons.mjs` from phi's original 5×6 block φ grid | Original Exowatt/phi project art; Apache-2.0 | **Keep** |
| `assets/splash-icon.png` | Same generator; light-mode rendering of the same φ | Original Exowatt/phi art; Apache-2.0 | **Keep** |
| `assets/splash-icon-dark.png` | Same generator; dark-mode rendering of the same φ | Original Exowatt/phi art; Apache-2.0 | **Keep** |
| `docs/phi-icon.svg` | Pre-release project history (2026-10-30); vector of the same phi block grid, not T3 Code artwork | Original Exowatt/phi art; Apache-2.0 | **Keep** |
| `assets/voice-samples/af_heart.m4a` | Pre-release project history (2026-11-05); generated with Kokoro-82M per `scripts/generate-voice-samples.md` | Kokoro-82M v1.0 `af_heart` voice, Apache-2.0 model/voice packs | **Keep** |
| `assets/voice-samples/af_bella.m4a` | Same generation recipe; `af_bella` is listed in Kokoro's `VOICES.md` | Apache-2.0 Kokoro model/voice pack | **Keep** |
| `assets/voice-samples/af_sarah.m4a` | Same generation recipe; `af_sarah` in Kokoro `VOICES.md` | Apache-2.0 Kokoro model/voice pack | **Keep** |
| `assets/voice-samples/am_fenrir.m4a` | Same generation recipe; `am_fenrir` in Kokoro `VOICES.md` | Apache-2.0 Kokoro model/voice pack | **Keep** |
| `assets/voice-samples/am_michael.m4a` | Same generation recipe; `am_michael` in Kokoro `VOICES.md` | Apache-2.0 Kokoro model/voice pack | **Keep** |
| `assets/voice-samples/am_puck.m4a` | Same generation recipe; `am_puck` in Kokoro `VOICES.md` | Apache-2.0 Kokoro model/voice pack | **Keep** |
| `modules/phonon-stt/ios/PhononTDT.xcframework/ios-arm64/libPhononTDT.a` | Vendored from Fermion Research upstream at the revision pinned in `VENDORED.md`; reproducible with `scripts/fetch-phonon-tdt.sh --verify` | Apache-2.0 Fermion Research greedy-TDT decoder; `PhononCoreML/LICENSE`/`NOTICE` | **Keep** |
| `modules/phonon-stt/ios/PhononTDT.xcframework/ios-arm64_x86_64-simulator/libPhononTDT.a` | Same pinned upstream archive, simulator slice | Apache-2.0 Fermion Research | **Keep** |
| `modules/phonon-stt/ios/PhononTDT.xcframework/macos-arm64_x86_64/libPhononTDT.a` | Same pinned upstream archive, macOS slice | Apache-2.0 Fermion Research | **Keep** |

The Kokoro [model card](https://huggingface.co/hexgrad/Kokoro-82M/raw/main/README.md) explicitly licenses model weights under Apache-2.0, describes the training-audio licensing, and links [VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/raw/main/VOICES.md), which lists all six specific American English voice packs above. The clips are synthesized output from those voices, not the training audio itself. The bundled clips depend only on Kokoro's Apache-2.0 grant, not on any training-audio license or a separate recording. See the [voice-sample generation recipe](../scripts/generate-voice-samples.md) for the app self-test and AAC conversion. `modules/kokoro-tts/MODEL-NOTICE` pins the conversion and English front-end sources (Apache-2.0), and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) carries the attributions. The images have no external source: the generator paints a simple original glyph pixel-by-pixel, and source history names the original phi project art.

DM Sans fonts are **not in the tracked tree**; `@expo-google-fonts/dm-sans` supplies them at install time under SIL OFL 1.1, with the font license in `THIRD_PARTY_NOTICES.md`. Phonon-2 Core ML weights are **downloaded on demand**, CC BY 4.0 (NVIDIA/Fermion Research), with pinned revision and checksum as documented in `modules/phonon-stt/MODEL-NOTICE`. Kokoro-82M weights, voice packs, lexicon, and G2P model are likewise downloaded on demand and are not bundled. Swift under `modules/kokoro-tts/ios/FluidKokoro/` was adapted from FluidAudio v0.18.2 under Apache-2.0; see its `LICENSE` and `VENDORED.md`. Other files under `modules/` are source, JSON, header, plist, and license/notice text, not undocumented binary media.

**Not included:** personal dictation data, device-specific vocabulary snapshots and personal signing/release scripts from pre-release development were left out of the public repository; the dictionary tests use synthetic data.
