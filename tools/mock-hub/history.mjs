// Session history (protocol "Session history (v1 addition)") for the mock hub: a store of
// stored phi sessions (fake but realistic, deterministic per --history-seed), answering
// sessions.past (cursor paging, search, cwd filter), session.transcript (newest page, `before`)
// and session.resume (same id, same items, now live). Live sessions are listed too (live: true).
//
// Fixtures: long and short titles, named and unnamed sessions, many sessions for paging (spread
// over ~4 months), one listed with `resumable: false` (outside the allowed roots on older hubs; it
// still resumes: the flag never gates), one whose folder "no longer exists" (resume falls back to
// $HOME: ack cwd + cwdFallback), a long transcript for paging up. Every stored session resumes.

import path from "node:path";

import { findModel, generateHistory, HOME, oneLine, rng } from "./content.mjs";
import { FakeSession } from "./sessions.mjs";

export const PAST_DEFAULT = 50;
export const PAST_MAX = 200;
export const TRANSCRIPT_DEFAULT = 120;
export const TRANSCRIPT_MAX = 500;
const RESUME_REGISTER_MS = [600, 1800];

const PROJECTS = [
	"ExampleCo/phi",
	"ExampleCo/phi-remote",
	"ExampleCo/example-service",
	"ExampleCo/example-service",
	"ExampleCo/example-service",
	"ExampleCo/deployments",
	"ExampleCo/example-service",
	"ExampleCo/proxmox-management",
	"ExampleCo/bingo",
	"ExampleCo/reports",
];

/** First user messages (the title of an unnamed session is its first line, <= 120 chars). */
const PROMPTS = [
	"Can you look at why the example-service planner keeps oscillating between charge and discharge every five minutes when the state of charge sits right around fifty percent on example-service?",
	"Fix the flaky login test in example-service",
	"Add a /v1/sites/:id/telemetry endpoint that streams the last hour of readings",
	"Why does the example-service time out on the second example-service only?",
	"Write a migration that backfills example-service from the deployments manifest",
	"Bump expo to 58 and fix whatever breaks",
	"Summarize what changed in the hub protocol since last week",
	"The example-service shows gaps every night at 02:00 UTC — find out why",
	"Refactor the session registry so subagent children are removed before their parent",
	"Draft release notes for phi 1.4.0-exo.7",
	"Make the sessions list in the iPhone app load faster on cold start",
	"Port the example-service from the notebook into example-service as a proper module with tests",
	"what is eating disk on the mini?",
	"Add retries with jitter to the APNs sender and log 410s",
	"Review PR #482 and leave comments only where something is actually wrong",
	"Rename `hub_id` to `hubId` everywhere in the docs",
	"Find every place we parse cwd without normalising a trailing slash",
	"Set up a nightly job that prunes old session files older than 90 days",
	"Explain how the remote pairing code TTL works",
	"Investigate the 500s from /api/fleet/summary since this morning's deploy",
];

/** Names some sessions were given (session_info). */
const NAMES = ["release checklist", "example-service", "devbox tmux", "example-service port", "example-service", "hub protocol notes"];

const MODEL_POOL = [
	["anthropic", "claude-opus-5-5"],
	["anthropic", "claude-sonnet-5"],
	["example", "fast"],
	["openai", "gpt-5.6"],
	["example", "large"],
];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unb64 = (s) => {
	try {
		return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
	} catch {
		return null;
	}
};

export class HistoryStore {
	/**
	 * @param {object} o
	 * @param {import("./sessions.mjs").Registry} o.registry
	 * @param {number} o.seed  fixture set (different computers get different seeds)
	 * @param {number} o.count stored sessions to generate
	 * @param {(dir: string) => boolean} o.allowed  cwd inside the hub's allowed roots
	 * @param {number} o.coldMs answer with half the index and `indexing: true` for this long
	 * @param {(s: string) => void} o.log
	 */
	constructor({ registry, seed = 1, count = 140, allowed, coldMs = 0, log = () => {}, overseers = null, overseerFields = true }) {
		this.registry = registry;
		/** Overseers (v1 addition): PastSession.overseer / isOverseer (off for an older hub). */
		this.overseers = overseers;
		this.overseerFields = overseerFields;
		this.allowed = allowed;
		this.log = log;
		this.warmAt = Date.now() + coldMs;
		/** id → { id, title, named, cwd, createdAt, modifiedAt, model, items, gone? } */
		this.stored = new Map();
		/** id → [ack callbacks] of resumes in flight (a second resume joins the first). */
		this.pending = new Map();
		this.generate(seed, count);
		// Overseers: the closed thread, and a past overseer with three past threads.
		for (const e of overseers?.storedEntries() ?? []) this.stored.set(e.id, { gone: false, flagged: false, ...e });
	}

