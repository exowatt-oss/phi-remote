#!/usr/bin/env node
// phi remote — MOCK HUB implementing protocol v1 (docs/PROTOCOL.md) with fake sessions.
//
//   node tools/mock-hub/server.mjs [--port 7718] [--bind 0.0.0.0] [--name mock-hub]
//        [--pair-code K7Q2M9XD] [--reusable-code] [--state-dir DIR] [--allow-root DIR]...
//        [--magicdns NAME] [--periodic-ms 45000] [--ping-ms 20000] [--no-qr] [--quiet]
//
// Follows the binding "Clarifications (v1)" section of docs/PROTOCOL.md.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import qrcode from "qrcode-terminal";
import { Registry, FakeSession, HOSTNAME } from "./sessions.mjs";
import { MODELS, THINKING_LEVELS, HOME, findModel } from "./content.mjs";
import { effectiveThinking } from "./sessions.mjs";
import { HistoryStore, modelFor } from "./history.mjs";
import { attachSubagents } from "./subagents.mjs";
import { attachOverseers } from "./overseer.mjs";

const HUB_VERSION = "0.1.0-mock";
const PROTOCOL = 1;
const MAX_FRAME = 12 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 5000;
const CODE_TTL_MS = 10 * 60_000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ERROR_CODES = new Set(["not_found", "bad_request", "session_offline", "forbidden", "internal"]);
// Requests whose success reply is `ack` fail with `ack ok:false`; every other request fails with
// `error { re, code, message }` (clarification 2).
const ACK_TYPES = new Set([
	"session.prompt",
	"session.abort",
	"session.setModel",
	"session.setThinking",
	"session.spawn",
	"session.close",
	"push.register",
	"push.unregister",
	"session.resume",
]);
const HISTORY_DEFAULT = 120; // session.history / session.subscribe limit (clarification 4)
const HISTORY_MAX = 500;
const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]); // clarification 15
// Hub defaults (what models.list without sessionId reports, and what session.spawn uses).
const DEFAULT_MODEL = { provider: "anthropic", id: "claude-sonnet-5" };
const DEFAULT_THINKING = "medium";
const SPAWN_REGISTER_MS = [500, 2000]; // simulated child start + registration

// ------------------------------------------------------------------ CLI

const { values: argv } = parseArgs({
	options: {
		port: { type: "string", default: "7718" },
		bind: { type: "string" },
		name: { type: "string", default: "mock-hub" },
		"pair-code": { type: "string" },
		"reusable-code": { type: "boolean", default: false },
		"state-dir": { type: "string", default: path.join(os.tmpdir(), "phi-remote-mock") },
		"allow-root": { type: "string", multiple: true },
		magicdns: { type: "string" },
		"periodic-ms": { type: "string", default: "45000" },
		"ping-ms": { type: "string", default: "20000" },
		"no-qr": { type: "boolean", default: false },
		quiet: { type: "boolean", default: false },
		"no-commands": { type: "boolean", default: false },
		"no-subagents": { type: "boolean", default: false },
		"no-spawn-thinking": { type: "boolean", default: false },
		"subagent-long-ms": { type: "string", default: "900000" },
		"subagent-rest-ms": { type: "string", default: "90000" },
		"no-history": { type: "boolean", default: false },
		"no-overseer": { type: "boolean", default: false },
		"history-seed": { type: "string", default: "1" },
		"history-count": { type: "string", default: "140" },
		"history-cold-ms": { type: "string", default: "0" },
		help: { type: "boolean", short: "h", default: false },
	},
	allowPositionals: false,
});

if (argv.help) {
	console.log(`usage: node tools/mock-hub/server.mjs [options]

  --port <n>            listen port (default 7718; the real hub uses 7717)
  --bind <a>[,<a>]      bind addresses (default 127.0.0.1 + local Tailscale CGNAT IPv4s (100.64.0.0/10, RFC 6598); 0.0.0.0 for LAN)
  --name <s>            hub name in /v1/info, welcome and the deep link (default mock-hub)
  --pair-code <code>    fixed 8-char Crockford pairing code (default random)
  --reusable-code       code may be used any number of times, no 10-min TTL
  --state-dir <dir>     hub.json + devices.json (default $TMPDIR/phi-remote-mock)
  --allow-root <dir>    extra session.spawn cwd root besides $HOME, repeatable (e.g. /tmp)
  --magicdns <name>     MagicDNS name to put first in the deep link (default: ask \`tailscale status\`;
                        "" disables)
  --periodic-ms <n>     cadence of the "finishes every ~45 s" session (default 45000)
  --ping-ms <n>         server WS ping interval (default 20000)
  --no-qr               do not render the terminal QR
  --quiet               log only pairing, connections and pushes
  --no-commands         play a hub from before slash commands: commands.list → error bad_request,
                        no commandsVersion, /new is plain text
  --no-subagents        play a hub from before subagent sessions: the parent still launches its
                        \`subagent\` tool calls, but no client ever gets subagent sessions or counts
  --no-spawn-thinking   play a hub from before session.spawn thinkingLevel: the field is ignored and
                        new sessions start at the default level
  --subagent-long-ms <n>  how long the long-running subagent works (default 900000 = 15 min)
  --subagent-rest-ms <n>  pause between subagent rounds (default 90000)
  --no-history          play a hub from before session history: no welcome.host.features,
                        sessions.past / session.transcript / session.resume → error bad_request
  --no-overseer         play an exo.11 hub (before Overseers): threads still report summary.overseer
                        and lastError, but no "overseer" feature, no isOverseer / threadCounts /
                        PastSession.overseer, overseer.board → error bad_request, spawn ignores name
  --history-seed <n>    which fake stored sessions this computer has (default 1; use a different
                        seed per mock "computer")
  --history-count <n>   stored sessions to generate (default 140: three pages of 50)
  --history-cold-ms <n> answer sessions.past with half the index and indexing: true for this long
                        after start (default 0)

  kill -USR2 <pid>      mint a fresh pairing code and print the new deep link`);
	process.exit(0);
}

