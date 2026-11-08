# Vendored: phonon-coreml (Apache-2.0, Fermion Research)

Source: `phonon-coreml-src.tgz` from https://huggingface.co/FermionResearch/Phonon-2-CoreML at revision
`48af304c8db8bcc25307c206c199612f48479954` (SHA-256 of the tgz `633e97ca8d0c54b323ade42a3001feb507c4278c7cafe899d92ab30b9fde18ff`).
Files: `Sources/PhononCoreML/*.swift` (here) and `Binaries/PhononTDT.xcframework` (../PhononTDT.xcframework, the prebuilt greedy-TDT
decoder: ios-arm64, ios-arm64_x86_64-simulator, macos-arm64_x86_64).

At this pinned revision, upstream publishes the greedy-TDT decoder **only as a prebuilt xcframework** in the tarball; it does **not** publish the decoder's C source. We keep the three binary slices, their Fermion Research NOTICE and Apache-2.0 LICENSE. The SHA-256 digests of the committed slices are:

| Slice (`libPhononTDT.a`) | SHA-256 |
|---|---|
| `ios-arm64` | `538e354b04b8479aa8a043f314ec223a1dc4b5a72565c738cbeb970afb9a6c6a` |
| `ios-arm64_x86_64-simulator` | `44c792f0e62ab27d7d00c366d872c24459f342562cbcab1264e7305c566c910c` |
| `macos-arm64_x86_64` | `22fe6f7b949a4a56b4538f418b9b6142d6488e903a79eee9ad6bd8aca62930e5` |

Run `scripts/fetch-phonon-tdt.sh --verify` to download and hash-check the pinned tarball and compare its `Binaries/` slices byte-for-byte with these committed binaries. Without `--verify`, the script installs the three verified upstream slices into the xcframework.

One Swift change: `@available(iOS 18.0, macOS 15.0, *)` on `public final class Transcriber` (MLModelConfiguration.functionName is iOS 18),
so the pod compiles in an app whose deployment target is below iOS 18. Everything else is byte-identical.