	generate(seed, count) {
		const r = rng(seed * 7919 + 17);
		const now = Date.now();
		const day = 86_400_000;
		for (let i = 0; i < count; i++) {
			// Newest first: a few today, a few yesterday, then thinning out over ~4 months.
			const age =
				i < 4 ? r.int(20, 600) * 60_000 : i < 8 ? day + r.int(0, 20) * 3600_000 : i < 16 ? r.int(2, 6) * day + r.int(0, 20) * 3600_000 : r.int(7, 120) * day + r.int(0, 23) * 3600_000;
			const modifiedAt = now - age;
			const proj = PROJECTS[(i * 3 + seed) % PROJECTS.length];
			const prompt = PROMPTS[(i * 7 + seed * 3) % PROMPTS.length];
			const named = i % 9 === 4;
			const [provider, modelId] = MODEL_POOL[(i + seed) % MODEL_POOL.length];
			const id = `${seed.toString(16).padStart(2, "0")}${r.hex(6)}-${r.hex(4)}-4${r.hex(3)}-a${r.hex(3)}-${r.hex(12)}`;
			const itemCount = i === 1 ? 420 : r.int(12, 90);
			let cwd = path.join(HOME, proj);
			let gone = false;
			let flagged = false;
			// The fifth session ran outside the allowed roots (listed resumable: false, resumes anyway);
			// the seventh's folder was deleted since (resumes in $HOME).
			if (i === 5) {
				cwd = "/opt/legacy-tools/scada-export";
				flagged = true;
			}
			if (i === 7) {
				cwd = path.join(HOME, "scratch", "old-spike");
				gone = true;
			}
			const h = generateHistory({ seed: seed * 1000 + i, count: itemCount, endTs: modifiedAt, modelName: modelId, cwd, withImages: i === 2 });
			// The first user message is the prompt the title comes from.
			const firstUser = h.items.find((it) => it.kind === "user");
			if (firstUser) firstUser.text = prompt;
			// Ids unique per session (generateHistory seeds them per session already).
			const title = named ? NAMES[i % NAMES.length] : oneLine(prompt.split("\n")[0], 120);
			this.stored.set(id, {
				id,
				title,
				named,
				cwd,
				createdAt: h.items[0]?.ts ?? modifiedAt - 3_600_000,
				modifiedAt,
				model: { provider, id: modelId },
				items: h.items,
				gone,
				flagged,
			});
		}
	}

	/** A live session as the index sees it (its items are the live ones). */
	liveEntry(s) {
		const stored = this.stored.get(s.id);
		const items = s.items;
		const firstUser = items.find((it) => it.kind === "user");
		return {
			id: s.id,
			// A resumed session keeps its stored title; the seeded live ones have names.
			title: stored ? stored.title : s.name || oneLine(firstUser?.text?.split("\n")[0] ?? path.basename(s.cwd), 120),
			named: stored ? stored.named : !!s.name,
			cwd: s.cwd,
			createdAt: s.startedAt,
			modifiedAt: s.lastActivityAt,
			model: s.model ? { provider: s.model.provider, id: s.model.id } : undefined,
			items,
			live: true,
			liveKind: s.kind === "headless" ? "headless" : "interactive",
			overseer: s.overseerLink ? { ...s.overseerLink } : stored?.overseer,
			isOverseer: !!this.overseers?.isOverseer(s.id) || stored?.isOverseer,
		};
	}

