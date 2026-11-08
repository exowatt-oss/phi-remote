# Mock hub and protocol checks

The mock hub serves synthetic sessions for local UI development; it does not contact any internal service or require credentials. Install tools' dependencies and start it:

```sh
npm ci --prefix tools
node tools/mock-hub/server.mjs --port 7717 --bind 127.0.0.1 --pair-code K7Q2M9XD --reusable-code
```

Pair from the iOS Simulator at `http://127.0.0.1:7717` with code `K7Q2M9XD`. To pair a phone, bind to an address on a trusted LAN that the device can reach; do not expose the hub publicly. Run `node tools/mock-hub/server.mjs --help` to see fixture/session controls.

`node tools/conformance/run.mjs --help` prints options for protocol conformance tests against a compatible host. Those tests require a running hub and are intentionally separate from device-free Jest unit tests in CI. The production host wire contract is in [docs/PROTOCOL.md](../docs/PROTOCOL.md).
