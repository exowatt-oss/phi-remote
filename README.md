# phi remote

![Status: experimental](https://img.shields.io/badge/status-experimental-orange) ![License: Apache--2.0](https://img.shields.io/badge/license-Apache--2.0-blue)

An experimental Expo/React Native iPhone app for viewing and steering [phi](https://github.com/exowatt-oss/phi) coding-agent sessions over a paired host's remote hub: live transcripts, prompts, model switching, session history, notifications, on-device dictation and read-aloud speech.

Created at [Exowatt](https://exowatt.com).

## Status and prerequisites

Experimental; the host protocol and mobile UI may change. You need a compatible **phi host with remote enabled** (`phi remote serve` and `phi remote pair`), an iPhone running a supported iOS version, Node.js and npm, Xcode for native iOS development, and a local-network connection or your own Tailscale network. This app does not ship a phi host or a hosted service. Push notifications additionally require your own Apple APNs setup; they are optional. Phonon-2 and Kokoro models download on first use, not from this repository.

## Developer install

```sh
npm ci
npx expo run:ios
```

Native speech modules and fonts require a development build; Expo Go alone is insufficient. Alternatively, use `npx expo start --dev-client` after installing a development build. Start and pair your phi remote host following the [protocol](docs/PROTOCOL.md); scan the pairing QR code in the app or enter the host URL and one-time pairing code. The default iOS/Android identifier `com.example.phiremote` is a placeholder: set `PHI_REMOTE_BUNDLE_ID` to an identifier you own when building for a device. Do not use anyone else's signing credentials.

To try the UI without a phi host, run `npm ci --prefix tools` and `node tools/mock-hub/server.mjs --help` for options, then start a local mock hub (for example `node tools/mock-hub/server.mjs --port 7717 --bind 127.0.0.1 --pair-code K7Q2M9XD --reusable-code`). On the iOS Simulator, pair with `http://127.0.0.1:7717`; on a physical phone, bind to a reachable LAN interface and use that host's address. Mock responses and session data are synthetic. See [mock-hub docs](tools/README.md).

## Configuration and checks

`PHI_REMOTE_BUNDLE_ID` sets the Expo iOS bundle identifier and Android package (default `com.example.phiremote`); `PHI_REMOTE_BUILD_NUMBER` selects the iOS build number (default `1`); `PHI_REMOTE_APS_ENV=development` selects development APNs signing (otherwise production). Model and accent settings are defined in `src/theme/tokens.ts`; built-in generic dictation terms are in `src/lib/dictionary/vocabulary.ts` and additional terms can be added through the app. No Exowatt service or key is required. Pairing tokens stay on the device.

```sh
npm run typecheck
npm run lint
npm test
```

These run unit tests without devices; the separate `npm run test:mock-hub` integration suite requires a running local mock hub and is not part of public CI. Native iOS integration, APNs and model downloads also require a signed device build, so CI does not exercise them.

## License, provenance and contribution

Original Exowatt code and project artwork are [Apache-2.0](LICENSE), Copyright 2026 Exowatt, Inc. Portions adapted from T3 Code retain its **MIT** copyright and license in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); other bundled/fetched components retain their own terms, including DM Sans (OFL), Phonon-2 model weights (CC BY 4.0, downloaded), and the Kokoro model (Apache-2.0, downloaded). See [NOTICE](NOTICE) and the [asset-by-asset provenance inventory](docs/ASSET-PROVENANCE.md).

See [CONTRIBUTING](https://github.com/exowatt-oss/.github/blob/main/CONTRIBUTING.md). Sign off contributions with `git commit -s` (DCO); no CLA.

## Security

Treat pairing codes and tokens as credentials; use your own trusted network and do not expose a hub's port directly to the public internet. Report vulnerabilities privately through [GitHub advisories](https://github.com/exowatt-oss/phi-remote/security/advisories/new) or see the [security policy](https://github.com/exowatt-oss/.github/blob/main/SECURITY.md). Do not open a public issue with secret material.