	/** Every listed session, newest first (live ones included, subagents never). */
	all() {
		const out = new Map();
		for (const e of this.stored.values()) out.set(e.id, { ...e, live: false });
		for (const s of this.registry.sessions.values()) {
			if (s.kind === "subagent" || s.closed) continue;
			out.set(s.id, this.liveEntry(s));
		}
		return [...out.values()].sort((a, b) => b.modifiedAt - a.modifiedAt || (a.id < b.id ? -1 : 1));
	}

	toPast(e) {
		const messages = e.items.filter((it) => it.kind === "user" || it.kind === "assistant");
		const lastReply = [...e.items].reverse().find((it) => it.kind === "assistant" && it.text);
		const out = {
			sessionId: e.id,
			title: e.title,
			named: e.named,
			cwd: e.cwd,
			createdAt: e.createdAt,
			modifiedAt: e.modifiedAt,
			messageCount: messages.length,
			live: !!e.live,
			// Data only: the app never gates on it, and resume accepts every stored session.
			resumable: !e.flagged,
		};
		if (lastReply) out.preview = oneLine(lastReply.text, 200);
		if (e.model) out.model = e.model;
		if (e.live) out.liveKind = e.liveKind;
		if (this.overseerFields && e.overseer) out.overseer = { ...e.overseer };
		if (this.overseerFields && e.isOverseer) out.isOverseer = true;
		return out;
	}

	/** sessions.past: { sessions, nextCursor?, indexing? } or { error: [code, message] }. */
	past(f) {
		const limit = f.limit === undefined ? PAST_DEFAULT : f.limit;
		if (!Number.isInteger(limit) || limit < 1) return { error: ["bad_request", "limit must be a positive integer"] };
		if (f.query !== undefined && (typeof f.query !== "string" || f.query.length > 200)) return { error: ["bad_request", "query must be a string of at most 200 characters"] };
		if (f.cwd !== undefined && typeof f.cwd !== "string") return { error: ["bad_request", "cwd must be a string"] };
		let list = this.all();
		const cold = Date.now() < this.warmAt;
		if (cold) list = list.filter((_, i) => i % 2 === 0);
		const q = f.query?.trim().toLowerCase();
		if (q) {
			list = list.filter((e) => {
				if (e.title.toLowerCase().includes(q) || e.cwd.toLowerCase().includes(q)) return true;
				return e.items.some((it) => (it.kind === "user" || it.kind === "assistant") && it.text?.toLowerCase().includes(q));
			});
		}
		if (f.cwd !== undefined) list = list.filter((e) => e.cwd === f.cwd);
		let start = 0;
		if (f.cursor !== undefined) {
			const c = typeof f.cursor === "string" ? unb64(f.cursor) : null;
			if (!c || typeof c.m !== "number" || typeof c.id !== "string") return { error: ["bad_request", "bad cursor"] };
			// Strictly after the last one sent (stable under new sessions arriving at the top).
			start = list.findIndex((e) => e.modifiedAt < c.m || (e.modifiedAt === c.m && e.id > c.id));
			if (start < 0) start = list.length;
		}
		const page = list.slice(start, start + Math.min(limit, PAST_MAX));
		const out = { sessions: page.map((e) => this.toPast(e)) };
		const last = page[page.length - 1];
		if (last && start + page.length < list.length) out.nextCursor = b64({ m: last.modifiedAt, id: last.id });
		if (cold) out.indexing = true;
		return out;
	}

	/** session.transcript: { items, hasMore } or { error }. */
	transcript(f) {
		if (typeof f.sessionId !== "string") return { error: ["bad_request", "sessionId is required"] };
		const limit = f.limit === undefined ? TRANSCRIPT_DEFAULT : f.limit;
		if (!Number.isInteger(limit) || limit < 1) return { error: ["bad_request", "limit must be a positive integer"] };
		const live = this.registry.sessions.get(f.sessionId);
		const e = live && live.kind !== "subagent" ? this.liveEntry(live) : this.stored.get(f.sessionId);
		if (!e) return { error: ["not_found", `no session ${f.sessionId}`] };
		const n = Math.min(limit, TRANSCRIPT_MAX);
		let end = e.items.length;
		if (f.before !== undefined) {
			if (typeof f.before !== "string") return { error: ["bad_request", "before must be an item id"] };
			end = e.items.findIndex((it) => it.id === f.before);
			if (end < 0) return { error: ["not_found", `no item ${f.before} in session ${f.sessionId}`] };
		}
		const start = Math.max(0, end - n);
		return { items: e.items.slice(start, end), hasMore: start > 0 };
	}