const PORT = Number(argv.port);
const NAME = argv.name;
const STATE_DIR = path.resolve(argv["state-dir"]);
const PING_MS = Number(argv["ping-ms"]);
const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(ts(), ...a);
const vlog = (...a) => (argv.quiet ? undefined : log(...a));

function realOrSelf(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}
// session.spawn cwd must be inside $HOME or one of the --allow-root dirs (else `forbidden`).
const ALLOW_ROOTS = [...new Set([HOME, ...(argv["allow-root"] ?? [])].map(realOrSelf))];

/** null when `dir` is acceptable to session.spawn, else { code, message } (clarification 6). */
function spawnCwdProblem(dir) {
	let st;
	try {
		st = fs.statSync(dir);
	} catch {}
	if (!st?.isDirectory()) return { code: "bad_request", message: `cwd is not an existing directory: ${dir}` };
	const real = realOrSelf(dir);
	if (!ALLOW_ROOTS.some((r) => real === r || real.startsWith(r.endsWith(path.sep) ? r : `${r}${path.sep}`)))
		return { code: "forbidden", message: `cwd must be inside ${ALLOW_ROOTS.join(" or ")}` };
	return null;
}

// ------------------------------------------------------------- state files

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const HUB_FILE = path.join(STATE_DIR, "hub.json");
const DEVICES_FILE = path.join(STATE_DIR, "devices.json");

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}
function writeJson(file, data) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

const prevHub = readJson(HUB_FILE, {});
const HUB_ID = typeof prevHub.hubId === "string" ? prevHub.hubId : `hub_${randomBytes(9).toString("base64url")}`;
/** @type {{id:string,name:string,platform:string,tokenSha256:string,createdAt:number,lastSeenAt:number,push?:{apnsToken:string,env:string,bundleId:string}}[]} */
let devices = readJson(DEVICES_FILE, []);
const saveDevices = () => writeJson(DEVICES_FILE, devices);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------- pairing

function normCode(c) {
	return String(c ?? "")
		.toUpperCase()
		.replace(/[\s-]/g, "");
}
function randomCode() {
	const b = randomBytes(8);
	let s = "";
	for (let i = 0; i < 8; i++) s += CROCKFORD[b[i] % 32];
	return s;
}
let pairCode = normCode(argv["pair-code"] ?? randomCode());
if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(pairCode)) {
	console.error(`--pair-code must be 8 Crockford base32 chars (no I/L/O/U); got ${argv["pair-code"]}`);
	process.exit(2);
}
let codeMintedAt = Date.now();
let codeUsed = false;

// Every attempt (good, bad or malformed) counts toward 5/min/IP (clarification 5).
const pairAttempts = new Map(); // ip → timestamps
function rateLimited(ip) {
	const now = Date.now();
	const arr = (pairAttempts.get(ip) ?? []).filter((t) => now - t < 60_000);
	arr.push(now);
	pairAttempts.set(ip, arr);
	return arr.length > 5;
}

// ---------------------------------------------------------------- registry

const conns = new Set(); // all sockets (authenticated or not)

function onPush(s, { body, error }) {
	const targets = devices.filter((d) => d.push);
	const kind = error ? "fail" : "done";
	if (!targets.length) {
		vlog(`[push] ${kind} "${s.name}" — no registered devices, nothing would be sent`);
		return;
	}
	for (const d of targets) {
		const focused = [...registry.conns].some((c) => c.deviceId === d.id && c.focus === s.id);
		if (focused) {
			log(`[push] SUPPRESSED for device ${d.id} (${d.name}): session ${s.id} is in focus`);
			continue;
		}
		const host = d.push.env === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
		const payload = { aps: { alert: { title: s.name, body } }, hubId: HUB_ID, sessionId: s.id };
		log(`[push] WOULD SEND → ${host} device=${d.id} (${d.name}) token=${d.push.apnsToken.slice(0, 12)}… topic=${d.push.bundleId} apns-push-type=alert payload=${JSON.stringify(payload)}`);
	}
}

