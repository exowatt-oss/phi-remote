#!/usr/bin/env node
// phi remote protocol v1 conformance tester (docs/PROTOCOL.md).
//
//   node tools/conformance/run.mjs --url http://127.0.0.1:7718 (--code XXXXXXXX | --token TOKEN)
//        [--session <id>] [--allow-prompt] [--spawn-cwd <dir>] [--prompt-image]
//        [--check-rate-limit] [--check-close-forbidden] [--expect-reusable-code]
//        [--check-server-ping] [--save-token FILE] [--spawn-outside-cwd /]
//        [--timeout 20] [--verbose]
//
// Works against the real hub and the mock. Non-zero exit when any check FAILs. Checks follow
// docs/PROTOCOL.md including its binding "Clarifications (v1)" section.

import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { validateHubFrame, check, Info, PairOk, PairErr, PairRateLimited, PairBadRequest, ACK_REQUESTS } from "./validators.mjs";

const { values: argv } = parseArgs({
	options: {
		url: { type: "string" },
		code: { type: "string" },
		token: { type: "string" },
		session: { type: "string" },
		"allow-prompt": { type: "boolean", default: false },
		"spawn-cwd": { type: "string" },
		"spawn-outside-cwd": { type: "string", default: "/" },
		"prompt-image": { type: "boolean", default: false },
		"check-rate-limit": { type: "boolean", default: false },
		"check-close-forbidden": { type: "boolean", default: false },
		"expect-reusable-code": { type: "boolean", default: false },
		"check-server-ping": { type: "boolean", default: false },
		"allow-resume": { type: "boolean", default: false },
		steer: { type: "boolean", default: false },
		"save-token": { type: "string" },
		timeout: { type: "string", default: "20" },
		verbose: { type: "boolean", short: "v", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

if (argv.help || !argv.url || (!argv.code && !argv.token)) {
	console.log(`usage: node tools/conformance/run.mjs --url http://HOST:PORT (--code CODE | --token TOKEN) [options]

  --session <id>            session to use for models.list / prompt tests
  --allow-prompt            send a real prompt (+ abort) to --session or a spawned session
  --spawn-cwd <dir>         spawn a headless session there, prompt it (with --allow-prompt), close it;
                            also checks spawn errors (missing dir, outside roots, unknown model)
  --spawn-outside-cwd <dir> existing dir outside the hub's allowed roots, for the forbidden check (default /)
  --prompt-image            attach a 1x1 PNG to the test prompt and expect user item images:1
  --check-rate-limit        malformed pair bodies → 400, then burn pairing attempts until 429
                            (locks this IP out of /v1/pair for ~1 min)
  --check-close-forbidden   session.close on an interactive session must fail with forbidden
                            (if the hub is broken this WOULD close that session)
  --check-server-ping       keep the main connection open ≥ 25 s to observe the hub's 20 s WS pings
  --steer                   if the prompt target is working, prompt it right away (steer) instead
                            of first waiting up to 30 s for it to go idle
  --allow-resume            session history: resume a stored session (starts a phi process on the
                            computer), check the same id + item ids, then close it; also resumes
                            a resumable:false one (must succeed) and checks cwdFallback acks
  --save-token <file>       write the paired device token to <file> (mode 0600) for later --token runs
  --expect-reusable-code    skip the "code is single use" check (mock --reusable-code)
  --timeout <s>             per-step timeout in seconds (default 20)
  --verbose                 print every frame received`);
	process.exit(argv.help ? 0 : 2);
}

const BASE = argv.url.replace(/\/+$/, "");
const WS_URL = `${BASE.replace(/^http/, "ws")}/v1/ws`;
const T = Number(argv.timeout) * 1000;
const TTY = process.stdout.isTTY;
const c = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const STARTED = Date.now();

// ------------------------------------------------------------- reporting

const results = [];
function report(status, name, detail = "") {
	results.push({ status, name, detail });
	const tag = { PASS: c(32, "PASS"), FAIL: c(31, "FAIL"), WARN: c(33, "WARN"), SKIP: c(90, "SKIP") }[status];
	console.log(`${tag}  ${name}${detail ? c(90, `  — ${detail}`) : ""}`);
}
const pass = (n, d) => report("PASS", n, d);
const fail = (n, d) => report("FAIL", n, d);
const warn = (n, d) => report("WARN", n, d);
const skip = (n, d) => report("SKIP", n, d);

/** Report the result of a shape validation. */
function shape(name, out, okDetail = "") {
	if (out.errors.length) fail(name, out.errors.slice(0, 8).join("; ") + (out.errors.length > 8 ? ` (+${out.errors.length - 8} more)` : ""));
	else pass(name, okDetail);
	const w = dedupe(out.warnings);
	if (w.length) warn(`${name} (unknown fields / hints)`, w.slice(0, 6).join("; ") + (w.length > 6 ? ` (+${w.length - 6} more)` : ""));
	return !out.errors.length;
}
const dedupe = (arr) => [...new Set(arr.map((s) => s.replace(/\[\d+\]/g, "[*]")))];

async function step(name, fn) {
	try {
		await fn();
	} catch (e) {
		fail(name, `threw: ${e?.message ?? e}`);
		if (argv.verbose) console.error(e);
	}
}

// --------------------------------------------------------- frame ledger

const ledger = { frames: 0, byType: {}, errors: [], warnings: [], toolTs: new Map(), toolTsErrors: [], toolItems: 0 };

/** A tool item's ts is when the call started (clarification 15): it must never change across versions. */
function trackToolTs(label, sid, items) {
	for (const it of items) {
		if (!it || it.kind !== "tool" || typeof it.id !== "string" || typeof it.ts !== "number") continue;
		const key = `${sid}/${it.id}`;
		const prev = ledger.toolTs.get(key);
		if (prev === undefined) {
			ledger.toolTs.set(key, it.ts);
			ledger.toolItems++;
		} else if (prev !== it.ts) ledger.toolTsErrors.push(`[${label}] tool ${String(sid).slice(0, 8)}/${it.id} ts ${prev} → ${it.ts} (status ${it.status})`);
	}
}

/** Most events in any window shorter than `ms` (times sorted ascending). */
function maxInWindow(times, ms = 1000) {
	let best = 0;
	for (let i = 0, j = 0; i < times.length; i++) {
		while (times[i] - times[j] >= ms) j++;
		best = Math.max(best, i - j + 1);
	}
	return best;
}

class Client {
	constructor(label) {
		this.label = label;
		this.frames = [];
		this.waiters = new Set();
		this.serverPings = 0;
		this.closeInfo = null;
		this.ws = new WebSocket(WS_URL, { handshakeTimeout: T });
		this.opened = new Promise((resolve, reject) => {
			this.ws.once("open", resolve);
			this.ws.once("error", reject);
			this.ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode} on WS upgrade`)));
		});
		this.closed = new Promise((resolve) => {
			this.ws.on("close", (code, reason) => {
				this.closeInfo = { code, reason: reason.toString(), at: Date.now() };
				for (const w of this.waiters) w.check(null);
				resolve(this.closeInfo);
			});
		});
		this.ws.on("error", () => {});
		this.ws.on("ping", () => this.serverPings++);
		this.ws.on("message", (data) => {
			let f;
			try {
				f = JSON.parse(data.toString("utf8"));
			} catch {
				ledger.errors.push(`[${this.label}] non-JSON frame: ${data.toString("utf8").slice(0, 120)}`);
				return;
			}
			if (argv.verbose) console.log(c(90, `  ← [${this.label}] ${JSON.stringify(f).slice(0, 300)}`));
			ledger.frames++;
			ledger.byType[f?.t] = (ledger.byType[f?.t] ?? 0) + 1;
			const out = validateHubFrame(f);
			for (const e of out.errors) ledger.errors.push(`[${this.label}] ${e}`);
			for (const w of out.warnings) ledger.warnings.push(w);
			this.frames.push({ at: Date.now(), f });
			if ((f?.t === "session.snapshot" || f?.t === "session.history") && Array.isArray(f.items)) trackToolTs(this.label, f.sessionId, f.items);
			if (f?.t === "session.event" && f.event?.type === "item.upsert" && f.event.item) trackToolTs(this.label, f.sessionId, [f.event.item]);
			for (const w of this.waiters) w.check(f);
		});
		this.openedAt = Date.now();
	}
	send(f) {
		if (argv.verbose) console.log(c(90, `  → [${this.label}] ${JSON.stringify(f).slice(0, 300)}`));
		this.ws.send(JSON.stringify(f));
	}
	sendRaw(s) {
		if (argv.verbose) console.log(c(90, `  → [${this.label}] (raw) ${s.slice(0, 300)}`));
		this.ws.send(s);
	}
	mark() {
		return this.frames.length;
	}
	/** Resolve with the first frame matching pred (searching from index `since`), or null on timeout/close. */
	waitFor(pred, timeout = T, since = this.frames.length) {
		for (let i = since; i < this.frames.length; i++) if (pred(this.frames[i].f)) return Promise.resolve(this.frames[i].f);
		if (this.closeInfo) return Promise.resolve(null);
		return new Promise((resolve) => {
			const w = {
				check: (f) => {
					if (f === null || pred(f)) {
						clearTimeout(timer);
						this.waiters.delete(w);
						resolve(f);
					}
				},
			};
			const timer = setTimeout(() => {
				this.waiters.delete(w);
				resolve(null);
			}, timeout);
			this.waiters.add(w);
		});
	}
	request(f, timeout = T) {
		const id = f.id ?? `c${randomBytes(4).toString("hex")}`;
		const since = this.mark();
		this.send({ ...f, id });
		return this.waitFor((x) => x?.re === id, timeout, since);
	}
	waitClose(timeout) {
		return Promise.race([this.closed, new Promise((r) => setTimeout(() => r(null), timeout))]);
	}
	close() {
		try {
			this.ws.close(1000);
		} catch {}
	}
}

// The app sends protocol: 1 (clarification 1); pass { protocol: undefined } to omit it.
function hello(token, extra = {}) {
	return { t: "hello", token, protocol: 1, app: { version: "conformance-0.1.0", build: "1" }, device: { name: "phi-remote conformance" }, ...extra };
}

async function connect(label, token, extra = {}) {
	const cl = new Client(label);
	await cl.opened;
	const since = cl.mark();
	cl.send(hello(token, extra));
	const w = await cl.waitFor((f) => f?.t === "welcome", T, since);
	return { cl, welcome: w };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function randomCode(not) {
	for (;;) {
		const b = randomBytes(8);
		let s = "";
		for (let i = 0; i < 8; i++) s += CROCKFORD[b[i] % 32];
		if (s !== String(not ?? "").toUpperCase()) return s;
	}
}

const pairAttempts = []; // timestamps of every POST /v1/pair this run made

/** body: object → JSON; string → sent verbatim (for malformed-body checks). */
async function http(method, urlPath, body) {
	if (urlPath === "/v1/pair" && method === "POST") pairAttempts.push(Date.now());
	const res = await fetch(`${BASE}${urlPath}`, {
		method,
		headers: body !== undefined ? { "content-type": "application/json" } : {},
		body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
		signal: AbortSignal.timeout(T),
	});
	let json;
	const text = await res.text();
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	return { status: res.status, json, text };
}

const describe = (f) => (f ? JSON.stringify(f).slice(0, 220) : "no reply (timeout)");

/**
 * Strict failure check (clarification 2): requests whose success reply is `ack` must fail with
 * `ack { ok:false, error:{ code } }`, every other request with `error { re, code }`.
 * Returns true on PASS.
 */
function expectFailure(name, reqT, reply, codes) {
	codes = [].concat(codes);
	if (!reply) return fail(name, "no reply (timeout)"), false;
	if (ACK_REQUESTS.has(reqT)) {
		if (reply.t !== "ack" || reply.ok !== false) return fail(name, `expected ack ok:false, got ${describe(reply)}`), false;
		if (!codes.includes(reply.error?.code)) return fail(name, `ack error.code ${JSON.stringify(reply.error?.code)}, expected ${codes.join("|")}`), false;
		pass(name, `ack ok:false ${reply.error.code}`);
		return true;
	}
	if (reply.t !== "error") return fail(name, `expected error { re, code }, got ${describe(reply)}`), false;
	if (!codes.includes(reply.code)) return fail(name, `error.code ${JSON.stringify(reply.code)}, expected ${codes.join("|")}`), false;
	pass(name, `error ${reply.code}`);
	return true;
}

const isLoopbackHub = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(argv.url).hostname);

// ================================================================= checks

let info;
let token = argv.token;
let deviceId;
const unknownSid = `conformance-missing-${randomBytes(6).toString("hex")}`;

console.log(`phi remote conformance → ${BASE}  (ws ${WS_URL})\n`);

// ---- HTTP -----------------------------------------------------------------

await step("GET /v1/info", async () => {
	const r = await http("GET", "/v1/info");
	if (r.status !== 200) return fail("GET /v1/info", `status ${r.status}`);
	info = r.json;
	shape("GET /v1/info shape", check(r.json, Info, "info"), `name=${r.json?.name} hubId=${r.json?.hubId} hubVersion=${r.json?.hubVersion}`);
});
if (!info) {
	console.log("\nhub unreachable; stopping.");
	process.exit(1);
}

await step("POST /v1/pair bad code → 401", async () => {
	const r = await http("POST", "/v1/pair", { code: randomCode(argv.code), deviceName: "phi-remote conformance", platform: "ios" });
	if (r.status === 429) return fail("POST /v1/pair bad code → 401", "got 429 (rate limited — wait a minute and rerun)");
	if (r.status !== 401) return fail("POST /v1/pair bad code → 401", `status ${r.status} ${r.text.slice(0, 120)}`);
	shape("POST /v1/pair bad code → 401 { error: invalid_code }", check(r.json, PairErr, "pair401"));
});

if (argv.code) {
	await step("POST /v1/pair good code", async () => {
		// lowercase + a dash + a space: the hub also normalises (clarification 5)
		const raw = argv.code.replace(/[\s-]/g, "").toLowerCase();
		const messy = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)} ${raw.slice(6)}` : raw;
		let r = await http("POST", "/v1/pair", { code: messy, deviceName: "phi-remote conformance", platform: "ios" });
		const NAME = `POST /v1/pair good code normalised (${JSON.stringify(messy)}) → 200`;
		if (r.status === 401) {
			// hub does not normalise: FAIL, but still pair with the plain lowercased code so the run can go on
			fail(NAME, "401 — hub must strip spaces/dashes and uppercase");
			r = await http("POST", "/v1/pair", { code: raw, deviceName: "phi-remote conformance", platform: "ios" });
			if (r.status !== 200) return fail("POST /v1/pair good code (lowercased) → 200", `status ${r.status} ${r.text.slice(0, 160)}`);
			pass("POST /v1/pair good code (lowercased) → 200");
		} else if (r.status !== 200) return fail(NAME, `status ${r.status} ${r.text.slice(0, 160)}`);
		else pass(NAME);
		shape("pair response shape", check(r.json, PairOk, "pair"));
		token = r.json?.token;
		deviceId = r.json?.deviceId;
		if (argv["save-token"] && typeof token === "string") fs.writeFileSync(argv["save-token"], `${token}\n`, { mode: 0o600 });
		if (typeof token === "string") {
			if (!/^[A-Za-z0-9_-]+$/.test(token)) fail("token is base64url", JSON.stringify(token));
			else if (token.length !== 43) warn("token is 32 bytes base64url (43 chars)", `length ${token.length}`);
			else pass("token is 32 bytes base64url (43 chars)");
		}
		if (r.json?.hubId !== info.hubId) fail("pair hubId == /v1/info hubId", `${r.json?.hubId} vs ${info.hubId}`);
		else pass("pair hubId == /v1/info hubId");
	});
	if (argv["expect-reusable-code"]) skip("pair code is single use", "--expect-reusable-code");
	else
		await step("pair code is single use", async () => {
			const r = await http("POST", "/v1/pair", { code: argv.code, deviceName: "phi-remote conformance (reuse)", platform: "ios" });
			if (r.status === 401) pass("pair code is single use (reuse → 401)");
			else fail("pair code is single use (reuse → 401)", `status ${r.status}`);
		});
} else {
	skip("POST /v1/pair good code", "--token given");
}

if (!token) {
	console.log("\nno token; stopping.");
	process.exit(1);
}

// ---- WS auth negatives (in parallel) --------------------------------------

await Promise.all([
	step("WS no hello within 5 s → 4401", async () => {
		const cl = new Client("nohello");
		await cl.opened;
		const t0 = Date.now();
		const ci = await cl.waitClose(9000);
		if (!ci) return fail("WS no hello within 5 s → close 4401", "still open after 9 s"), cl.close();
		const dt = Date.now() - t0;
		if (ci.code !== 4401) return fail("WS no hello within 5 s → close 4401", `closed ${ci.code} after ${dt} ms`);
		if (dt < 4000) return warn("WS no hello within 5 s → close 4401", `closed after only ${dt} ms`);
		pass("WS no hello within 5 s → close 4401", `after ${dt} ms`);
	}),
	step("WS hello bad token → 4401", async () => {
		const cl = new Client("badtoken");
		await cl.opened;
		cl.send(hello(randomBytes(32).toString("base64url")));
		const ci = await cl.waitClose(T);
		if (ci?.code === 4401) pass("WS hello with bad token → close 4401");
		else fail("WS hello with bad token → close 4401", ci ? `closed ${ci.code}` : "not closed"), cl.close();
	}),
	step("WS first frame not hello → 4401", async () => {
		const cl = new Client("nothello");
		await cl.opened;
		cl.send({ t: "ping", id: "p0" });
		const ci = await cl.waitClose(T);
		if (ci?.code === 4401) pass("WS first frame not hello (ping) → close 4401");
		else fail("WS first frame not hello (ping) → close 4401", ci ? `closed ${ci.code}` : "not closed"), cl.close();
	}),
	step("WS hello token missing → 4401", async () => {
		const cl = new Client("notoken");
		await cl.opened;
		cl.send({ t: "hello", app: { version: "conformance", build: "1" } });
		const ci = await cl.waitClose(T);
		if (ci?.code === 4401) pass("WS hello without token → close 4401");
		else fail("WS hello without token → close 4401", ci ? `closed ${ci.code}` : "not closed"), cl.close();
	}),
	step("WS hello protocol mismatch → 4426", async () => {
		// hello.protocol present and not 1 → 4426 (clarification 1)
		const cl = new Client("proto2");
		await cl.opened;
		cl.send(hello(token, { protocol: 2 }));
		await Promise.race([cl.waitClose(5000), cl.waitFor((f) => f?.t === "welcome", 5000)]);
		const got = cl.closeInfo ?? cl.frames.find((x) => x.f?.t === "welcome")?.f;
		if (got?.code === 4426) pass("WS hello { protocol: 2 } → close 4426");
		else if (got?.t === "welcome") fail("WS hello { protocol: 2 } → close 4426", "hub welcomed it");
		else fail("WS hello { protocol: 2 } → close 4426", got ? `closed ${got.code}` : "not closed within 5 s");
		cl.close();
	}),
]);

// ---- main connection ------------------------------------------------------

const A = new Client("A");
await A.opened;
let sessions = [];
let hubFeatures = [];
{
	A.send(hello(token));
	const w = await A.waitFor((f) => f?.t === "welcome" || f === null, T, 0);
	if (!w) {
		fail("hello → welcome", A.closeInfo ? `closed ${A.closeInfo.code} ${A.closeInfo.reason}` : "timeout");
		finish();
	}
	shape("hello → welcome shape", validateHubFrame(w), `deviceId=${w.deviceId} hubVersion=${w.host?.hubVersion}`);
	if (w.host?.hubId !== info.hubId) fail("welcome.host.hubId == /v1/info hubId", `${w.host?.hubId} vs ${info.hubId}`);
	else pass("welcome.host.hubId == /v1/info hubId");
	if (deviceId) {
		if (w.deviceId === deviceId) pass("welcome.deviceId == paired deviceId");
		else fail("welcome.deviceId == paired deviceId", `${w.deviceId} vs ${deviceId}`);
	}
	deviceId = w.deviceId;
	hubFeatures = Array.isArray(w.host?.features) ? w.host.features : [];
}

await step("ping → pong", async () => {
	const r = await A.request({ t: "ping", id: "conf-ping-1" });
	if (r?.t === "pong" && r.re === "conf-ping-1") pass("ping → pong (re matches)");
	else fail("ping → pong (re matches)", describe(r));
});

await step("sessions.list", async () => {
	const r = await A.request({ t: "sessions.list" });
	if (r?.t !== "sessions") return fail("sessions.list → sessions", describe(r));
	sessions = Array.isArray(r.sessions) ? r.sessions : [];
	shape("sessions.list → sessions shape (every SessionSummary)", validateHubFrame(r), `${sessions.length} session(s): ${sessions.map((s) => `${String(s.sessionId).slice(0, 8)}:${s.status}`).join(" ")}`);
	if (!sessions.length) warn("sessions.list non-empty", "hub reports no sessions; session checks will be skipped");
	if (argv.session && !sessions.some((s) => s.sessionId === argv.session)) fail("--session is listed", `${argv.session} not in sessions.list`);
});

// Malformed frames after auth → error bad_request, socket stays open (clarification 3).
await step("malformed frames", async () => {
	const cases = [
		{ name: "invalid JSON", raw: "{conformance: not json" },
		{ name: "JSON array", raw: "[1,2,3]" },
		{ name: "object without t", frame: { id: "conf-not-t" }, re: "conf-not-t" },
		{ name: "unknown t", frame: { t: "conformance.bogus", id: "conf-bogus-1" }, re: "conf-bogus-1" },
		{ name: "sessions.list without id", frame: { t: "sessions.list" } },
		{ name: "session.abort without id", frame: { t: "session.abort", sessionId: unknownSid } },
	];
	let open = true;
	for (const k of cases) {
		const name = `malformed frame (${k.name}) → error bad_request${k.re ? " with re" : ""}`;
		const m = A.mark();
		if (k.raw) A.sendRaw(k.raw);
		else A.send(k.frame);
		const r = await A.waitFor((f) => f?.t === "error" || (k.re && f?.re === k.re) || (!k.raw && !k.re && ["sessions", "ack"].includes(f?.t) && f.re === undefined), 5000, m);
		if (!r) fail(name, A.closeInfo ? `socket closed ${A.closeInfo.code}` : "no error frame within 5 s");
		else if (r.t !== "error" || r.code !== "bad_request") fail(name, describe(r));
		else if (k.re && r.re !== k.re) fail(name, `re ${JSON.stringify(r.re)}, expected ${k.re}`);
		else pass(name, r.re ? `re=${r.re}` : "");
		const p = await A.request({ t: "ping" }, 5000);
		if (p?.t !== "pong") {
			open = false;
			fail(`socket stays open after malformed frame (${k.name})`, A.closeInfo ? `closed ${A.closeInfo.code}` : describe(p));
			break;
		}
	}
	if (open) pass("socket stays open after malformed frames", `${cases.length} cases, ping → pong after each`);
});
if (A.closeInfo) {
	fail("main connection still open", `closed ${A.closeInfo.code}; stopping`);
	finish();
}

const sidFor = () => argv.session ?? sessions.find((s) => s.status === "idle")?.sessionId ?? sessions[0]?.sessionId;

await step("models.list", async () => {
	const sid = sidFor();
	if (!sid) return skip("models.list → models", "no session");
	const r = await A.request({ t: "models.list", sessionId: sid });
	if (r?.t !== "models") return fail("models.list → models", describe(r));
	shape("models.list → models shape", validateHubFrame(r), `${r.models?.length} models, current=${r.current ? `${r.current.provider}/${r.current.id}` : "-"} thinking=${r.thinkingLevel ?? "-"} levels=${r.thinkingLevels?.join(",")}`);
});

// models.list without sessionId → the hub's own registry + user defaults (clarification 8)
await step("models.list without sessionId", async () => {
	const r = await A.request({ t: "models.list" });
	if (r?.t !== "models") return fail("models.list without sessionId → models", describe(r));
	const ok = shape("models.list without sessionId → models", validateHubFrame(r), `${r.models?.length} models, default=${r.current ? `${r.current.provider}/${r.current.id}` : "-"} thinking=${r.thinkingLevel ?? "-"}`);
	if (ok && !r.models.length) fail("models.list without sessionId lists models", "empty models[]");
});

await step("cwds.recent", async () => {
	const r = await A.request({ t: "cwds.recent" });
	if (r?.t !== "cwds") return fail("cwds.recent → cwds", describe(r));
	shape("cwds.recent → cwds shape", validateHubFrame(r), `${r.cwds?.length} cwd(s)`);
	if (!isLoopbackHub || !Array.isArray(r.cwds)) return;
	// hub on this machine: every entry must be an existing directory (spawn-acceptable, clarification 6)
	const missing = r.cwds.filter((d) => {
		try {
			return !fs.statSync(d).isDirectory();
		} catch {
			return true;
		}
	});
	missing.length ? fail("cwds.recent lists existing directories only", missing.slice(0, 4).join(", ")) : pass("cwds.recent lists existing directories only", "hub is local");
});

// ---- slash commands (v1 addition; optional) ----------------------------------
// A hub from before slash commands answers commands.list with error bad_request: every slash
// command check is then SKIPped, never FAILed.

let commandsSupported = null;
await step("commands.list", async () => {
	const sid = sidFor();
	if (!sid) return skip("commands.list → commands", "no session");
	const r = await A.request({ t: "commands.list", sessionId: sid });
	if (r?.t === "error" && r.code === "bad_request") {
		commandsSupported = false;
		return skip("commands.list → commands", "hub predates slash commands (error bad_request)");
	}
	if (r?.t !== "commands") return fail("commands.list → commands", describe(r));
	commandsSupported = true;
	const bySource = {};
	for (const cmd of Array.isArray(r.commands) ? r.commands : []) bySource[cmd?.source] = (bySource[cmd?.source] ?? 0) + 1;
	shape("commands.list → commands shape (+ every CommandInfo)", validateHubFrame(r), `${r.commands?.length} commands ${JSON.stringify(bySource)}`);
	if (r.sessionId !== sid) fail("commands.sessionId matches the request", `${r.sessionId} vs ${sid}`);
	const names = new Set((r.commands ?? []).map((cmd) => cmd?.name));
	const missing = ["new", "compact", "name"].filter((n) => !names.has(n));
	missing.length ? warn("commands.list lists /new /compact /name", `missing ${missing.join(", ")}`) : pass("commands.list lists /new /compact /name");
	const skills = (r.commands ?? []).filter((cmd) => cmd?.source === "skill");
	if (skills.length) {
		const bad = skills.filter((cmd) => !String(cmd.name).startsWith("skill:"));
		bad.length ? fail("skills are named skill:<name>", bad.map((cmd) => cmd.name).slice(0, 4).join(", ")) : pass("skills are named skill:<name>", `${skills.length} skill(s)`);
	} else skip("skills are named skill:<name>", "no skills listed");
	const summary = sessions.find((x) => x.sessionId === sid);
	if (summary && summary.commandsVersion === undefined) warn("SessionSummary.commandsVersion present", "absent: clients cannot tell when the list changes");
	else if (summary) pass("SessionSummary.commandsVersion present", JSON.stringify(summary.commandsVersion));
	// Same request twice → same list (the version is what changes it).
	const again = await A.request({ t: "commands.list", sessionId: sid });
	if (again?.t === "commands" && JSON.stringify(again.commands) === JSON.stringify(r.commands)) pass("commands.list is stable between calls");
	else warn("commands.list is stable between calls", describe(again));
});

await step("commands.list errors", async () => {
	if (commandsSupported !== true) return skip("commands.list unknown sessionId → error not_found", commandsSupported === false ? "hub predates slash commands" : "commands.list not checked");
	const r = await A.request({ t: "commands.list", sessionId: unknownSid });
	expectFailure("commands.list unknown sessionId → error not_found", "commands.list", r, "not_found");
	const r2 = await A.request({ t: "commands.list" });
	expectFailure("commands.list without sessionId → error bad_request", "commands.list", r2, "bad_request");
});

// ---- subagents (v1 addition; optional) ---------------------------------------
// Only clients that send hello.features ["subagents"] get subagent sessions. A hub without the
// feature (or with no subagent running right now) sends none: those checks are SKIPped.

await step("subagents", async () => {
	const leaked = sessions.filter((x) => x?.kind === "subagent");
	leaked.length
		? fail("no subagent sessions without hello.features", `${leaked.length} sent to a client that did not opt in`)
		: pass("no subagent sessions without hello.features");
	const { cl: C, welcome } = await connect("C", token, { features: ["subagents"] });
	if (!welcome) return fail("hello with features → welcome", C.closeInfo ? `closed ${C.closeInfo.code}` : "timeout");
	pass("hello with features → welcome");
	try {
		const r = await C.request({ t: "sessions.list" });
		if (r?.t !== "sessions") return fail("sessions.list (features) → sessions", describe(r));
		shape("sessions.list (features) shape (every SessionSummary)", validateHubFrame(r));
		const all = Array.isArray(r.sessions) ? r.sessions : [];
		const kids = all.filter((x) => x?.kind === "subagent");
		const SA = "subagent sessions";
		if (!kids.length) return skip(SA, "hub sent no subagent sessions (predates the feature, or none running)");
		const byId = new Map(all.map((x) => [x.sessionId, x]));
		const orphans = kids.filter((k) => !byId.has(k.parentSessionId));
		orphans.length ? fail("every subagent's parent is listed", orphans.map((k) => k.sessionId).slice(0, 3).join(", ")) : pass("every subagent's parent is listed", `${kids.length} subagent(s)`);
		const parents = [...new Set(kids.map((k) => k.parentSessionId))].map((id) => byId.get(id)).filter(Boolean);
		for (const parent of parents) {
			const mine = kids.filter((k) => k.parentSessionId === parent.sessionId);
			const running = mine.filter((k) => k.subagent?.status === "running").length;
			const c = parent.subagents;
			if (!c) warn(`parent ${parent.sessionId.slice(0, 8)} has subagents counts`, "absent");
			else if (c.total < mine.length || c.running !== running) warn(`parent ${parent.sessionId.slice(0, 8)} counts match its subagents`, `${JSON.stringify(c)} vs ${running} running of ${mine.length} listed`);
			else pass(`parent ${parent.sessionId.slice(0, 8)} counts match its subagents`, JSON.stringify(c));
			// Each launch's toolCallId names a `subagent` tool item in the parent transcript.
			const snap = await C.request({ t: "session.subscribe", sessionId: parent.sessionId, limit: 500 });
			C.send({ t: "session.unsubscribe", sessionId: parent.sessionId });
			const calls = new Set((snap?.items ?? []).filter((it) => it?.kind === "tool" && it.name === "subagent").map((it) => it.toolCallId));
			const linked = mine.filter((k) => k.subagent?.toolCallId);
			const unmatched = linked.filter((k) => !calls.has(k.subagent.toolCallId));
			if (!linked.length) warn("subagent.toolCallId present", "no subagent names its launching tool call");
			else if (unmatched.length) warn("subagent.toolCallId matches a `subagent` tool item", `${unmatched.length} not in the last 500 items`);
			else pass("subagent.toolCallId matches a `subagent` tool item", `${calls.size} launch(es)`);
		}
		const kid = kids.find((k) => k.subagent?.status === "running") ?? kids[0];
		const snap = await C.request({ t: "session.subscribe", sessionId: kid.sessionId, limit: 50 });
		if (snap?.t === "session.snapshot") {
			shape("subagent session.subscribe → snapshot", validateHubFrame(snap), `${snap.items?.length} item(s)`);
			C.send({ t: "session.unsubscribe", sessionId: kid.sessionId });
		} else fail("subagent session.subscribe → snapshot", describe(snap));
		const hidden = await A.request({ t: "session.subscribe", sessionId: kid.sessionId });
		hidden?.t === "error" && hidden.code === "not_found"
			? pass("subagent hidden from clients without the feature (subscribe → not_found)")
			: warn("subagent hidden from clients without the feature (subscribe → not_found)", describe(hidden));
		if (hidden?.t === "session.snapshot") A.send({ t: "session.unsubscribe", sessionId: kid.sessionId });
		for (const req of [{ t: "models.list" }, { t: "commands.list" }]) {
			const x = await C.request({ ...req, sessionId: kid.sessionId });
			expectFailure(`${req.t} on a subagent → error bad_request`, req.t, x, "bad_request");
		}
		const fin = kids.find((k) => k.subagent && k.subagent.status !== "running");
		if (!argv["allow-prompt"]) skip("session.prompt on a finished subagent → bad_request", "pass --allow-prompt");
		else if (!fin) skip("session.prompt on a finished subagent → bad_request", "no finished subagent");
		else {
			const x = await C.request({ t: "session.prompt", sessionId: fin.sessionId, text: "conformance: are you there?" });
			expectFailure("session.prompt on a finished subagent → bad_request", "session.prompt", x, "bad_request");
		}
	} finally {
		C.close();
	}
});

// ---- session history (v1 addition; optional) ---------------------------------
// A hub that lists "history" in welcome.host.features answers sessions.past, session.transcript and
// session.resume. An older hub answers them with error bad_request: the checks are then SKIPped.
// Resuming a stored session starts a process on the computer: only with --allow-resume.

await step("session history", async () => {
	const has = hubFeatures.includes("history");
	if (!has) {
		const r = await A.request({ t: "sessions.past" });
		if (r?.t === "error" && r.code === "bad_request") return skip("session history", "hub does not list \"history\" in welcome.host.features (sessions.past → error bad_request)");
		return fail("no \"history\" feature → sessions.past error bad_request", describe(r));
	}
	pass("welcome.host.features lists \"history\"");
	const first = await A.request({ t: "sessions.past" });
	if (first?.t !== "sessions.past") return fail("sessions.past → sessions.past", describe(first));
	shape("sessions.past shape (every PastSession, newest first)", validateHubFrame(first), `${first.sessions?.length} session(s)${first.nextCursor ? " + cursor" : ""}${first.indexing ? " (indexing)" : ""}`);
	const list = Array.isArray(first.sessions) ? first.sessions : [];
	list.length <= 50 ? pass("sessions.past default limit ≤ 50", `${list.length}`) : fail("sessions.past default limit ≤ 50", `${list.length}`);

	// Live sessions are listed (live: true); live: true only for registered sessions.
	const liveIds = new Set(sessions.filter((x) => x?.kind !== "subagent").map((x) => x.sessionId));
	const wrongLive = list.filter((x) => x.live && !liveIds.has(x.sessionId));
	wrongLive.length ? warn("live: true only for sessions in sessions.list", wrongLive.map((x) => x.sessionId.slice(0, 8)).join(", ")) : pass("live: true only for sessions in sessions.list");
	const oldest = list.length ? list[list.length - 1].modifiedAt : Infinity;
	const missing = [...liveIds].filter((id) => !list.some((x) => x.sessionId === id) && (sessions.find((x) => x.sessionId === id)?.lastActivityAt ?? 0) > oldest + 60_000);
	missing.length ? warn("live sessions are listed (live: true)", `${missing.length} recent live session(s) not on the first page`) : pass("live sessions are listed (live: true)");

	// Paging: limit, cursors, no duplicates, newest first across pages.
	const seen = new Map();
	let cursor;
	let pages = 0;
	let prevOldest = Infinity;
	let pagingOk = true;
	do {
		const r = await A.request({ t: "sessions.past", limit: 20, ...(cursor ? { cursor } : {}) });
		if (r?.t !== "sessions.past") {
			fail(`sessions.past page ${pages + 1}`, describe(r));
			pagingOk = false;
			break;
		}
		const errs = validateHubFrame(r).errors;
		if (errs.length) {
			fail(`sessions.past page ${pages + 1} shape`, errs.slice(0, 3).join("; "));
			pagingOk = false;
		}
		if (r.sessions.length > 20) {
			fail("sessions.past honours limit", `${r.sessions.length} > 20`);
			pagingOk = false;
		}
		for (const x of r.sessions) {
			if (seen.has(x.sessionId)) {
				fail("sessions.past pages never repeat a session", x.sessionId);
				pagingOk = false;
			}
			if (x.modifiedAt > prevOldest + 1000) {
				warn("sessions.past pages continue newest-first", `${x.sessionId.slice(0, 8)} newer than the previous page`);
			}
			seen.set(x.sessionId, x);
		}
		if (r.sessions.length) prevOldest = r.sessions[r.sessions.length - 1].modifiedAt;
		if (r.nextCursor !== undefined && r.sessions.length === 0) {
			fail("sessions.past: a page with a cursor has sessions", "empty page with nextCursor");
			pagingOk = false;
			break;
		}
		cursor = r.nextCursor;
		pages++;
	} while (cursor && pages < 25);
	if (pagingOk) pass("sessions.past cursor paging (limit 20)", `${seen.size} session(s) in ${pages} page(s)${cursor ? " (stopped at 25)" : ", to the end"}`);

	// Search: a word of a title finds that session; every hit is newest-first and valid.
	const sample = [...seen.values()].find((x) => !x.live && x.title.split(/\s+/).some((w) => w.length >= 5));
	if (!sample) skip("sessions.past query", "no stored session with a searchable title");
	else {
		const word = sample.title.split(/\s+/).find((w) => w.length >= 5).replace(/[^\p{L}\p{N}-]/gu, "").slice(0, 12);
		let found = false;
		let qc;
		let n = 0;
		let shapeOk = true;
		do {
			const r = await A.request({ t: "sessions.past", query: word.toUpperCase(), limit: 50, ...(qc ? { cursor: qc } : {}) });
			if (r?.t !== "sessions.past") {
				fail("sessions.past query → sessions.past", describe(r));
				shapeOk = false;
				break;
			}
			if (validateHubFrame(r).errors.length) shapeOk = false;
			if (r.sessions.some((x) => x.sessionId === sample.sessionId)) found = true;
			qc = r.nextCursor;
			n++;
		} while (!found && qc && n < 10);
		if (shapeOk) pass("sessions.past query shape");
		found ? pass("sessions.past query is case-insensitive and matches titles", `"${word.toUpperCase()}"`) : fail("sessions.past query is case-insensitive and matches titles", `"${word.toUpperCase()}" did not return ${sample.sessionId}`);
		const none = await A.request({ t: "sessions.past", query: `zz-conformance-${randomBytes(6).toString("hex")}` });
		none?.t === "sessions.past" && none.sessions.length === 0 && !none.nextCursor ? pass("sessions.past query without matches → empty, no cursor") : fail("sessions.past query without matches → empty, no cursor", describe(none));
	}
	const withCwd = [...seen.values()].find((x) => x.cwd);
	if (withCwd) {
		const r = await A.request({ t: "sessions.past", cwd: withCwd.cwd, limit: 200 });
		if (r?.t !== "sessions.past") fail("sessions.past cwd filter", describe(r));
		else {
			const off = r.sessions.filter((x) => x.cwd !== withCwd.cwd);
			off.length ? fail("sessions.past cwd filter is exact", `${off.length} other cwd(s)`) : pass("sessions.past cwd filter is exact", `${r.sessions.length} in ${withCwd.cwd}`);
		}
	}

	// Transcripts of stored sessions: newest page, `before` paging, unknown ids.
	const stored = [...seen.values()].filter((x) => !x.live);
	// The longest one, so `before` paging has something to page.
	const t1 = [...stored].sort((a, b) => b.messageCount - a.messageCount)[0];
	if (!t1) skip("session.transcript (stored)", "no stored session");
	else {
		const r = await A.request({ t: "session.transcript", sessionId: t1.sessionId, limit: 10 });
		if (r?.t !== "session.transcript") fail("session.transcript (stored) → session.transcript", describe(r));
		else {
			shape("session.transcript shape", validateHubFrame(r), `${r.items.length} item(s) hasMore=${r.hasMore}`);
			r.sessionId === t1.sessionId ? pass("session.transcript.sessionId matches") : fail("session.transcript.sessionId matches", r.sessionId);
			r.items.length <= 10 ? pass("session.transcript honours limit") : fail("session.transcript honours limit", `${r.items.length}`);
			if (r.hasMore && r.items.length) {
				const older = await A.request({ t: "session.transcript", sessionId: t1.sessionId, before: r.items[0].id, limit: 10 });
				if (older?.t !== "session.transcript") fail("session.transcript before → older page", describe(older));
				else {
					const ids = new Set(r.items.map((it) => it.id));
					const dup = older.items.filter((it) => ids.has(it.id));
					dup.length ? fail("session.transcript before: no overlap", `${dup.length} repeated`) : pass("session.transcript before → older page, no overlap", `${older.items.length} item(s)`);
				}
			} else skip("session.transcript before", "first stored session fits in one page");
			if (r.items.length) {
				const bad = await A.request({ t: "session.transcript", sessionId: t1.sessionId, before: "conformance-no-such-item" });
				expectFailure("session.transcript unknown before → error not_found", "session.transcript", bad, "not_found");
			}
		}
	}
	const unknown = await A.request({ t: "session.transcript", sessionId: unknownSid });
	expectFailure("session.transcript unknown sessionId → error not_found", "session.transcript", unknown, "not_found");

	// A live session's transcript has the same item ids as its snapshot (resume swaps without dupes).
	const liveOne = sessions.find((x) => x?.kind !== "subagent" && x.status === "idle") ?? sessions.find((x) => x?.kind !== "subagent");
	if (!liveOne) skip("session.transcript of a live session matches its snapshot", "no live session");
	else {
		const [snap, tr] = await Promise.all([
			A.request({ t: "session.subscribe", sessionId: liveOne.sessionId, limit: 30 }),
			A.request({ t: "session.transcript", sessionId: liveOne.sessionId, limit: 30 }),
		]);
		A.send({ t: "session.unsubscribe", sessionId: liveOne.sessionId });
		if (snap?.t !== "session.snapshot" || tr?.t !== "session.transcript") fail("session.transcript of a live session", `${describe(snap)} / ${describe(tr)}`);
		else {
			const a = snap.items.map((it) => it.id);
			const b = tr.items.map((it) => it.id);
			const same = a.length === b.length && a.every((id, i) => id === b[i]);
			if (same) pass("session.transcript of a live session = its snapshot ids", `${a.length} item(s)`);
			else if (liveOne.status === "working") warn("session.transcript of a live session = its snapshot ids", "differs (the session is working)");
			else fail("session.transcript of a live session = its snapshot ids", `snapshot ${a.slice(-3).join(",")} vs transcript ${b.slice(-3).join(",")}`);
		}
	}

	// Resume: unknown → not_found; a live one acks at once with its id (no new session).
	const r0 = await A.request({ t: "session.resume", sessionId: unknownSid });
	expectFailure("session.resume unknown sessionId → ack ok:false not_found", "session.resume", r0, "not_found");
	if (liveOne) {
		const before = sessions.length;
		const r = await A.request({ t: "session.resume", sessionId: liveOne.sessionId }, 5_000);
		r?.t === "ack" && r.ok && r.sessionId === liveOne.sessionId
			? pass("session.resume of a live session → ack with its sessionId at once")
			: fail("session.resume of a live session → ack with its sessionId at once", describe(r));
		const now = await A.request({ t: "sessions.list" });
		if (now?.t === "sessions" && now.sessions.length > before + 1) warn("session.resume of a live session starts no process", `${before} → ${now.sessions.length} sessions`);
	}
	const unresumable = [...seen.values()].find((x) => !x.live && !x.resumable);
	const resumable = stored.find((x) => x.resumable);
	if (!argv["allow-resume"]) {
		skip("session.resume of a stored session", "pass --allow-resume (starts a phi process on the computer)");
		return;
	}
	// resumable is data only: resume ignores allowed roots, so a flagged session still resumes.
	if (unresumable) {
		const r = await A.request({ t: "session.resume", sessionId: unresumable.sessionId }, 45_000);
		if (r?.t === "ack" && r.ok && r.sessionId === unresumable.sessionId) {
			pass("session.resume of resumable:false still resumes (the flag never gates)");
			checkResumeAckCwd(r);
			await A.request({ t: "session.close", sessionId: unresumable.sessionId });
		} else warn("session.resume of resumable:false still resumes", `${describe(r)} (ok only for an unreadable session file)`);
	} else skip("session.resume of resumable:false", "no such session listed");

	if (!resumable) return skip("session.resume of a stored session", "no resumable stored session");
	const tr = await A.request({ t: "session.transcript", sessionId: resumable.sessionId, limit: 40 });
	const mark = A.mark();
	const [ra, rb] = await Promise.all([
		A.request({ t: "session.resume", sessionId: resumable.sessionId }, 45_000),
		A.request({ t: "session.resume", sessionId: resumable.sessionId }, 45_000),
	]);
	if (ra?.t !== "ack" || !ra.ok || ra.sessionId !== resumable.sessionId) return fail("session.resume of a stored session → ack with the same sessionId", describe(ra));
	pass("session.resume of a stored session → ack with the same sessionId", resumable.sessionId);
	checkResumeAckCwd(ra);
	rb?.t === "ack" && rb.ok && rb.sessionId === ra.sessionId ? pass("a second concurrent resume joins the first (same id)") : fail("a second concurrent resume joins the first (same id)", describe(rb));
	const up = await A.waitFor((f) => f?.t === "session.upsert" && f.session?.sessionId === resumable.sessionId, 5_000, mark);
	up ? pass("resumed session announced (session.upsert)") : warn("resumed session announced (session.upsert)", "no upsert within 5 s");
	const list2 = await A.request({ t: "sessions.list" });
	const copies = (list2?.sessions ?? []).filter((x) => x.sessionId === resumable.sessionId).length;
	copies === 1 ? pass("resumed session listed once in sessions.list") : fail("resumed session listed once in sessions.list", `${copies}`);
	const snap = await A.request({ t: "session.subscribe", sessionId: resumable.sessionId, limit: 40 });
	A.send({ t: "session.unsubscribe", sessionId: resumable.sessionId });
	if (snap?.t === "session.snapshot" && tr?.t === "session.transcript") {
		const ids = new Set(snap.items.map((it) => it.id));
		const lost = tr.items.filter((it) => !ids.has(it.id));
		lost.length ? fail("resumed snapshot keeps the stored item ids", `${lost.length} of ${tr.items.length} stored ids missing`) : pass("resumed snapshot keeps the stored item ids", `${tr.items.length} id(s)`);
	} else fail("session.subscribe after resume", describe(snap));
	const after = await A.request({ t: "sessions.past", limit: 200 });
	const entry = after?.sessions?.find((x) => x.sessionId === resumable.sessionId);
	entry?.live ? pass("sessions.past lists the resumed session as live") : warn("sessions.past lists the resumed session as live", entry ? "live: false" : "not on the first page");
	const closed = await A.request({ t: "session.close", sessionId: resumable.sessionId });
	closed?.t === "ack" && closed.ok ? pass("resumed (headless) session closes") : warn("resumed (headless) session closes", describe(closed));
});

// ---- Overseers (v1 addition) -------------------------------------------------
// A hub that lists "overseer" in welcome.host.features reports isOverseer / threadCounts on
// overseers and answers overseer.board. An older hub answers overseer.board with error
// bad_request (threads may still carry summary.overseer, an exo.11 field).

await step("overseers", async () => {
	const has = hubFeatures.includes("overseer");
	const listed = await A.request({ t: "sessions.list" });
	const live = Array.isArray(listed?.sessions) ? listed.sessions : sessions;
	const linked = live.filter((x) => x?.overseer?.sessionId);
	if (linked.length) {
		const self = linked.filter((x) => x.overseer.sessionId === x.sessionId);
		self.length ? fail("summary.overseer never names the session itself", self.map((x) => x.sessionId.slice(0, 8)).join(", ")) : pass("summary.overseer never names the session itself", `${linked.length} thread(s) linked`);
	}
	if (!has) {
		const any = live.find((x) => x?.isOverseer || x?.threadCounts);
		any ? warn("no \"overseer\" feature → no isOverseer / threadCounts", `${any.sessionId.slice(0, 8)} has them`) : pass("no \"overseer\" feature → no isOverseer / threadCounts");
		const r = await A.request({ t: "overseer.board", sessionId: linked[0]?.overseer.sessionId ?? "conformance-none" });
		if (r?.t === "error" && r.code === "bad_request") return skip("overseers", "hub does not list \"overseer\" in welcome.host.features (overseer.board → error bad_request)");
		return fail("no \"overseer\" feature → overseer.board error bad_request", describe(r));
	}
	pass("welcome.host.features lists \"overseer\"");
	const unknown = await A.request({ t: "overseer.board", sessionId: `conformance-${randomBytes(4).toString("hex")}` });
	expectFailure("overseer.board unknown overseer → error not_found", "overseer.board", unknown, "not_found");
	const noId = await A.request({ t: "overseer.board" });
	expectFailure("overseer.board without sessionId → error bad_request", "overseer.board", noId, "bad_request");
	// isOverseer: every session a live thread names (that is itself live) is an overseer.
	const byId = new Map(live.map((x) => [x.sessionId, x]));
	const named = [...new Set(linked.map((x) => x.overseer.sessionId))].filter((id) => byId.has(id));
	const notMarked = named.filter((id) => byId.get(id).isOverseer !== true);
	notMarked.length ? fail("a live overseer named by a live thread has isOverseer", notMarked.map((id) => id.slice(0, 8)).join(", ")) : named.length ? pass("a live overseer named by a live thread has isOverseer", `${named.length}`) : skip("a live overseer named by a live thread has isOverseer", "no live thread names a live overseer");
	// PastSession.overseer: a stored thread names its overseer (history hubs only).
	if (hubFeatures.includes("history")) {
		const past = await A.request({ t: "sessions.past", limit: 200 });
		const rows = Array.isArray(past?.sessions) ? past.sessions : [];
		const threads = rows.filter((x) => x.overseer);
		threads.length ? pass("sessions.past carries PastSession.overseer", `${threads.length} thread(s) on the first page`) : skip("sessions.past carries PastSession.overseer", "no thread on the first page");
		const self = threads.filter((x) => x.overseer.sessionId === x.sessionId);
		if (self.length) fail("PastSession.overseer never names the session itself", self.map((x) => x.sessionId.slice(0, 8)).join(", "));
	}
	const overseers = live.filter((x) => x?.isOverseer === true);
	if (!overseers.length) return skip("overseer.board", "no live overseer on this hub");
	for (const o of overseers.slice(0, 3)) {
		const tag = o.sessionId.slice(0, 8);
		const b = await A.request({ t: "overseer.board", sessionId: o.sessionId });
		if (b?.t === "error" && b.code === "internal") {
			warn(`overseer.board ${tag}`, `internal (corrupt registry?): ${b.message}`);
			continue;
		}
		if (b?.t !== "overseer.board") {
			fail(`overseer.board ${tag} → overseer.board`, describe(b));
			continue;
		}
		shape(`overseer.board ${tag} shape`, validateHubFrame(b), `${b.threads.length} thread(s)`);
		b.sessionId === o.sessionId ? pass(`overseer.board ${tag} echoes sessionId`) : fail(`overseer.board ${tag} echoes sessionId`, `${b.sessionId}`);
		const threads = Array.isArray(b.threads) ? b.threads : [];
		// Registry order (createdAt ascending); live threads the registry does not list yet follow.
		let ordered = true;
		for (let i = 1; i < threads.length; i++) if (threads[i].createdAt < threads[i - 1].createdAt && threads[i].state !== "running") ordered = false;
		ordered ? pass(`overseer.board ${tag} in registry order`) : warn(`overseer.board ${tag} in registry order`, "createdAt not ascending");
		// live matches sessions.list
		const liveWrong = threads.filter((t) => t.live !== byId.has(t.sessionId) && !(t.live === false && byId.get(t.sessionId)?.kind === "subagent"));
		liveWrong.length ? warn(`overseer.board ${tag}: live == listed in sessions.list`, liveWrong.map((t) => `${t.name}:${t.live}`).join(", ")) : pass(`overseer.board ${tag}: live == listed in sessions.list`);
		// Every live thread naming this overseer is on the board.
		const missing = linked.filter((x) => x.overseer.sessionId === o.sessionId && !threads.some((t) => t.sessionId === x.sessionId));
		missing.length ? fail(`overseer.board ${tag} lists its live threads`, missing.map((x) => x.sessionId.slice(0, 8)).join(", ")) : pass(`overseer.board ${tag} lists its live threads`);
		// threadCounts agree with the board (phi's hub: live status beats registry state).
		if (o.threadCounts) {
			const c = { total: 0, working: 0, idle: 0, error: 0, exited: 0, closed: 0 };
			for (const t of threads) {
				c.total += 1;
				if (!t.live) c[t.state === "closed" ? "closed" : "exited"] += 1;
				else if (t.status === "working") c.working += 1;
				else if (t.lastError) c.error += 1;
				else c.idle += 1;
			}
			const same = Object.keys(c).every((k) => c[k] === o.threadCounts[k]);
			same ? pass(`threadCounts of ${tag} agree with its board`, JSON.stringify(c)) : o.threadCounts.total === c.total ? warn(`threadCounts of ${tag} agree with its board`, `board ${JSON.stringify(c)} vs summary ${JSON.stringify(o.threadCounts)} (a thread may have just changed)`) : fail(`threadCounts of ${tag} agree with its board`, `board ${JSON.stringify(c)} vs summary ${JSON.stringify(o.threadCounts)}`);
		} else warn(`overseer ${tag} reports threadCounts`, "isOverseer without threadCounts");
	}
});


/** Resume ack extras: `cwd` is a non-empty string when present; `cwdFallback: true` needs `cwd`. */
function checkResumeAckCwd(r) {
	if (r?.cwd === undefined && r?.cwdFallback === undefined) return;
	const ok = (r.cwd === undefined || (typeof r.cwd === "string" && r.cwd.length > 0)) && (r.cwdFallback === undefined || (r.cwdFallback === true && typeof r.cwd === "string" && r.cwd.length > 0));
	ok ? pass("resume ack cwd / cwdFallback well formed", r.cwdFallback ? `fell back to ${r.cwd}` : r.cwd) : fail("resume ack cwd / cwdFallback well formed", describe(r));
}

// ---- unknown session ids --------------------------------------------------

await step("unknown sessionId", async () => {
	const reqs = [
		{ t: "session.subscribe", sessionId: unknownSid },
		{ t: "session.history", sessionId: unknownSid, before: "x" },
		{ t: "models.list", sessionId: unknownSid },
		{ t: "session.prompt", sessionId: unknownSid, text: "conformance: should not be delivered" },
		{ t: "session.abort", sessionId: unknownSid },
		{ t: "session.setModel", sessionId: unknownSid, provider: "anthropic", modelId: "x" },
		{ t: "session.setThinking", sessionId: unknownSid, level: "low" },
		{ t: "session.close", sessionId: unknownSid },
	];
	const replies = await Promise.all(reqs.map((f) => A.request(f)));
	reqs.forEach((f, i) => {
		const how = ACK_REQUESTS.has(f.t) ? "ack ok:false" : "error";
		expectFailure(`${f.t} unknown sessionId → ${how} not_found`, f.t, replies[i], "not_found");
	});
});

// ---- snapshots + history paging -------------------------------------------

const subscribed = new Set();
await step("session.subscribe / history", async () => {
	if (!sessions.length) return skip("session.subscribe → snapshot", "no sessions");
	const order = [...sessions].sort((a, b) => (a.sessionId === argv.session ? -1 : b.sessionId === argv.session ? 1 : 0)).slice(0, 6);
	const LIMIT = 20;
	let paging = null;
	for (const s of order) {
		const r = await A.request({ t: "session.subscribe", sessionId: s.sessionId, limit: LIMIT });
		if (r?.t !== "session.snapshot") {
			fail(`session.subscribe ${s.sessionId.slice(0, 8)} → session.snapshot`, describe(r));
			continue;
		}
		subscribed.add(s.sessionId);
		const ok = shape(`session.snapshot ${s.sessionId.slice(0, 8)} shape (+ every TranscriptItem)`, validateHubFrame(r), `${r.items?.length} items, hasMore=${r.hasMore}, state=${r.state?.status}`);
		if (r.sessionId !== s.sessionId) fail(`snapshot.sessionId matches`, `${r.sessionId} vs ${s.sessionId}`);
		if (Array.isArray(r.items) && r.items.length > LIMIT) fail(`snapshot honours limit ${LIMIT}`, `${r.items.length} items`);
		if (Array.isArray(r.items) && r.items.length < LIMIT && r.hasMore === true) warn(`snapshot ${s.sessionId.slice(0, 8)} hasMore with < limit items`, `${r.items.length}`);
		if (ok && r.hasMore && !paging && r.items.length) paging = { s, snap: r };
	}
	if (!paging) return skip("history paging", `no session with more than ${LIMIT} items`);
	const sid = paging.s.sessionId;
	const tag = sid.slice(0, 8);
	const startMark = A.mark();

	// default limit (120) snapshot for the same session
	const full = await A.request({ t: "session.subscribe", sessionId: sid });
	// default limit 120 (clarification 4)
	if (full?.t === "session.snapshot" && Array.isArray(full.items)) {
		if (full.items.length > 120) fail("snapshot default limit = 120", `${full.items.length} items`);
		else if (full.hasMore && full.items.length !== 120) fail("snapshot default limit = 120", `${full.items.length} items with hasMore`);
		else pass("snapshot default limit = 120", `${full.items.length} items, hasMore=${full.hasMore}`);
	} else fail("session.subscribe (no limit) → session.snapshot", describe(full));

	const seen = new Map(paging.snap.items.map((it, i) => [it.id, i]));
	let oldest = paging.snap.items[0];
	let oldestTs = Math.min(...paging.snap.items.map((it) => it.ts));
	const PAGE = 50;
	const pages = [];
	let errors = [];
	let warns = [];
	let done = false;
	for (let n = 0; n < 60; n++) {
		const h = await A.request({ t: "session.history", sessionId: sid, before: oldest.id, limit: PAGE });
		if (h?.t !== "session.history") {
			errors.push(`page ${n}: ${describe(h)}`);
			break;
		}
		const out = validateHubFrame(h);
		errors.push(...out.errors.map((e) => `page ${n}: ${e}`));
		if (h.sessionId !== sid) errors.push(`page ${n}: sessionId ${h.sessionId}`);
		if (!Array.isArray(h.items)) break;
		if (h.items.length > PAGE) errors.push(`page ${n}: ${h.items.length} items > limit ${PAGE}`);
		for (const it of h.items) {
			if (seen.has(it.id)) errors.push(`page ${n}: duplicate item ${it.id}`);
			if (typeof it.ts === "number" && it.ts > oldestTs) warns.push(`page ${n}: item ${it.id} ts ${it.ts} newer than previously oldest ${oldestTs}`);
		}
		if (h.items.length === 0 && h.hasMore) errors.push(`page ${n}: 0 items but hasMore=true`);
		if (h.hasMore && h.items.length < PAGE) warns.push(`page ${n}: hasMore with ${h.items.length} < ${PAGE} items`);
		h.items.forEach((it) => seen.set(it.id, -1));
		pages.unshift(h.items);
		if (h.items.length) {
			oldest = h.items[0];
			oldestTs = Math.min(oldestTs, ...h.items.map((it) => it.ts).filter((x) => typeof x === "number"));
		}
		if (!h.hasMore || !h.items.length) {
			done = true;
			// past the start must be empty
			if (h.items.length) {
				const tail = await A.request({ t: "session.history", sessionId: sid, before: oldest.id, limit: PAGE });
				if (tail?.t === "session.history" && Array.isArray(tail.items) && tail.items.length)
					errors.push(`hasMore=false but before=${oldest.id} still returned ${tail.items.length} items`);
				else if (tail && tail.t !== "session.history") warns.push(`before=<first item> → ${describe(tail)}`);
			}
			break;
		}
	}
	const total = pages.reduce((n, p) => n + p.length, 0) + paging.snap.items.length;
	if (errors.length) fail(`history paging ${tag} (before → strictly older, no dupes, hasMore consistent)`, errors.slice(0, 6).join("; "));
	else pass(`history paging ${tag} (before → strictly older, no dupes, hasMore consistent)`, `${pages.length} page(s), ${total} items total${done ? ", reached start" : ", stopped at page cap"}`);
	if (warns.length) warn(`history paging ${tag} hints`, dedupe(warns).slice(0, 4).join("; "));

	// contiguity: [pages..., snap20] tail must equal the default snapshot (if nothing changed meanwhile)
	const changed = A.frames.slice(startMark).some((x) => x.f?.t === "session.event" && x.f.sessionId === sid && x.f.event?.type === "item.upsert");
	if (full?.t === "session.snapshot" && Array.isArray(full.items) && !changed) {
		const joined = [...pages.flat(), ...paging.snap.items].map((it) => it.id);
		const want = full.items.map((it) => it.id);
		const got = joined.slice(-want.length);
		if (JSON.stringify(got) === JSON.stringify(want)) pass(`history pages + snapshot are contiguous ${tag}`, `last ${want.length} ids match default snapshot`);
		else fail(`history pages + snapshot are contiguous ${tag}`, "joined history does not match the default snapshot (gap or reorder)");
	} else skip(`history pages + snapshot are contiguous ${tag}`, "session changed during paging");

	// history without limit → default 120
	if (full?.t === "session.snapshot" && full.items?.length) {
		const newest = full.items[full.items.length - 1];
		const h = await A.request({ t: "session.history", sessionId: sid, before: newest.id });
		if (h?.t !== "session.history" || !Array.isArray(h.items)) fail("session.history default limit = 120", describe(h));
		else if (h.items.length > 120 || (h.hasMore && h.items.length !== 120)) fail("session.history default limit = 120", `${h.items.length} items, hasMore=${h.hasMore}`);
		else pass("session.history default limit = 120", `${h.items.length} items, hasMore=${h.hasMore}`);
	}

	// unknown before → error not_found (clarification 4)
	const u = await A.request({ t: "session.history", sessionId: sid, before: `missing-${randomBytes(4).toString("hex")}` }, 5000);
	expectFailure("session.history unknown before → error not_found", "session.history", u, "not_found");

	// limit above the 500 cap is clamped, not rejected (clarification 4)
	let capSeen = null;
	const capErrs = [];
	for (const s of order) {
		const r = await A.request({ t: "session.subscribe", sessionId: s.sessionId, limit: 1000 }, Math.max(T, 30_000));
		if (r?.t !== "session.snapshot" || !Array.isArray(r.items)) {
			capErrs.push(`subscribe ${s.sessionId.slice(0, 8)} limit 1000: ${describe(r)}`);
			continue;
		}
		subscribed.add(s.sessionId);
		if (r.items.length > 500) capErrs.push(`subscribe ${s.sessionId.slice(0, 8)}: ${r.items.length} items > 500`);
		else if (r.hasMore && r.items.length !== 500) capErrs.push(`subscribe ${s.sessionId.slice(0, 8)}: ${r.items.length} items with hasMore (expected 500)`);
		else if (r.hasMore && !capSeen) capSeen = { s, snap: r };
	}
	if (capErrs.length) fail("session.subscribe limit 1000 → clamped to 500", capErrs.slice(0, 4).join("; "));
	else pass("session.subscribe limit 1000 → clamped to 500", capSeen ? `cap hit on ${capSeen.s.sessionId.slice(0, 8)}` : "no session has > 500 items (cap not exercised)");
	if (capSeen) {
		const newest = capSeen.snap.items[capSeen.snap.items.length - 1];
		const h = await A.request({ t: "session.history", sessionId: capSeen.s.sessionId, before: newest.id, limit: 1000 }, Math.max(T, 30_000));
		if (h?.t !== "session.history" || !Array.isArray(h.items)) fail("session.history limit 1000 → clamped to 500", describe(h));
		else if (h.items.length > 500 || (h.hasMore && h.items.length !== 500)) fail("session.history limit 1000 → clamped to 500", `${h.items.length} items, hasMore=${h.hasMore}`);
		else pass("session.history limit 1000 → clamped to 500", `${h.items.length} items, hasMore=${h.hasMore}`);
	} else skip("session.history limit 1000 → clamped to 500", "no session with > 500 items");
});

// ---- unsubscribe -----------------------------------------------------------

await step("session.unsubscribe", async () => {
	const working = sessions.find((s) => s.status === "working" && s.sessionId !== argv.session);
	if (working && !subscribed.has(working.sessionId)) {
		await A.request({ t: "session.subscribe", sessionId: working.sessionId, limit: 5 });
		subscribed.add(working.sessionId);
	}
	if (working) await A.waitFor((f) => f?.t === "session.event" && f.sessionId === working.sessionId, 4000);
	for (const sid of subscribed) A.send({ t: "session.unsubscribe", sessionId: sid });
	await new Promise((r) => setTimeout(r, 500));
	const m = A.mark();
	await new Promise((r) => setTimeout(r, 2500));
	const leaked = A.frames.slice(m).filter((x) => x.f?.t === "session.event" && subscribed.has(x.f.sessionId));
	if (leaked.length) fail("session.unsubscribe stops session.event", `${leaked.length} event(s) after unsubscribe`);
	else pass("session.unsubscribe stops session.event", working ? `watched working session ${working.sessionId.slice(0, 8)}` : "no working session (weak check)");
	subscribed.clear();
});

// ---- second client + prompt flow ------------------------------------------

let B;
await step("second client", async () => {
	// B omits hello.protocol: absent is accepted as 1 (clarification 1)
	const { cl, welcome } = await connect("B", token, { protocol: undefined });
	B = cl;
	if (welcome?.t === "welcome") pass("second concurrent connection, hello without protocol → welcome");
	else fail("second concurrent connection, hello without protocol → welcome", B.closeInfo ? `closed ${B.closeInfo.code}` : describe(welcome));
});

async function fanout(sid, markA, markB, timeout) {
	const pred = (f) => f?.t === "session.upsert" && f.session?.sessionId === sid;
	const [a, b] = await Promise.all([A.waitFor(pred, timeout, markA), B ? B.waitFor(pred, timeout, markB) : null]);
	return { a, b };
}

let target = null;
let spawned = null;
/** Close a session a broken hub spawned when it should have refused. */
async function closeIfSpawned(r) {
	if (r?.t === "ack" && r.ok === true && typeof r.sessionId === "string") {
		const cr = await A.request({ t: "session.close", sessionId: r.sessionId });
		console.log(c(90, `      (closed wrongly spawned session ${r.sessionId}: ${describe(cr)})`));
	}
}

if (argv["spawn-cwd"]) {
	await step("session.spawn", async () => {
		const ma = A.mark();
		const mb = B?.mark() ?? 0;
		const t0 = Date.now();
		// the hub acks only after the child registered (hub-side timeout 30 s), clarification 6
		const r = await A.request({ t: "session.spawn", cwd: argv["spawn-cwd"] }, Math.max(T, 45_000));
		const dt = Date.now() - t0;
		if (!(r?.t === "ack" && r.ok === true && typeof r.sessionId === "string")) return fail("session.spawn → ack { ok, sessionId }", describe(r));
		pass("session.spawn → ack { ok, sessionId }", `${r.sessionId} after ${dt} ms`);
		spawned = target = r.sessionId;
		const l = await A.request({ t: "sessions.list" });
		if (l?.sessions?.some((s) => s.sessionId === r.sessionId)) pass("session.spawn ack only after the child registered", "listed in sessions.list right after the ack");
		else fail("session.spawn ack only after the child registered", `not in sessions.list right after the ack: ${describe(l)}`);
		const { a, b } = await fanout(r.sessionId, ma, mb, 30_000);
		if (!a) return fail("spawned session announced via session.upsert", "none within 30 s");
		const ackIdx = A.frames.findIndex((x, i) => i >= ma && x.f === r);
		const upIdx = A.frames.findIndex((x, i) => i >= ma && x.f === a);
		pass("spawned session announced via session.upsert", `kind=${a.session.kind} cwd=${a.session.cwd}; upsert ${upIdx < ackIdx ? "before" : "after"} the ack`);
		if (a.session.kind !== "headless") fail("spawned session kind = headless", a.session.kind);
		else pass("spawned session kind = headless");
		const real = (p) => {
			try {
				return fs.realpathSync(p);
			} catch {
				return p;
			}
		};
		if (real(a.session.cwd) === real(argv["spawn-cwd"])) pass("spawned session cwd matches");
		else warn("spawned session cwd matches", `${a.session.cwd} vs ${argv["spawn-cwd"]}`);
		if (B) b ? pass("fan-out: spawn upsert reached both clients") : fail("fan-out: spawn upsert reached both clients", "client B got none");
	});
	// spawn error codes (clarification 6)
	await step("session.spawn errors", async () => {
		const missing = path.join(argv["spawn-cwd"], `conformance-missing-${randomBytes(4).toString("hex")}`);
		const r1 = await A.request({ t: "session.spawn", cwd: missing }, Math.max(T, 45_000));
		expectFailure("session.spawn nonexistent cwd → ack ok:false bad_request", "session.spawn", r1, "bad_request");
		await closeIfSpawned(r1);
		const outside = argv["spawn-outside-cwd"];
		const r2 = await A.request({ t: "session.spawn", cwd: outside }, Math.max(T, 45_000));
		expectFailure(`session.spawn cwd outside allowed roots (${outside}) → ack ok:false forbidden`, "session.spawn", r2, "forbidden");
		await closeIfSpawned(r2);
		const r3 = await A.request({ t: "session.spawn", cwd: argv["spawn-cwd"], provider: "conformance", modelId: "bogus" }, Math.max(T, 45_000));
		expectFailure("session.spawn unknown model → ack ok:false not_found", "session.spawn", r3, "not_found");
		await closeIfSpawned(r3);
		// thinkingLevel (a later addition): one of models.list thinkingLevels; older hubs ignore it
		const r4 = await A.request({ t: "session.spawn", cwd: argv["spawn-cwd"], thinkingLevel: "conformance-bogus" }, Math.max(T, 45_000));
		if (r4?.t === "ack" && r4.ok === true) warn("session.spawn invalid thinkingLevel → ack ok:false bad_request", "hub ignores thinkingLevel (predates the field)");
		else expectFailure("session.spawn invalid thinkingLevel → ack ok:false bad_request", "session.spawn", r4, "bad_request");
		await closeIfSpawned(r4);
		// Overseers (v1 addition): name = one non-blank line of at most 200 characters.
		if (hubFeatures.includes("overseer")) {
			const r5 = await A.request({ t: "session.spawn", cwd: argv["spawn-cwd"], name: "two\nlines" }, Math.max(T, 45_000));
			expectFailure("session.spawn name with a newline → ack ok:false bad_request", "session.spawn", r5, "bad_request");
			await closeIfSpawned(r5);
			const name = `Overseer · conformance ${randomBytes(3).toString("hex")}`;
			const since = A.frames.length;
			const r6 = await A.request({ t: "session.spawn", cwd: argv["spawn-cwd"], name }, Math.max(T, 45_000));
			if (r6?.t === "ack" && r6.ok === true && r6.sessionId) {
				const up = await A.waitFor((f) => f?.t === "session.upsert" && f.session?.sessionId === r6.sessionId, 10_000, since);
				const l = await A.request({ t: "sessions.list" });
				const got = l?.sessions?.find((x) => x.sessionId === r6.sessionId)?.name ?? up?.session?.name;
				got === name ? pass("session.spawn name → the session's name", name) : fail("session.spawn name → the session's name", `${JSON.stringify(got)} vs ${JSON.stringify(name)}`);
				const cl = await A.request({ t: "session.close", sessionId: r6.sessionId });
				if (!(cl?.t === "ack" && cl.ok)) warn("close the named spawned session", describe(cl));
			} else fail("session.spawn with name → ack ok", describe(r6));
		}
	});
} else if (argv.session) target = argv.session;

if (!argv["allow-prompt"]) {
	skip("prompt / steer / abort flow", "pass --allow-prompt");
} else if (!target) {
	skip("prompt / steer / abort flow", "needs --session or --spawn-cwd");
} else {
	await step("prompt flow", async () => {
		const tag = target.slice(0, 8);
		const snap = await A.request({ t: "session.subscribe", sessionId: target, limit: 10 });
		if (snap?.t !== "session.snapshot") return fail(`subscribe target ${tag}`, describe(snap));
		subscribed.add(target);
		let status = snap.state?.status;
		if (status === "working" && !argv.steer) {
			const idle = await A.waitFor((f) => f?.t === "session.event" && f.sessionId === target && f.event?.type === "state" && f.event.state?.status === "idle", 30_000);
			if (idle) status = "idle";
		}

		// model / thinking (no-op changes to current values)
		const models = await A.request({ t: "models.list", sessionId: target });
		if (models?.t === "models") {
			if (models.thinkingLevel) {
				const r = await A.request({ t: "session.setThinking", sessionId: target, level: models.thinkingLevel });
				r?.t === "ack" && r.ok ? pass("session.setThinking (current level) → ack ok", models.thinkingLevel) : fail("session.setThinking (current level) → ack ok", describe(r));
			} else skip("session.setThinking", "models.thinkingLevel absent");
			const bad = await A.request({ t: "session.setThinking", sessionId: target, level: "conformance-bogus" });
			expectFailure("session.setThinking invalid level → ack ok:false bad_request", "session.setThinking", bad, "bad_request");
			if (models.current) {
				const r = await A.request({ t: "session.setModel", sessionId: target, provider: models.current.provider, modelId: models.current.id });
				r?.t === "ack" && r.ok ? pass("session.setModel (current model) → ack ok", `${models.current.provider}/${models.current.id}`) : fail("session.setModel (current model) → ack ok", describe(r));
			} else skip("session.setModel", "models.current absent");
			const bm = await A.request({ t: "session.setModel", sessionId: target, provider: "conformance", modelId: "bogus" });
			expectFailure("session.setModel unknown model → ack ok:false not_found", "session.setModel", bm, "not_found");
		} else fail("models.list (target) → models", describe(models));

		const badMode = await A.request({ t: "session.prompt", sessionId: target, text: "conformance: must be rejected", mode: "bogus" });
		expectFailure("session.prompt bad mode → ack ok:false bad_request", "session.prompt", badMode, "bad_request");
		// image mimeType outside image/jpeg|png|webp|gif → bad_request (clarification 15)
		const badImg = await A.request({
			t: "session.prompt",
			sessionId: target,
			text: "conformance: must be rejected (bad image type)",
			images: [{ mimeType: "image/bmp", data: "Qk0eAAAAAAAAABoAAAAMAAAAAQABAAEAGAAAAP8A" }],
		});
		expectFailure("session.prompt image/bmp → ack ok:false bad_request", "session.prompt", badImg, "bad_request");

		const marker = `phi-remote conformance ${randomBytes(3).toString("hex")}: reply with the single word OK`;
		const ma = A.mark();
		// latest known status right before prompting (the session may have changed since the snapshot)
		for (const { f } of A.frames.slice(0, ma)) if (f?.t === "session.event" && f.sessionId === target && f.event?.type === "state") status = f.event.state?.status ?? status;
		const mb = B?.mark() ?? 0;
		const prompt = { t: "session.prompt", sessionId: target, text: marker };
		if (argv["prompt-image"])
			prompt.images = [{ mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }];
		const ack = await A.request(prompt);
		if (!(ack?.t === "ack" && ack.ok)) return fail(`session.prompt → ack ok (${status})`, describe(ack));
		pass(`session.prompt → ack ok`, `session was ${status}`);
		const user = await A.waitFor((f) => f?.t === "session.event" && f.sessionId === target && f.event?.type === "item.upsert" && f.event.item?.kind === "user" && String(f.event.item.text).includes(marker), T, ma);
		if (user) pass("prompt → item.upsert user item", `id=${user.event.item.id}`);
		else (status === "idle" ? fail : warn)("prompt → item.upsert user item", status === "idle" ? "not seen" : "not seen (steer into a working session may be delivered later)");
		if (argv["prompt-image"] && user) user.event.item.images === 1 ? pass("prompt image → user item images:1") : fail("prompt image → user item images:1", `images=${user.event.item.images}`);
		if (status === "idle") {
			const st = await A.waitFor((f) => f?.t === "session.event" && f.sessionId === target && f.event?.type === "state" && f.event.state?.status === "working", T, ma);
			st ? pass("prompt → state working") : fail("prompt → state working", "no state event");
		}
		const { a, b } = await fanout(target, ma, mb, T);
		if (a && b) pass("fan-out: session.upsert reached both clients", `status=${a.session.status}/${b.session.status}`);
		else fail("fan-out: session.upsert reached both clients", `A:${!!a} B:${!!b}`);
		const asst = await A.waitFor((f) => f?.t === "session.event" && f.sessionId === target && f.event?.type === "item.upsert" && f.event.item?.kind === "assistant", 15_000, ma);
		asst ? pass("assistant item streamed", asst.event.item.streaming ? "streaming:true" : "") : warn("assistant item streamed", "none within 15 s");

		const mAbort = A.mark();
		// latest version of every target item seen since the prompt, up to `end`
		const latestItems = (from, end) => {
			const m = new Map();
			for (const { f } of A.frames.slice(from, end))
				if (f?.t === "session.event" && f.sessionId === target && f.event?.type === "item.upsert" && f.event.item?.id) m.set(f.event.item.id, f.event.item);
			return m;
		};
		const streamingBefore = [...latestItems(ma, mAbort).values()].filter((it) => it.kind === "assistant" && it.streaming === true).map((it) => it.id);
		const ab = await A.request({ t: "session.abort", sessionId: target });
		if (!(ab?.t === "ack" && ab.ok)) fail("session.abort → ack ok", describe(ab));
		else pass("session.abort → ack ok");
		const idle = await A.waitFor((f) => f?.t === "session.event" && f.sessionId === target && f.event?.type === "state" && f.event.state?.status === "idle", T, mAbort);
		idle ? pass("abort → state idle") : fail("abort → state idle", "no idle state event");
		const up = await A.waitFor((f) => f?.t === "session.upsert" && f.session?.sessionId === target && f.session.status === "idle", 5000, mAbort);
		up ? pass("abort → session.upsert status idle") : fail("abort → session.upsert status idle", "none within 5 s");
		// transcript effect (clarification 9): nothing left streaming/running; the streaming assistant item gets error "aborted"
		await new Promise((r) => setTimeout(r, 500));
		const after = latestItems(ma);
		const stuck = [...after.values()].filter((it) => (it.kind === "assistant" && it.streaming === true) || (it.kind === "tool" && it.status === "running"));
		stuck.length
			? fail("abort leaves no streaming assistant / running tool item", stuck.map((it) => `${it.kind} ${it.id}`).join(", "))
			: pass("abort leaves no streaming assistant / running tool item", `${after.size} item(s) checked`);
		if (streamingBefore.length) {
			const errs = streamingBefore.map((id) => after.get(id)).filter((it) => it?.error === "aborted");
			errs.length
				? pass('abort → streaming assistant item error: "aborted"', errs.map((it) => it.id).join(", "))
				: warn('abort → streaming assistant item error: "aborted"', "the streaming item finished without error (turn may have ended before the abort landed)");
		} else skip('abort → streaming assistant item error: "aborted"', "no assistant item was streaming at abort time");
		// abort on an idle session → ack ok:true, no-op (clarification 9)
		const mIdle = A.mark();
		const ab2 = await A.request({ t: "session.abort", sessionId: target });
		ab2?.t === "ack" && ab2.ok === true ? pass("session.abort while idle → ack ok:true") : fail("session.abort while idle → ack ok:true", describe(ab2));
		await new Promise((r) => setTimeout(r, 1000));
		const touched = [...latestItems(mIdle).values()].filter((it) => it.error === "aborted" || (it.kind === "tool" && it.status === "error"));
		touched.length
			? fail("session.abort while idle is a no-op", `${touched.length} item(s) changed: ${touched.map((it) => `${it.kind} ${it.id}`).join(", ")}`)
			: pass("session.abort while idle is a no-op", "no aborted items within 1 s");
	});
}

// ---- slash commands: /new replaces the session (v1 addition; optional) -------
// Only on the session this run spawned: /new on a user's session would end their thread.

const NEW_CHECK = "/new → reset { replacedBy } + session.remove { replacedBy } + session.upsert";
if (!spawned || !argv["allow-prompt"]) skip(NEW_CHECK, "needs --spawn-cwd and --allow-prompt");
else if (commandsSupported !== true) skip(NEW_CHECK, "hub predates slash commands");
else {
	await step("/new replacement", async () => {
		const old = spawned;
		const snap = await A.request({ t: "session.subscribe", sessionId: old, limit: 1 });
		if (snap?.t !== "session.snapshot") return fail(`subscribe ${old.slice(0, 8)} before /new`, describe(snap));
		subscribed.add(old);
		// let a running turn from the prompt flow settle
		await new Promise((r) => setTimeout(r, 300));
		const ma = A.mark();
		const mb = B?.mark() ?? 0;
		const ack = await A.request({ t: "session.prompt", sessionId: old, text: "/new" });
		if (!(ack?.t === "ack" && ack.ok)) return fail("session.prompt /new → ack ok", describe(ack));
		pass("session.prompt /new → ack ok");
		const reset = await A.waitFor((f) => f?.t === "session.event" && f.sessionId === old && f.event?.type === "reset", T, ma);
		const remove = await A.waitFor((f) => f?.t === "session.remove" && f.sessionId === old, reset?.event?.replacedBy ? T : 2000, ma);
		const replacedBy = reset?.event?.replacedBy ?? remove?.replacedBy;
		if (!replacedBy) return skip(NEW_CHECK, reset ? "reset without replacedBy (the hub keeps the session id)" : "no reset / remove with replacedBy");
		reset?.event?.replacedBy ? pass("/new → subscribers get reset { replacedBy }", replacedBy) : fail("/new → subscribers get reset { replacedBy }", describe(reset));
		if (replacedBy === old) fail("replacedBy is a new session id", replacedBy);
		remove?.replacedBy === replacedBy ? pass("/new → session.remove { sessionId: old, replacedBy: new }") : fail("/new → session.remove { sessionId: old, replacedBy: new }", describe(remove));
		const up = await A.waitFor((f) => f?.t === "session.upsert" && f.session?.sessionId === replacedBy, T, ma);
		if (!up) return fail("/new → session.upsert for the new id", "none");
		const idx = (f) => A.frames.findIndex((x, i) => i >= ma && x.f === f);
		pass("/new → session.upsert for the new id", `kind=${up.session.kind}`);
		if (reset && remove && !(idx(reset) < idx(remove) && idx(remove) < idx(up))) warn("/new frame order reset → remove → upsert", `got ${idx(reset)}, ${idx(remove)}, ${idx(up)}`);
		if (B) {
			const bRemove = await B.waitFor((f) => f?.t === "session.remove" && f.sessionId === old, T, mb);
			bRemove?.replacedBy === replacedBy ? pass("fan-out: session.remove { replacedBy } reached both clients") : fail("fan-out: session.remove { replacedBy } reached both clients", describe(bRemove));
		}
		const l = await A.request({ t: "sessions.list" });
		const ids = new Set((l?.sessions ?? []).map((x) => x.sessionId));
		ids.has(replacedBy) && !ids.has(old) ? pass("sessions.list has the new id, not the old one") : fail("sessions.list has the new id, not the old one", `new:${ids.has(replacedBy)} old:${ids.has(old)}`);
		const s2 = await A.request({ t: "session.subscribe", sessionId: replacedBy, limit: 5 });
		s2?.t === "session.snapshot" ? pass("subscribe to the new id → snapshot", `${s2.items?.length} item(s)`) : fail("subscribe to the new id → snapshot", describe(s2));
		subscribed.add(replacedBy);
		spawned = target = replacedBy; // closed below
	});
}

// ---- focus / push ---------------------------------------------------------

await step("focus", async () => {
	A.send({ t: "focus", sessionId: target ?? sessions[0]?.sessionId ?? null });
	A.send({ t: "focus", sessionId: null });
	const r = await A.request({ t: "ping" });
	r?.t === "pong" ? pass("focus (sessionId, then null) accepted silently") : fail("focus accepted silently", describe(r));
	const errs = A.frames.slice(-3).filter((x) => x.f?.t === "error" && !x.f.re);
	if (errs.length) warn("focus produced an error frame", describe(errs[0].f));
});

await step("push", async () => {
	const tok = randomBytes(32).toString("hex");
	const r = await A.request({ t: "push.register", apnsToken: tok, env: "sandbox", bundleId: "com.example.phiremote" });
	r?.t === "ack" && r.ok ? pass("push.register → ack ok") : fail("push.register → ack ok", describe(r));
	const bad = await A.request({ t: "push.register", apnsToken: tok, env: "staging", bundleId: "com.example.phiremote" });
	expectFailure("push.register bad env → ack ok:false bad_request", "push.register", bad, "bad_request");
	const u = await A.request({ t: "push.unregister" });
	u?.t === "ack" && u.ok ? pass("push.unregister → ack ok") : fail("push.unregister → ack ok", describe(u));
});

// ---- close ----------------------------------------------------------------

if (spawned) {
	await step("session.close", async () => {
		const ma = A.mark();
		const mb = B?.mark() ?? 0;
		const r = await A.request({ t: "session.close", sessionId: spawned });
		if (!(r?.t === "ack" && r.ok)) return fail("session.close (headless) → ack ok", describe(r));
		pass("session.close (headless) → ack ok");
		const pred = (f) => f?.t === "session.remove" && f.sessionId === spawned;
		const [a, b] = await Promise.all([A.waitFor(pred, T, ma), B?.waitFor(pred, T, mb)]);
		a ? pass("session.close → session.remove") : fail("session.close → session.remove", "not seen on A");
		if (B) b ? pass("fan-out: session.remove reached both clients") : fail("fan-out: session.remove reached both clients", "not seen on B");
		const l = await A.request({ t: "sessions.list" });
		if (l?.sessions?.some((s) => s.sessionId === spawned)) fail("closed session gone from sessions.list");
		else pass("closed session gone from sessions.list");
	});
}

if (argv["check-close-forbidden"]) {
	await step("session.close interactive", async () => {
		const inter = sessions.find((s) => s.kind === "interactive");
		if (!inter) return skip("session.close interactive → forbidden", "no interactive session");
		const r = await A.request({ t: "session.close", sessionId: inter.sessionId });
		expectFailure("session.close interactive → ack ok:false forbidden", "session.close", r, "forbidden");
	});
} else skip("session.close interactive → forbidden", "pass --check-close-forbidden");

// ---- rate limit ------------------------------------------------------------

if (argv["check-rate-limit"]) {
	// clarification 5: malformed body → 400 { error: "bad_request" }; every attempt counts toward
	// 5/min/IP; 429 body { error: "rate_limited" }
	await step("pair malformed body", async () => {
		for (const [what, body] of [
			["invalid JSON", "{conformance: not json"],
			["no code", { deviceName: "phi-remote conformance", platform: "ios" }],
		]) {
			const name = `POST /v1/pair malformed body (${what}) → 400 { error: "bad_request" }`;
			const r = await http("POST", "/v1/pair", body);
			if (r.status === 429) fail(name, "got 429 (rate limited — wait a minute and rerun)");
			else if (r.status !== 400) fail(name, `status ${r.status} ${r.text.slice(0, 120)}`);
			else shape(name, check(r.json, PairBadRequest, "pair400"));
		}
	});
	await step("pair rate limit", async () => {
		let got = null;
		for (let i = 1; i <= 7; i++) {
			const r = await http("POST", "/v1/pair", { code: randomCode(argv.code), deviceName: "conformance", platform: "ios" });
			if (r.status === 429) {
				got = { i, r };
				break;
			}
		}
		if (!got) return fail("POST /v1/pair rate limited → 429", "7 more attempts without 429");
		pass("POST /v1/pair rate limited → 429", `after ${got.i} more attempt(s)`);
		shape('429 body { error: "rate_limited" }', check(got.r.json, PairRateLimited, "pair429"));
		// this run's attempts within the last minute, the 429 one included; earlier runs only make it sooner
		const now = Date.now();
		const n = pairAttempts.filter((t) => now - t < 60_000).length;
		if (n > 6) fail("every pair attempt counts toward 5/min/IP", `429 only on attempt #${n} within a minute (good, bad and malformed attempts all count)`);
		else pass("every pair attempt counts toward 5/min/IP", `429 on attempt #${n} within a minute`);
	});
} else {
	skip("POST /v1/pair malformed body → 400", "pass --check-rate-limit (each attempt counts toward the limit)");
	skip("POST /v1/pair rate limited → 429", "pass --check-rate-limit (locks this IP out for ~1 min)");
}

if (argv["check-server-ping"]) {
	const left = 25_000 - (Date.now() - A.openedAt);
	if (left > 0) {
		console.log(c(90, `      (waiting ${Math.ceil(left / 1000)} s to observe server WS pings)`));
		await new Promise((r) => setTimeout(r, left));
	}
}

finish();

function finish() {
	const elapsed = Date.now() - STARTED;
	const A_open = A ? Date.now() - A.openedAt : 0;
	if (A_open >= 25_000) A.serverPings > 0 ? pass("hub sends WS pings (≤ 20 s)", `${A.serverPings} in ${Math.round(A_open / 1000)} s`) : fail("hub sends WS pings (≤ 20 s)", `none in ${Math.round(A_open / 1000)} s`);
	else skip("hub sends WS pings (≤ 20 s)", `connection only open ${Math.round(A_open / 1000)} s (< 25 s); ${A?.serverPings ?? 0} seen`);
	// tool item ts = call start, never changes (clarification 15)
	if (ledger.toolTsErrors.length) fail("tool item ts stable (= tool call start)", ledger.toolTsErrors.slice(0, 4).join("; "));
	else if (ledger.toolItems) pass("tool item ts stable (= tool call start)", `${ledger.toolItems} tool item(s) tracked`);
	// rates (clarification 11; original contract for streaming): state ≤ 4/s and session.upsert ≤ 2/s per
	// session (trailing edge); streaming item.upsert ≤ 8/s per item. One event of slack for jitter.
	const rates = { state: 0, upsert: 0, item: 0 };
	const worst = { state: "", upsert: "", item: "" };
	for (const cl of [A, B].filter(Boolean)) {
		const by = { state: new Map(), upsert: new Map(), item: new Map() };
		const add = (kind, key, at) => (by[kind].get(key) ?? by[kind].set(key, []).get(key)).push(at);
		for (const { at, f } of cl.frames) {
			if (f?.t === "session.upsert" && f.session?.sessionId) add("upsert", f.session.sessionId, at);
			else if (f?.t === "session.event" && f.event?.type === "state") add("state", f.sessionId, at);
			else if (f?.t === "session.event" && f.event?.type === "item.upsert" && f.event.item?.streaming === true) add("item", `${f.sessionId}/${f.event.item.id}`, at);
		}
		for (const kind of Object.keys(by))
			for (const [key, times] of by[kind]) {
				const n = maxInWindow(times);
				if (n > rates[kind]) {
					rates[kind] = n;
					worst[kind] = `${cl.label} ${key.slice(0, 8)}`;
				}
			}
	}
	const rateCheck = (kind, label, limit, strict) => {
		const detail = `max ${rates[kind]} in any 1 s${worst[kind] ? ` (${worst[kind]})` : ""}`;
		if (rates[kind] > limit + 1) (strict ? fail : warn)(label, detail);
		else pass(label, detail);
	};
	rateCheck("state", "state events ≤ 4/s per session", 4, true);
	rateCheck("upsert", "session.upsert ≤ 2/s per session", 2, true);
	rateCheck("item", "streaming item.upsert ≤ 8/s per item", 8, false);
	const types = Object.entries(ledger.byType).map(([t, n]) => `${t}×${n}`).join(" ");
	if (ledger.errors.length) fail(`every frame valid (${ledger.frames} frames)`, ledger.errors.slice(0, 10).join("; ") + (ledger.errors.length > 10 ? ` (+${ledger.errors.length - 10} more)` : ""));
	else pass(`every frame valid (${ledger.frames} frames)`, types);
	const w = dedupe(ledger.warnings);
	if (w.length) warn("frame hints / unknown fields", w.slice(0, 10).join("; ") + (w.length > 10 ? ` (+${w.length - 10} more)` : ""));
	A?.close();
	B?.close();
	const n = (s) => results.filter((r) => r.status === s).length;
	console.log(`\n${n("FAIL") ? c(31, "FAILED") : c(32, "OK")}  ${n("PASS")} passed, ${n("FAIL")} failed, ${n("WARN")} warnings, ${n("SKIP")} skipped  (${(elapsed / 1000).toFixed(1)} s)`);
	process.exit(n("FAIL") ? 1 : 0);
}