	/**
	 * session.resume. `ack(ok, extra)` replies; `prompt(s, text)` delivers a prompt to a live session.
	 * Returns nothing; replies asynchronously like spawn.
	 */
	resume(f, { ack, nack, validateModel, prompt, thinking }) {
		if (typeof f.sessionId !== "string") return nack("bad_request", "sessionId is required");
		if (f.prompt !== undefined && typeof f.prompt !== "string") return nack("bad_request", "prompt must be a string");
		const live = this.registry.sessions.get(f.sessionId);
		if (live && live.kind !== "subagent" && !live.closed) {
			ack(true, { sessionId: live.id });
			if (f.prompt) prompt(live, f.prompt);
			return;
		}
		const e = this.stored.get(f.sessionId);
		if (!e) return nack("not_found", `no session ${f.sessionId}`);
		// Resume ignores allowed roots; a missing folder falls back to $HOME (ack cwd + cwdFallback).
		const fallback = e.gone || !e.cwd;
		const cwd = fallback ? HOME : e.cwd;
		const extra = fallback ? { cwd, cwdFallback: true } : { cwd };
		const model = validateModel(f, e.model);
		if (model.error) return nack(...model.error);
		const join = this.pending.get(e.id);
		if (join) {
			join.push({ ack, prompt: f.prompt });
			return;
		}
		const waiting = [{ ack, prompt: f.prompt }];
		this.pending.set(e.id, waiting);
		const delay = RESUME_REGISTER_MS[0] + Math.floor(Math.random() * (RESUME_REGISTER_MS[1] - RESUME_REGISTER_MS[0]));
		this.log(`[history] resume → ${e.id} in ${cwd}${fallback ? ` (${e.cwd || "no folder"} is gone)` : ""} (model ${model.value.provider}/${model.value.id}; registers in ${delay} ms)`);
		setTimeout(() => {
			this.pending.delete(e.id);
			if (this.registry.sessions.has(e.id)) {
				for (const w of waiting) w.ack(true, { sessionId: e.id, ...extra });
				return;
			}
			const s = new FakeSession(this.registry, {
				id: e.id,
				name: e.named ? e.title : oneLine(e.title, 60),
				cwd,
				kind: "headless",
				model: { provider: model.value.provider, id: model.value.id, name: model.value.name },
				thinkingLevel: thinking(f.thinkingLevel),
				startedAt: Date.now(),
				lastActivityAt: Date.now(),
				items: e.items,
			});
			const last = [...e.items].reverse().find((it) => it.kind === "assistant" && it.text);
			if (last) s.lastText = oneLine(last.text);
			this.registry.add(s);
			for (const w of waiting) w.ack(true, { sessionId: s.id, ...extra });
			for (const w of waiting) if (w.prompt) prompt(s, w.prompt);
		}, delay);
	}

	/** A live session ended: keep it as a stored session (same id and items). */
	keep(s) {
		if (s.kind === "subagent") return;
		const e = this.liveEntry(s);
		this.stored.set(s.id, { ...e, items: [...s.items], live: false, gone: false });
	}
}

export function modelFor(f, fallback) {
	if (f.provider !== undefined || f.modelId !== undefined) {
		if (typeof f.provider !== "string" || typeof f.modelId !== "string") return { error: ["bad_request", "provider and modelId go together"] };
		const m = findModel(f.provider, f.modelId);
		if (!m) return { error: ["not_found", `unknown model ${f.provider}/${f.modelId}`] };
		return { value: m };
	}
	const m = (fallback && findModel(fallback.provider, fallback.id)) ?? findModel("anthropic", "claude-sonnet-5");
	return { value: m };
}