const registry = new Registry({ hostName: HOSTNAME, log, onPush, periodicMs: Number(argv["periodic-ms"]), commandsEnabled: !argv["no-commands"] });
registry.seed();
// Subagents (v1 addition): a parent that launches three subagents (done / failed / long-running).
registry.subagentsHidden = argv["no-subagents"];
attachSubagents(registry, { longMs: Number(argv["subagent-long-ms"]), restMs: Number(argv["subagent-rest-ms"]) });
// Overseers (v1 addition): an overseer with four threads (working, idle, error, closed).
const OVERSEER = !argv["no-overseer"];
const overseers = attachOverseers(registry, { enabled: OVERSEER, log: vlog });
// Session history (v1 addition): stored sessions; --no-history plays an older hub.
const history = argv["no-history"]
	? null
	: new HistoryStore({
			registry,
			seed: Number(argv["history-seed"]) || 1,
			count: Math.max(0, Number(argv["history-count"]) || 0),
			coldMs: Number(argv["history-cold-ms"]) || 0,
			allowed: (dir) => {
				const real = realOrSelf(dir);
				return ALLOW_ROOTS.some((r) => real === r || real.startsWith(r.endsWith(path.sep) ? r : `${r}${path.sep}`));
			},
			log: vlog,
			overseers,
			overseerFields: OVERSEER,
		});
if (history) registry.onEnded = (s) => history.keep(s);

// ------------------------------------------------------------------- http

function sendJson(res, status, body) {
	const s = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s), "cache-control": "no-store" });
	res.end(s);
}

function readBody(req, max = 64 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const parts = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > max) {
				reject(Object.assign(new Error("too large"), { status: 413 }));
				req.destroy();
			} else parts.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
		req.on("error", reject);
	});
}

function clientIp(req) {
	return (req.socket.remoteAddress ?? "?").replace(/^::ffff:/, "");
}

async function handleHttp(req, res) {
	const url = new URL(req.url ?? "/", "http://x");
	if (req.method === "GET" && url.pathname === "/v1/info") {
		return sendJson(res, 200, { name: NAME, hubId: HUB_ID, hubVersion: HUB_VERSION, protocol: PROTOCOL });
	}
	if (url.pathname === "/v1/pair") {
		if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
		const ip = clientIp(req);
		if (rateLimited(ip)) {
			log(`[pair] 429 rate limited ip=${ip}`);
			return sendJson(res, 429, { error: "rate_limited" });
		}
		let body;
		try {
			body = JSON.parse(await readBody(req));
		} catch {
			log(`[pair] 400 bad_request ip=${ip} (body is not JSON)`);
			return sendJson(res, 400, { error: "bad_request" });
		}
		if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.code !== "string") {
			log(`[pair] 400 bad_request ip=${ip} (no string code)`);
			return sendJson(res, 400, { error: "bad_request" });
		}
		const code = normCode(body.code);
		const expired = Date.now() - codeMintedAt > CODE_TTL_MS && !argv["reusable-code"];
		if (code !== pairCode || expired || (codeUsed && !argv["reusable-code"])) {
			const why = code !== pairCode ? "" : expired ? " (expired)" : " (already used)";
			log(`[pair] 401 invalid_code ip=${ip}${why}`);
			return sendJson(res, 401, { error: "invalid_code" });
		}
		codeUsed = true;
		const token = randomBytes(32).toString("base64url");
		const dev = {
			id: `dev_${randomBytes(8).toString("hex")}`,
			name: typeof body.deviceName === "string" && body.deviceName ? body.deviceName.slice(0, 80) : "unnamed device",
			platform: typeof body.platform === "string" ? body.platform : "unknown",
			tokenSha256: sha256(token),
			createdAt: Date.now(),
			lastSeenAt: Date.now(),
		};
		devices.push(dev);
		saveDevices();
		log(`[pair] paired device ${dev.id} "${dev.name}" (${dev.platform}) from ${ip}`);
		return sendJson(res, 200, { deviceId: dev.id, token, hubId: HUB_ID, name: NAME });
	}
	sendJson(res, 404, { error: "not_found" });
}

// --------------------------------------------------------------------- ws

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

