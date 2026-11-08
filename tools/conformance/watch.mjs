#!/usr/bin/env node
// Minimal phi remote client: connect, print (and validate) every frame.
//
//   node tools/conformance/watch.mjs --url http://127.0.0.1:7718 --token TOKEN
//        [--subscribe <sessionId>]... [--focus <sessionId>] [--push-register] [--seconds N] [--summary]
//
// --summary prints one line per frame type at exit instead of every frame.

import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { validateHubFrame } from "./validators.mjs";

const { values: argv } = parseArgs({
	options: {
		url: { type: "string" },
		token: { type: "string" },
		subscribe: { type: "string", multiple: true },
		focus: { type: "string" },
		"push-register": { type: "boolean", default: false },
		seconds: { type: "string" },
		summary: { type: "boolean", default: false },
		label: { type: "string", default: "watch" },
	},
});
if (!argv.url || !argv.token) {
	console.error("usage: watch.mjs --url http://HOST:PORT --token TOKEN [--subscribe ID]... [--focus ID] [--push-register] [--seconds N] [--summary]");
	process.exit(2);
}

const ws = new WebSocket(`${argv.url.replace(/\/+$/, "").replace(/^http/, "ws")}/v1/ws`);
const counts = {};
const upsertsBySession = {};
let invalid = 0;
const L = argv.label;
const send = (f) => ws.send(JSON.stringify(f));

ws.on("open", () => send({ t: "hello", token: argv.token, protocol: 1, app: { version: "watch-0.1.0", build: "1" }, device: { name: `watch ${L}` } }));
ws.on("message", (d) => {
	const f = JSON.parse(d.toString());
	counts[f.t] = (counts[f.t] ?? 0) + 1;
	if (f.t === "session.upsert") upsertsBySession[f.session.sessionId] = (upsertsBySession[f.session.sessionId] ?? 0) + 1;
	const v = validateHubFrame(f);
	if (v.errors.length) {
		invalid++;
		console.log(`[${L}] INVALID ${f.t}: ${v.errors.join("; ")}`);
	}
	if (!argv.summary) {
		const brief =
			f.t === "session.upsert"
				? `${f.session.sessionId.slice(0, 8)} ${f.session.status}${f.session.activity ? ` [${f.session.activity.tool}]` : ""} ${JSON.stringify(f.session.lastText ?? "").slice(0, 60)}`
				: f.t === "session.event"
					? `${f.sessionId.slice(0, 8)} ${f.event.type} ${f.event.item ? `${f.event.item.kind} ${f.event.item.id}${f.event.item.status ? ` ${f.event.item.status}` : ""}${f.event.item.streaming ? " streaming" : ""}` : JSON.stringify(f.event.state ?? "")}`
					: JSON.stringify(f).slice(0, 160);
		console.log(`${new Date().toISOString().slice(11, 23)} [${L}] ${f.t} ${brief}`);
	}
	if (f.t === "welcome") {
		for (const s of argv.subscribe ?? []) send({ t: "session.subscribe", id: `s${randomBytes(2).toString("hex")}`, sessionId: s, limit: 5 });
		if (argv.focus) send({ t: "focus", sessionId: argv.focus });
		if (argv["push-register"])
			send({ t: "push.register", id: "pr", apnsToken: randomBytes(32).toString("hex"), env: "sandbox", bundleId: "com.example.phiremote" });
	}
});
ws.on("close", (code, reason) => {
	console.log(`[${L}] closed ${code} ${reason}`);
	done();
});
ws.on("error", (e) => console.error(`[${L}] ${e.message}`));
if (argv.seconds) setTimeout(() => ws.close(1000), Number(argv.seconds) * 1000);
process.on("SIGINT", () => ws.close(1000));

let printed = false;
function done() {
	if (printed) return;
	printed = true;
	console.log(`[${L}] frames: ${Object.entries(counts).map(([t, n]) => `${t}×${n}`).join(" ")}; invalid=${invalid}`);
	console.log(`[${L}] session.upsert by session: ${JSON.stringify(upsertsBySession)}`);
	process.exit(invalid ? 1 : 0);
}
