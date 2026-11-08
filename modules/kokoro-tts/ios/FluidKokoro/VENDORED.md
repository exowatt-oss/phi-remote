# FluidKokoro (vendored)

From [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio) v0.18.2 (commit e396cf780c4abf8e395087467c0585d3b0d17f68),
Apache License 2.0 (LICENSE in this folder): the English Kokoro ANE-v3 runtime and its text front end, copied file for file from
`Sources/FluidAudio/TTS/` (`KokoroAne/V3/`, `KokoroAne/G2P/English/`, `G2P/G2PModel.swift`, `Shared/`, `SSML/`).

Changes for phi remote, each marked at the top of the file:
- `KokoroAneArrays.swift` is `KokoroAne/Pipeline/KokoroAneSynthesizer+Conversion.swift` renamed (only its array helpers are used).
- `KokoroAneConstants.swift`: `KokoroAneVariant.repo` removed (FluidAudio's model registry is not vendored).
- `G2PModel.swift`: the "kokoro" folder name inlined (same reason).
- `Shims.swift` is new: a logger, the G2P file names and the one asset helper the pipeline calls.
- `KokoroAneV3Pipeline.swift`: the compute units come from a `KokoroAneV3ComputePlan` (`.ane` is FluidAudio's choice; the app
  falls back to `.gpu` / `.cpu`), stages report start/end through `onStage` and name themselves when they fail, and a compiled
  bundle that fails to load is deleted only when its source package is there to recompile it (2026-11-05).

Not vendored: FluidAudio's downloaders (`../KokoroModelStore.swift` downloads), the NeMo text-normalization binary (the app spells
out numbers and units in JavaScript first), the Mandarin / Japanese / Spanish / French front ends and every other model.
There is no eSpeak (GPL) anywhere: words outside the Misaki lexicon go through the BART G2P Core ML model.