function onUpgrade(req, socket, head) {
	const url = new URL(req.url ?? "/", "http://x");
	if (url.pathname !== "/v1/ws") {
		socket.write("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, req));
}

function onSocket(ws, req) {
	const ip = clientIp(req);
	const conn = {
		ws,
		ip,
		authed: false,
		deviceId: null,
		focus: null,
		subscriptions: new Set(),
		missedPongs: 0,
		send(frame) {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
		},
	};
	conns.add(conn);
	const helloTimer = setTimeout(() => {
		if (!conn.authed) {
			vlog(`[ws] ${ip} no hello within 5 s → 4401`);
			ws.close(4401, "hello timeout");
		}
	}, HELLO_TIMEOUT_MS);
	const pingTimer = setInterval(() => {
		if (conn.missedPongs >= 3) {
			log(`[ws] ${ip} missed 3 pongs → drop`);
			return ws.terminate();
		}
		conn.missedPongs++;
		try {
			ws.ping();
		} catch {}
	}, PING_MS);
	ws.on("pong", () => (conn.missedPongs = 0));
	ws.on("close", (code) => {
		clearTimeout(helloTimer);
		clearInterval(pingTimer);
		conns.delete(conn);
		registry.conns.delete(conn);
		if (conn.authed) vlog(`[ws] ${ip} device=${conn.deviceId} closed (${code})`);
	});
	ws.on("error", (e) => vlog(`[ws] ${ip} error: ${e.message}`));
	// Malformed frames after auth → error bad_request, socket stays open (clarification 3).
	ws.on("message", (data, isBinary) => {
		let frame;
		try {
			if (isBinary) throw new Error("binary");
			frame = JSON.parse(data.toString("utf8"));
		} catch {
			if (!conn.authed) return ws.close(4401, "first frame must be hello");
			return conn.send({ t: "error", code: "bad_request", message: isBinary ? "binary frames are not supported" : "frame is not valid JSON" });
		}
		if (!frame || typeof frame !== "object" || Array.isArray(frame) || typeof frame.t !== "string") {
			if (!conn.authed) return ws.close(4401, "first frame must be hello");
			const re = frame && typeof frame === "object" && typeof frame.id === "string" ? { re: frame.id } : {};
			return conn.send({ t: "error", ...re, code: "bad_request", message: "frame must be a JSON object with a string `t`" });
		}
		if (!conn.authed) return onHello(conn, frame, helloTimer);
		try {
			handleFrame(conn, frame);
		} catch (e) {
			log(`[ws] internal error handling ${frame.t}: ${e?.stack ?? e}`);
			const message = String(e?.message ?? e);
			if (ACK_TYPES.has(frame.t) && typeof frame.id === "string") conn.send({ t: "ack", re: frame.id, ok: false, error: { code: "internal", message } });
			else conn.send({ t: "error", ...(typeof frame.id === "string" ? { re: frame.id } : {}), code: "internal", message });
		}
	});
}

function onHello(conn, f, helloTimer) {
	if (f.t !== "hello") return conn.ws.close(4401, "first frame must be hello");
	clearTimeout(helloTimer);
	// hello.protocol: absent is accepted as 1; present and not 1 → 4426 (clarification 1).
	if (f.protocol !== undefined && f.protocol !== PROTOCOL) {
		vlog(`[ws] ${conn.ip} hello protocol=${JSON.stringify(f.protocol)} → 4426`);
		return conn.ws.close(4426, "protocol mismatch");
	}
	const dev = typeof f.token === "string" ? devices.find((d) => d.tokenSha256 === sha256(f.token)) : undefined;
	if (!dev) {
		vlog(`[ws] ${conn.ip} bad token → 4401`);
		return conn.ws.close(4401, "unauthorized");
	}
	conn.authed = true;
	conn.deviceId = dev.id;
	// Optional additions the client understands (docs/PROTOCOL.md "Subagents"); unknown ones ignored.
	conn.features = new Set(Array.isArray(f.features) ? f.features.filter((x) => typeof x === "string") : []);
	dev.lastSeenAt = Date.now();
	if (f.device && typeof f.device.name === "string" && f.device.name) dev.name = f.device.name.slice(0, 80);
	saveDevices();
	registry.conns.add(conn);
	const app = f.app && typeof f.app === "object" ? `${f.app.version ?? "?"} (${f.app.build ?? "?"})` : "?";
	log(`[ws] ${conn.ip} device=${dev.id} "${dev.name}" app=${app}${conn.features.size ? ` features=${[...conn.features].join(",")}` : ""} connected`);
	const host = { name: NAME, hubId: HUB_ID, hubVersion: HUB_VERSION, protocol: PROTOCOL };
	const features = [...(history ? ["history"] : []), ...(OVERSEER ? ["overseer"] : [])];
	if (features.length) host.features = features;
	conn.send({ t: "welcome", host, deviceId: dev.id });
}

// ------------------------------------------------------------ frame router

const isStr = (v) => typeof v === "string" && v.length > 0;
const isInt = (v) => Number.isInteger(v);

/** history/subscribe limit: default 120, clamped to 500; null when invalid (clarification 4). */
function pageLimit(v) {
	if (v === undefined) return HISTORY_DEFAULT;
	if (!isInt(v) || v < 1) return null;
	return Math.min(v, HISTORY_MAX);
}

function dirsAcceptableToSpawn(dirs) {
	return dirs.filter((d) => typeof d === "string" && !spawnCwdProblem(d));
}

let spawnCount = 0;

function handleFrame(conn, f) {
	const id = f.id;
	const hasId = typeof id === "string";
	const err = (code, message) => {
		if (!ERROR_CODES.has(code)) code = "internal";
		conn.send(hasId ? { t: "error", re: id, code, message } : { t: "error", code, message });
	};
	const ack = (ok, extra = {}) => conn.send({ t: "ack", re: id, ok, ...extra });
	const nack = (code, message) => ack(false, { error: { code, message } });
	// Missing id on a request is a malformed frame → error bad_request (no `re`), clarification 3.
	const needId = () => {
		if (!hasId) {
			err("bad_request", `${f.t} requires a string id`);
			return false;
		}
		return true;
	};
	const sessionOr = (onMissing) => {
		if (!isStr(f.sessionId)) {
			onMissing("bad_request", "sessionId is required");
			return null;
		}
		const s = registry.sessions.get(f.sessionId);
		// Subagent sessions do not exist for clients that did not opt in.
		if (!s || !registry.visibleTo(conn, s)) {
			onMissing("not_found", `no session ${f.sessionId}`);
			return null;
		}
		return s;
	};
	/** Subagents take subscribe/history/prompt (steer)/abort only. */
	const notForSubagent = (s, reply) => {
		if (s.kind !== "subagent") return false;
		reply("bad_request", `${f.t} is not supported for subagent sessions`);
		return true;
	};

	switch (f.t) {
		case "hello":
			return err("bad_request", "already authenticated");
		case "ping":
			if (!needId()) return;
			return conn.send({ t: "pong", re: id });
		case "sessions.list":
			if (!needId()) return;
			return conn.send({ t: "sessions", re: id, sessions: [...registry.sessions.values()].filter((s) => registry.visibleTo(conn, s)).map((s) => s.summary()) });
		case "session.subscribe": {
			if (!needId()) return;
			const s = sessionOr(err);
			if (!s) return;
			const limit = pageLimit(f.limit);
			if (limit === null) return err("bad_request", "limit must be a positive integer");
			const items = s.items.slice(Math.max(0, s.items.length - limit));
			conn.subscriptions.add(s.id);
			return conn.send({ t: "session.snapshot", re: id, sessionId: s.id, items, hasMore: s.items.length > items.length, state: s.liveState() });
		}
		case "session.unsubscribe":
			if (!isStr(f.sessionId)) return err("bad_request", "sessionId is required");
			conn.subscriptions.delete(f.sessionId);
			return;
		case "session.history": {
			if (!needId()) return;
			const s = sessionOr(err);
			if (!s) return;
			if (!isStr(f.before)) return err("bad_request", "before (item id) is required");
			const limit = pageLimit(f.limit);
			if (limit === null) return err("bad_request", "limit must be a positive integer");
			const idx = s.index.get(f.before);
			if (idx === undefined) return err("not_found", `no item ${f.before} in session ${s.id}`);
			const start = Math.max(0, idx - limit);
			return conn.send({ t: "session.history", re: id, sessionId: s.id, items: s.items.slice(start, idx), hasMore: start > 0 });
		}
		case "session.prompt": {
			if (!needId()) return;
			const s = sessionOr(nack);
			if (!s) return;
			if (typeof f.text !== "string") return nack("bad_request", "text is required");
			const mode = f.mode ?? "auto";
			if (!["auto", "steer", "followUp"].includes(mode)) return nack("bad_request", `bad mode ${mode}`);
			if (f.images !== undefined) {
				if (!Array.isArray(f.images) || !f.images.every((im) => im && typeof im === "object" && isStr(im.mimeType) && isStr(im.data)))
					return nack("bad_request", "images must be { mimeType, data }[]");
				const bad = f.images.find((im) => !IMAGE_MIME.has(im.mimeType));
				if (bad) return nack("bad_request", `image mimeType ${bad.mimeType} not allowed (${[...IMAGE_MIME].join(", ")})`);
			}
			if (!f.text.trim() && !f.images?.length) return nack("bad_request", "empty prompt");
			vlog(`[cmd] prompt → ${s.id.slice(0, 8)} (${s.status}, mode=${mode}) ${JSON.stringify(f.text.slice(0, 80))}`);
			const refused = s.prompt(f.text, f.images, mode);
			if (refused?.error) return nack(refused.error.code, refused.error.message);
			return ack(true);
		}
		case "session.abort": {
			if (!needId()) return;
			const s = sessionOr(nack);
			if (!s) return;
			// idle → ok no-op; an abort never triggers a push (clarification 9)
			const did = s.abort();
			vlog(`[cmd] abort → ${s.id.slice(0, 8)} ${did ? "aborted" : "(was idle, no-op)"}`);
			return ack(true);
		}
		case "models.list": {
			if (!needId()) return;
			const frame = { t: "models", re: id, models: MODELS.map((m) => ({ ...m })), thinkingLevels: [...THINKING_LEVELS] };
			if (f.sessionId === undefined || f.sessionId === null) {
				// no session: the hub's own registry + the user's defaults (clarification 8)
				frame.current = { ...DEFAULT_MODEL };
				frame.thinkingLevel = effectiveThinking(DEFAULT_MODEL, DEFAULT_THINKING);
				return conn.send(frame);
			}
			const s = sessionOr(err);
			if (!s || notForSubagent(s, err)) return;
			if (s.model) frame.current = { provider: s.model.provider, id: s.model.id };
			const lvl = effectiveThinking(s.model, s.thinkingLevel);
			if (lvl) frame.thinkingLevel = lvl;
			return conn.send(frame);
		}
		case "session.setModel": {
			if (!needId()) return;
			const s = sessionOr(nack);
			if (!s || notForSubagent(s, nack)) return;
			if (!isStr(f.provider) || !isStr(f.modelId)) return nack("bad_request", "provider and modelId are required");
			const m = findModel(f.provider, f.modelId);
			if (!m) return nack("not_found", `unknown model ${f.provider}/${f.modelId}`);
			s.setModel(m);
			vlog(`[cmd] setModel → ${s.id.slice(0, 8)} ${m.provider}/${m.id}`);
			return ack(true);
		}
		case "session.setThinking": {
			if (!needId()) return;
			const s = sessionOr(nack);
			if (!s || notForSubagent(s, nack)) return;
			if (!THINKING_LEVELS.includes(f.level)) return nack("bad_request", `level must be one of ${THINKING_LEVELS.join(", ")}`);
			s.setThinking(f.level); // a non-reasoning model keeps reporting "off" (clarification 7)
			vlog(`[cmd] setThinking → ${s.id.slice(0, 8)} ${f.level} (reported ${s.thinkingLevel})`);
			return ack(true);
		}
		case "commands.list": {
			// Slash commands (v1 addition). --no-commands plays an older hub that does not know it.
			if (argv["no-commands"]) return err("bad_request", `unknown frame type ${JSON.stringify(f.t)}`);
			if (!needId()) return;
			const s = sessionOr(err);
			if (!s || notForSubagent(s, err)) return;
			return conn.send({ t: "commands", re: id, sessionId: s.id, commands: s.commands() });
		}
		case "cwds.recent": {
			if (!needId()) return;
			// only directories session.spawn would accept (clarification 6)
			const live = [...registry.sessions.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt).map((s) => s.cwd);
			const all = dirsAcceptableToSpawn([...new Set([...live, ...registry.recentCwds])]);
			if (!all.length) all.push(HOME);
			return conn.send({ t: "cwds", re: id, cwds: all });
		}
		case "session.spawn": {
			if (!needId()) return;
			if (!isStr(f.cwd)) return nack("bad_request", "cwd is required");
			const cwd = path.resolve(f.cwd.replace(/^~(?=$|\/)/, HOME));
			const problem = spawnCwdProblem(cwd);
			if (problem) return nack(problem.code, problem.message);
			if (f.prompt !== undefined && typeof f.prompt !== "string") return nack("bad_request", "prompt must be a string");
			// thinkingLevel: any phi level, clamped to the model like the real hub's child does
			// (--no-spawn-thinking: ignored, like an older hub)
			const thinking = argv["no-spawn-thinking"] ? undefined : f.thinkingLevel;
			if (thinking !== undefined && ![...THINKING_LEVELS, "max"].includes(thinking))
				return nack("bad_request", "invalid thinkingLevel");
			let model = findModel(DEFAULT_MODEL.provider, DEFAULT_MODEL.id);
			if (f.provider !== undefined || f.modelId !== undefined) {
				if (!isStr(f.provider) || !isStr(f.modelId)) return nack("bad_request", "provider and modelId go together");
				model = findModel(f.provider, f.modelId);
				if (!model) return nack("not_found", `unknown model ${f.provider}/${f.modelId}`);
			}
			// Overseers (v1 addition): `name`, one non-blank line of at most 200 characters (trimmed);
			// anything else is bad_request and starts nothing. Older hubs (--no-overseer) ignore it.
			let name;
			if (OVERSEER && f.name !== undefined) {
				if (typeof f.name !== "string" || !f.name.trim() || /[\r\n]/.test(f.name) || f.name.trim().length > 200)
					return nack("bad_request", "name must be one non-blank line of at most 200 characters");
				name = f.name.trim();
			}
			const firstLine = f.prompt?.split("\n").find((l) => l.trim())?.trim();
			const s = new FakeSession(registry, {
				name: name ?? (firstLine ? firstLine.slice(0, 60) : path.basename(cwd) || cwd),
				cwd,
				kind: "headless",
				model: { provider: model.provider, id: model.id, name: model.name },
				thinkingLevel: thinking === "max" ? "xhigh" : (thinking ?? DEFAULT_THINKING),
			});
			const n = ++spawnCount;
			const delay = SPAWN_REGISTER_MS[0] + Math.floor(Math.random() * (SPAWN_REGISTER_MS[1] - SPAWN_REGISTER_MS[0]));
			const asked = `provider=${f.provider ?? "-"} modelId=${f.modelId ?? "-"} thinkingLevel=${f.thinkingLevel ?? "-"}`;
			vlog(`[cmd] spawn → ${s.id} in ${cwd}${f.prompt ? " with prompt" : ""} (${asked}; child registers in ${delay} ms)`);
			// The ack goes out only once the "child" has registered (clarification 6). The new
			// session's session.upsert may arrive before the ack: alternate both orders so clients
			// exercise each.
			setTimeout(() => {
				if (shuttingDown) return nack("internal", "hub shutting down");
				const upsertFirst = n % 2 === 1;
				registry.add(s, { announce: upsertFirst });
				ack(true, { sessionId: s.id });
				if (!upsertFirst) registry.announce(s);
				if (f.prompt && !s.closed) s.prompt(f.prompt, undefined, "auto");
			}, delay);
			return;
		}
		case "session.close": {
			if (!needId()) return;
			const s = sessionOr(nack);
			if (!s || notForSubagent(s, nack)) return;
			if (s.kind !== "headless") return nack("forbidden", "only headless (hub-spawned) sessions can be closed");
			registry.remove(s.id);
			vlog(`[cmd] close → ${s.id}`);
			return ack(true);
		}
		case "overseer.board": {
			// Overseers (v1 addition). --no-overseer plays an older hub that does not know it.
			if (!OVERSEER) return err("bad_request", `unknown frame type ${JSON.stringify(f.t)}`);
			if (!needId()) return;
			if (!isStr(f.sessionId)) return err("bad_request", "sessionId is required");
			const board = overseers.board(f.sessionId);
			if (!board) return err("not_found", `no overseer ${f.sessionId}`);
			return conn.send({ t: "overseer.board", re: id, ...board });
		}
		case "sessions.past": {
			// Session history (v1 addition). --no-history plays an older hub that does not know it.
			if (!history) return err("bad_request", `unknown frame type ${JSON.stringify(f.t)}`);
			if (!needId()) return;
			const r = history.past(f);
			if (r.error) return err(...r.error);
			return conn.send({ t: "sessions.past", re: id, ...r });
		}
		case "session.transcript": {
			if (!history) return err("bad_request", `unknown frame type ${JSON.stringify(f.t)}`);
			if (!needId()) return;
			const r = history.transcript(f);
			if (r.error) return err(...r.error);
			return conn.send({ t: "session.transcript", re: id, sessionId: f.sessionId, items: r.items, hasMore: r.hasMore });
		}
		case "session.resume": {
			if (!history) return err("bad_request", `unknown frame type ${JSON.stringify(f.t)}`);
			if (!needId()) return;
			return history.resume(f, {
				ack: (ok, extra) => {
					if (shuttingDown) return nack("internal", "hub shutting down");
					ack(ok, extra);
				},
				nack,
				validateModel: (frame, fallback) => {
					if (frame.thinkingLevel !== undefined && ![...THINKING_LEVELS, "max"].includes(frame.thinkingLevel)) return { error: ["bad_request", "invalid thinkingLevel"] };
					return modelFor(frame, fallback);
				},
				thinking: (level) => (level === "max" ? "xhigh" : (level ?? DEFAULT_THINKING)),
				prompt: (s, text) => {
					if (!s.closed) s.prompt(text, undefined, "auto");
				},
			});
		}
		case "push.register": {
			if (!needId()) return;
			if (!isStr(f.apnsToken) || !["sandbox", "production"].includes(f.env) || !isStr(f.bundleId))
				return nack("bad_request", "apnsToken, env (sandbox|production) and bundleId are required");
			const dev = devices.find((d) => d.id === conn.deviceId);
			if (!dev) return nack("internal", "device vanished");
			dev.push = { apnsToken: f.apnsToken, env: f.env, bundleId: f.bundleId };
			saveDevices();
			log(`[push] registered device ${dev.id} env=${f.env} bundle=${f.bundleId} token=${f.apnsToken.slice(0, 12)}…`);
			return ack(true);
		}
		case "push.unregister": {
			if (!needId()) return;
			const dev = devices.find((d) => d.id === conn.deviceId);
			if (dev?.push) {
				delete dev.push;
				saveDevices();
			}
			log(`[push] unregistered device ${conn.deviceId}`);
			return ack(true);
		}
		case "focus": {
			if (f.sessionId !== null && f.sessionId !== undefined && typeof f.sessionId !== "string") return err("bad_request", "sessionId must be a string or null");
			conn.focus = f.sessionId ?? null;
			vlog(`[focus] device=${conn.deviceId} → ${conn.focus ?? "null"}`);
			return;
		}
		default:
			return err("bad_request", `unknown frame type ${JSON.stringify(f.t)}`);
	}
}

// ------------------------------------------------------------------ listen

function ipv4s() {
	const out = [];
	for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
		for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) out.push({ ifname, address: a.address });
	}
	return out;
}
const isCgnat = (ip) => {
	const [a, b] = ip.split(".").map(Number);
	return a === 100 && b >= 64 && b <= 127;
};

let binds;
if (argv.bind) binds = argv.bind.split(",").map((s) => s.trim()).filter(Boolean);
else binds = ["127.0.0.1", ...ipv4s().filter((a) => isCgnat(a.address)).map((a) => a.address)];

const isLoopback = (a) => a.startsWith("127.") || a === "localhost" || a === "::1";

/** This machine's MagicDNS name (no trailing dot), from --magicdns or `tailscale status --json`. */
let magicDnsCache;
function magicDns() {
	if (magicDnsCache !== undefined) return magicDnsCache;
	magicDnsCache = null;
	if (argv.magicdns !== undefined) return (magicDnsCache = argv.magicdns.replace(/\.$/, "") || null);
	for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
		try {
			const out = execFileSync(bin, ["status", "--json"], { timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
			const name = JSON.parse(out.toString("utf8"))?.Self?.DNSName;
			if (typeof name === "string" && name) return (magicDnsCache = name.replace(/\.$/, ""));
		} catch {}
	}
	return magicDnsCache;
}

// Deep-link `url` order (clarification 13): MagicDNS name, then Tailscale IPs, then any other
// bound non-loopback address; 127.0.0.1 only when the hub is bound to loopback only.
function advertised() {
	if (binds.every(isLoopback)) return [`http://127.0.0.1:${PORT}`];
	const wildcard = binds.includes("0.0.0.0");
	const pool = [...new Set(wildcard ? ipv4s().map((a) => a.address) : binds.filter((b) => !isLoopback(b) && b !== "0.0.0.0"))];
	const tailnet = pool.filter(isCgnat);
	const other = pool.filter((a) => !isCgnat(a));
	const hosts = [];
	if (tailnet.length && magicDns()) hosts.push(magicDns());
	hosts.push(...tailnet, ...other);
	return hosts.map((h) => `http://${h}:${PORT}`);
}

function deepLink(urls) {
	const q = new URLSearchParams({ v: "1", code: pairCode, name: NAME, hubId: HUB_ID });
	for (const u of urls) q.append("url", u);
	return `phiremote://pair?${q.toString()}`;
}

let listening = 0;
for (const addr of binds) {
	const srv = http.createServer((req, res) => {
		handleHttp(req, res).catch((e) => {
			log(`[http] ${e?.stack ?? e}`);
			if (!res.headersSent) sendJson(res, 500, { error: "internal" });
		});
	});
	srv.on("upgrade", onUpgrade);
	srv.on("error", (e) => {
		console.error(`listen ${addr}:${PORT} failed: ${e.message}`);
		process.exit(1);
	});
	srv.listen(PORT, addr, () => {
		listening++;
		if (listening === binds.length) ready();
	});
}

function ready() {
	writeJson(HUB_FILE, { hubId: HUB_ID, pid: process.pid, port: PORT, binds, startedAt: Date.now(), version: HUB_VERSION });
	const urls = advertised();
	const link = deepLink(urls);
	console.log("");
	console.log(`phi remote MOCK hub "${NAME}"  hubId=${HUB_ID}  protocol=${PROTOCOL}  pid=${process.pid}`);
	console.log(`listening on ${binds.map((b) => `${b}:${PORT}`).join(", ")}`);
	console.log(`state dir   ${STATE_DIR}  (${devices.length} paired device(s))`);
	console.log(`spawn roots ${ALLOW_ROOTS.join(", ")}`);
	console.log("");
	console.log(`pair code   ${pairCode}${argv["reusable-code"] ? "  (reusable, no TTL)" : "  (single use, 10 min)"}`);
	for (const u of urls) console.log(`url         ${u}`);
	console.log("");
	console.log(`deep link   ${link}`);
	console.log("");
	for (const u of urls) {
		console.log(`deep link (${u})`);
		console.log(`  ${deepLink([u])}`);
	}
	console.log("");
	if (!argv["no-qr"]) qrcode.generate(link, { small: true }, (q) => console.log(q));
	console.log(`sessions: ${[...registry.sessions.values()].map((s) => `${s.id.slice(0, 8)} "${s.name}" (${s.items.length} items)`).join(", ")}`);
	console.log("");
}

// Let a local user mint a fresh code: send SIGUSR2.
process.on("SIGUSR2", () => {
	pairCode = randomCode();
	codeMintedAt = Date.now();
	codeUsed = false;
	log(`[pair] new code ${pairCode}`);
	log(`[pair] ${deepLink(advertised())}`);
});

let shuttingDown = false;
const shutdown = () => {
	shuttingDown = true;
	for (const c of conns) c.ws.close(1001, "hub shutting down");
	setTimeout(() => process.exit(0), 100);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
