// Overseers (protocol "Overseers (v1 addition)") for the mock hub: one seeded overseer with four
// threads (working, idle, error, closed), its registry (what `overseer.board` answers), a
// transcript with real-shaped `overseer` tool calls, `overseer_event` updates and a thread report,
// `isOverseer` / `threadCounts` on the overseer and `overseer` / `lastError` on its threads.
//
// Phone flows: a spawn whose prompt invokes the overseer skill (or starts "Act as overseer")
// starts two threads of its own a few seconds later; "Start a new thread: …" sent to an overseer
// starts one more. --no-overseer plays an exo.11 hub: threads still carry `summary.overseer` and
// `lastError`, but there is no feature flag, no isOverseer/threadCounts and `overseer.board` is an
// unknown request.

import path from "node:path";

import { findModel, generateHistory, HOME, oneLine, rng } from "./content.mjs";
import { FakeSession } from "./sessions.mjs";

export const OVERSEER_ID = "mock-0f5e7a3c";
export const OVERSEER_NAME = "Overseer · ship the API filters end to end";
export const THREAD_IDS = {
	"api-filters": "mock-1a2b3c4d",
	"board-ui": "mock-2b3c4d5e",
	migrations: "mock-3c4d5e6f",
	"docs-sweep": "mock-4d5e6f7a",
};
/** A stored overseer with three stored threads (Session history: PastSession.overseer). */
export const PAST_OVERSEER_ID = "mock-5e6f7a8b";
const PAST_THREADS = [
	["deps-api", "mock-6f7a8b9c", "ExampleCo/example-service"],
	["deps-ui", "mock-7a8b9c0d", "ExampleCo/example-service"],
	["deps-site", "mock-8b9c0d1e", "ExampleCo/example-service"],
];

const REPLY_HINT =
	'Reply with overseer {action:"send", target:"<thread>", message}; inspect with overseer {action:"read", target:"<thread>"}. These are thread reports, not user messages.';
const SUBAGENT_POLICY = { default: "example/fast:max", allow: ["anthropic/claude-opus-5-5:high|xhigh", "example/fast:max", "anthropic/claude-sonnet-5:medium"] };

const model = (provider, id) => {
	const m = findModel(provider, id);
	return { provider: m.provider, id: m.id, name: m.name };
};

/** `[overseer] N thread updates` + one block per event + the reply hint (phi format.ts). */
export function eventText(events) {
	const beat = events.length === 1 && events[0].kind === "heartbeat";
	const head = beat ? `[overseer] heartbeat · ${events[0].summary}` : `[overseer] ${events.length} thread update${events.length === 1 ? "" : "s"}`;
	const lines = [head];
	for (const e of events) {
		if (!beat) lines.push(e.kind === "heartbeat" ? `── heartbeat · ${e.summary}` : `── ${e.thread} · ${e.kind}${e.summary ? ` · ${e.summary}` : ""}`);
		if (e.text) lines.push(e.text);
	}
	lines.push(REPLY_HINT);
	return lines.join("\n");
}

/** A `report_to_overseer` as the overseer's agent mail shows it. */
export function reportText(thread, sessionId, cwd, kind, message) {
	return [
		`[message from agent "${thread}" (${sessionId.slice(0, 8)}) in ${cwd} — another phi session, not the user]`,
		`[thread ${thread} · ${kind}] ${message}`,
		`Reply with overseer {"action":"send","target":"${thread}","message":"..."} if a reply is needed (a report from your overseer thread; do not agent_message it).`,
	].join("\n");
}

function backendLabel(rec) {
	if (rec.backend === "forca") return "forca tab term_3f9a";
	if (rec.backend === "tmux") return `tmux phi-${rec.name}`;
	return `headless pid ${rec.pid ?? 61234}`;
}

export class OverseerManager {
	/** @param {import("./sessions.mjs").Registry} reg */
	constructor(reg, { enabled = true, log = () => {} } = {}) {
		this.reg = reg;
		this.enabled = enabled;
		this.log = log;
		/** overseerId → ThreadRecord[] (registry order) */
		this.records = new Map();
		/** overseerId → last counts key sent */
		this.sent = new Map();
		this.r = rng(4242);
	}

	// ----------------------------------------------------------- summaries

	isOverseer(id) {
		if ((this.records.get(id)?.length ?? 0) > 0) return true;
		for (const s of this.reg.sessions.values()) if (s.overseerLink?.sessionId === id) return true;
		return false;
	}

	/** Fields the overseer's summary gets (none with --no-overseer). */
	summaryFields(s) {
		if (!this.enabled || !this.isOverseer(s.id)) return {};
		return { isOverseer: true, threadCounts: this.counts(s.id) };
	}

	counts(id) {
		const c = { total: 0, working: 0, idle: 0, error: 0, exited: 0, closed: 0 };
		// Disjoint buckets that sum to total; live status beats registry state (phi's hub).
		for (const t of this.board(id)?.threads ?? []) {
			c.total += 1;
			if (!t.live) c[t.state === "closed" ? "closed" : "exited"] += 1;
			else if (t.status === "working") c.working += 1;
			else if (t.lastError) c.error += 1;
			else c.idle += 1;
		}
		return c;
	}

	/** `overseer.board` body, or null for an unknown overseer. */
	board(id) {
		const records = this.records.get(id) ?? [];
		const listed = new Set(records.map((r) => r.sessionId));
		const liveOnly = [...this.reg.sessions.values()]
			.filter((s) => s.overseerLink?.sessionId === id && !listed.has(s.id) && !s.closed)
			.sort((a, b) => a.startedAt - b.startedAt);
		// Unknown: no registry file (records) and no live thread naming it.
		if (!this.records.has(id) && liveOnly.length === 0) return null;
		const threads = records.map((rec) => {
			const s = this.reg.sessions.get(rec.sessionId);
			// Live status beats registry state (phi's hub): a registered thread is live whatever its record says.
			const live = !!s && !s.closed;
			const t = {
				name: rec.name,
				sessionId: rec.sessionId,
				backend: rec.backend,
				cwd: rec.cwd,
				model: rec.model,
				state: rec.state,
				live,
				createdAt: rec.createdAt,
			};
			if (rec.thinking) t.thinking = rec.thinking;
			if (rec.subagentModels) t.subagentModels = rec.subagentModels;
			if (rec.exitedAt) t.exitedAt = rec.exitedAt;
			if (rec.closedAt) t.closedAt = rec.closedAt;
			if (live) {
				t.status = s.status;
				if (s.status === "working" && s.activity) t.activity = s.activity.summary ? `${s.activity.tool} ${s.activity.summary}` : s.activity.tool;
				if (s.lastText) t.lastText = s.lastText;
				if (s.lastError) t.lastError = s.lastError;
				if (s.usage?.costUsd !== undefined) t.costUsd = s.usage.costUsd;
				if (s.usage?.contextPercent !== undefined) t.contextPercent = s.usage.contextPercent;
				t.lastActivityAt = s.lastActivityAt;
				if (s.model) t.model = `${s.model.provider}/${s.model.id}`;
				if (s.thinkingLevel) t.thinking = s.thinkingLevel;
			} else {
				if (rec.lastText) t.lastText = rec.lastText;
				if (rec.lastError) t.lastError = rec.lastError;
				if (rec.costUsd !== undefined) t.costUsd = rec.costUsd;
				if (rec.lastActivityAt) t.lastActivityAt = rec.lastActivityAt;
			}
			return t;
		});
		for (const s of liveOnly) {
			threads.push({
				name: s.overseerLink.thread ?? s.name,
				sessionId: s.id,
				backend: s.kind === "headless" ? "headless" : s.tmux ? "tmux" : "external",
				cwd: s.cwd,
				model: s.model ? `${s.model.provider}/${s.model.id}` : undefined,
				thinking: s.thinkingLevel,
				state: "running",
				live: true,
				status: s.status,
				...(s.status === "working" && s.activity ? { activity: s.activity.summary ? `${s.activity.tool} ${s.activity.summary}` : s.activity.tool } : {}),
				...(s.lastText ? { lastText: s.lastText } : {}),
				...(s.lastError ? { lastError: s.lastError } : {}),
				...(s.usage?.costUsd !== undefined ? { costUsd: s.usage.costUsd } : {}),
				createdAt: s.startedAt,
				lastActivityAt: s.lastActivityAt,
			});
		}
		// name: the overseer's live session name, else the name a live thread reports.
		const overseer = this.reg.sessions.get(id);
		const out = { sessionId: id, threads };
		const name = overseer?.name ?? [...this.reg.sessions.values()].find((s) => s.overseerLink?.sessionId === id)?.overseerLink?.name;
		if (name) out.name = name;
		return out;
	}

	/** A thread's summary changed: the overseer is upserted when its counts move. */
	touched(s) {
		const overseerId = s.overseerLink?.sessionId ?? (this.records.has(s.id) ? s.id : null);
		if (!overseerId) return;
		const overseer = this.reg.sessions.get(overseerId);
		if (!overseer || overseer.closed) return;
		const key = JSON.stringify(this.counts(overseerId));
		if (this.sent.get(overseerId) === key) return;
		this.sent.set(overseerId, key);
		overseer.markDirty();
	}

	/** A thread left the hub: its record reads exited (unless the overseer closed it). */
	gone(s) {
		for (const [overseerId, recs] of this.records) {
			const rec = recs.find((r) => r.sessionId === s.id);
			if (!rec || rec.state !== "running") continue;
			rec.state = "exited";
			rec.exitedAt = Date.now();
			rec.lastText = s.lastText;
			rec.lastActivityAt = s.lastActivityAt;
			rec.costUsd = s.usage?.costUsd;
			const overseer = this.reg.sessions.get(overseerId);
			if (overseer && !overseer.closed) overseer.markDirty();
		}
	}

	// ------------------------------------------------------------- threads

	/**
	 * Start a thread for `overseer`: a live session linked to it, a registry record, and the
	 * overseer's `spawn` tool card (running → ok, real result text).
	 */
	startThread(overseer, { name, rel, provider, modelId, thinking, backend = "headless", behavior, lastText, lastError, startedAt, usage, sessionId }) {
		const cwd = rel ? path.join(HOME, rel) : overseer.cwd;
		const now = Date.now();
		const s = new FakeSession(this.reg, {
			id: sessionId,
			name,
			cwd,
			kind: backend === "headless" ? "headless" : "interactive",
			model: model(provider, modelId),
			thinkingLevel: thinking,
			startedAt: startedAt ?? now,
			lastActivityAt: startedAt ?? now,
			seed: 900 + this.r.int(0, 999),
			behavior,
			usage: usage ?? { costUsd: 0, contextPercent: 3 },
			tmux: backend === "tmux" ? { session: `phi-${name}` } : undefined,
		});
		s.overseerLink = { sessionId: overseer.id, name: overseer.name, thread: name };
		if (lastText) s.lastText = oneLine(lastText);
		if (lastError) s.lastError = lastError;
		const rec = {
			name,
			sessionId: s.id,
			backend,
			cwd,
			model: `${provider}/${modelId}`,
			thinking,
			state: "running",
			createdAt: startedAt ?? now,
			subagentModels: SUBAGENT_POLICY,
			pid: s.pid,
		};
		const recs = this.records.get(overseer.id) ?? [];
		recs.push(rec);
		this.records.set(overseer.id, recs);
		return { s, rec, cwd };
	}

	spawnCard(overseer, rec, prompt, { ts = Date.now(), status = "ok" } = {}) {
		const ref = `${rec.model}:${rec.thinking}`;
		return {
			id: overseer.newItemId(),
			ts,
			kind: "tool",
			toolCallId: `toolu_01${this.r.alnum(22)}`,
			name: "overseer",
			summary: `overseer  spawn`,
			args: { action: "spawn", name: rec.name, cwd: rec.cwd, model: ref, backend: rec.backend === "headless" ? "headless" : "auto", subagentModels: SUBAGENT_POLICY, prompt },
			status,
			output:
				status === "ok"
					? `Started thread "${rec.name}" (${rec.sessionId}) · ${backendLabel(rec)} · ${ref} · ${rec.cwd}\nSubagent policy: default example/fast:max; allow anthropic/claude-opus-5-5:high|xhigh, example/fast:max, anthropic/claude-sonnet-5:medium.\nWatching: idle on · stall 15m · heartbeat off. [overseer] updates wake you when it goes idle, errors, stalls or exits — end your turn instead of polling.\nTalk to it: overseer {action:"send", target:"${rec.name}", message}. Inspect: overseer {action:"read", target:"${rec.name}"}.`
					: undefined,
		};
	}

	/** One more thread on the phone's "Start a new thread: …", or two for a fresh overseer. */
	async addThreads(overseer, tasks) {
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		overseer.setStatus("working");
		const a = { id: overseer.newItemId(), ts: Date.now(), kind: "assistant", text: tasks.length > 1 ? `Starting ${tasks.length} threads.` : `Starting ${tasks[0].name}.` };
		if (overseer.model) a.model = overseer.model.id;
		overseer.upsertItem(a);
		for (const task of tasks) {
			if (overseer.closed) return;
			const { s, rec } = this.startThread(overseer, { ...task, behavior: "loop" });
			const card = this.spawnCard(overseer, rec, task.prompt, { status: "running" });
			overseer.setActivity({ tool: "overseer", summary: `spawn ${task.name}` });
			overseer.upsertItem(card);
			await sleep(900);
			if (overseer.closed) return;
			this.reg.add(s);
			s.scheduleAuto(1200);
			overseer.upsertItem({ ...this.spawnCard(overseer, rec, task.prompt), id: card.id, ts: card.ts, toolCallId: card.toolCallId });
			this.touched(s);
		}
		const f = { id: overseer.newItemId(), ts: Date.now(), kind: "assistant", text: `${tasks.map((t) => t.name).join(" and ")} ${tasks.length > 1 ? "are" : "is"} running. I'll check in when they report back.` };
		if (overseer.model) f.model = overseer.model.id;
		overseer.upsertItem(f);
		overseer.lastText = oneLine(f.text);
		overseer.setStatus("idle", { finalText: f.text });
	}

	/** The prompt invoked the overseer skill (or asked plainly): this session is an overseer. */
	static isOverseerPrompt(text) {
		return /^\s*\/(skill:)?overseer\b/.test(text ?? "") || /^\s*Act as overseer\b/.test(text ?? "");
	}

	/** Returns true when the prompt was handled as overseer work. */
	handlePrompt(s, text) {
		if (s.kind === "subagent") return false;
		const add = /^\s*Start a new thread:\s*(.+)/.exec(text ?? "");
		if (add && (this.isOverseer(s.id) || this.records.has(s.id))) {
			const words = add[1].split("\n")[0].toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim().split(/\s+/).slice(0, 6);
			const name = words.join("-") || `thread-${(this.records.get(s.id)?.length ?? 0) + 1}`;
			s.upsertItem({ id: s.newItemId(), ts: Date.now(), kind: "user", text });
			void this.addThreads(s, [{ name, rel: path.relative(HOME, s.cwd) || undefined, provider: "anthropic", modelId: "claude-opus-5-5", thinking: "high", prompt: add[1].split("\n")[0] }]);
			return true;
		}
		if (OverseerManager.isOverseerPrompt(text) && !this.records.has(s.id)) {
			this.records.set(s.id, []);
			s.upsertItem({ id: s.newItemId(), ts: Date.now(), kind: "user", text });
			const rel = path.relative(HOME, s.cwd) || undefined;
			setTimeout(() => {
				if (s.closed) return;
				void this.addThreads(s, [
					{ name: "research", rel, provider: "anthropic", modelId: "claude-opus-5-5", thinking: "high", prompt: "Map the code the goal touches and report back." },
					{ name: "implement", rel, provider: "example", modelId: "fast", thinking: "xhigh", backend: "headless", prompt: "Implement the first slice and its tests." },
				]);
			}, 1500);
			return true;
		}
		return false;
	}

	// ---------------------------------------------------------------- seed

	seed() {
		const now = Date.now();
		const min = 60_000;
		const overseer = new FakeSession(this.reg, {
			id: OVERSEER_ID,
			name: OVERSEER_NAME,
			cwd: path.join(HOME, "ExampleCo"),
			model: model("anthropic", "claude-opus-5-5"),
			thinkingLevel: "xhigh",
			startedAt: now - 48 * min,
			lastActivityAt: now - 2 * min,
			seed: 81,
			usage: { costUsd: 2.41, contextPercent: 34 },
		});
		const threads = [
			{
				name: "api-filters",
				sessionId: THREAD_IDS["api-filters"],
				rel: "ExampleCo/example-service",
				provider: "anthropic",
				modelId: "claude-opus-5-5",
				thinking: "high",
				backend: "forca",
				behavior: "loop",
				prompt: "Add site, status and date-range filters to GET /v1/fleet/sites with tests; report when the endpoint is merged.",
				startedAt: now - 44 * min,
				usage: { costUsd: 1.37, contextPercent: 46 },
			},
			{
				name: "board-ui",
				sessionId: THREAD_IDS["board-ui"],
				rel: "ExampleCo/example-service",
				provider: "example",
				modelId: "fast",
				thinking: "xhigh",
				backend: "tmux",
				prompt: "Build the filters bar on the fleet board against the new endpoint; keep it to the existing components.",
				startedAt: now - 43 * min,
				lastText: "Filters bar done: site, status and date range, wired to the new endpoint. 14 tests pass.",
				usage: { costUsd: 0.18, contextPercent: 22 },
			},
			{
				name: "migrations",
				sessionId: THREAD_IDS.migrations,
				rel: "ExampleCo/example-service",
				provider: "anthropic",
				modelId: "claude-opus-5-5",
				thinking: "high",
				backend: "headless",
				prompt: "Write the migration that indexes sites by status and backfill it.",
				startedAt: now - 42 * min,
				lastText: "Migration written; running the backfill against the scratch database.",
				lastError: "429 Too Many Requests: rate limited on anthropic/claude-opus-5-5, retry after 60 s",
				usage: { costUsd: 0.64, contextPercent: 31 },
			},
			{
				name: "docs-sweep",
				sessionId: THREAD_IDS["docs-sweep"],
				rel: "ExampleCo/example-service",
				provider: "example",
				modelId: "fast",
				thinking: "xhigh",
				backend: "headless",
				prompt: "Update the API docs for the new filters.",
				startedAt: now - 41 * min,
				lastText: "Updated 6 pages under docs/api/ for the new filters; mkdocs build is clean.",
				usage: { costUsd: 0.21, contextPercent: 12 },
			},
		];
		const made = [];
		for (const t of threads) {
			const { s, rec } = this.startThread(overseer, t);
			const h = generateHistory({ seed: 300 + made.length, count: 18, endTs: now - (t.behavior ? 1 : 4 + made.length * 3) * min, modelName: t.modelId, cwd: s.cwd, withError: false });
			const firstUser = h.items.find((it) => it.kind === "user");
			if (firstUser) firstUser.text = t.prompt;
			for (const it of h.items) s.upsertItem(it);
			s.lastActivityAt = now - (t.behavior ? 1 : 4 + made.length * 3) * min;
			if (t.lastText) s.lastText = oneLine(t.lastText);
			else s.lastText = oneLine(h.lastText);
			if (t.lastError) {
				s.lastError = t.lastError;
				const at = s.lastActivityAt;
				s.upsertItem({ id: s.newItemId(), ts: at, kind: "assistant", text: "", model: t.modelId, error: t.lastError });
				s.lastActivityAt = at; // upsertItem stamps "now"
			}
			made.push({ s, rec, t });
		}

		// docs-sweep finished and the overseer closed it: registry only, kept as a stored session.
		const docs = made[3];
		docs.rec.state = "closed";
		docs.rec.closedAt = now - 30 * min;
		docs.rec.lastText = docs.t.lastText;
		docs.rec.lastActivityAt = now - 31 * min;
		docs.rec.costUsd = 0.21;
		this.closedSession = docs.s;

		// The overseer's transcript.
		const items = [];
		let ts = now - 48 * min;
		const at = (m) => (ts = now - m * min);
		const push = (it) => items.push({ id: overseer.newItemId(), ...it });
		push({
			ts: at(48),
			kind: "user",
			text:
				"/skill:overseer Ship the API filters end to end: the endpoint, the board's filters bar, the status index migration, and a docs sweep.\n\nDefaults for the threads you start:\n- Thread model: anthropic/claude-opus-5-5 with thinking high (\"anthropic/claude-opus-5-5:high\").\n- Thread window: auto (backend \"auto\": a FORCA tab or tmux window when there is one).\n- Subagent models: pin each thread's subagentModels to the overseer skill's policy for its model.\n- At most 4 threads at a time.",
		});
		push({ ts: at(47), kind: "assistant", model: "claude-opus-5-5", thinking: "Four independent workstreams; the UI depends on the endpoint's shape, which is already specified.", text: "Four workstreams, one thread each. The UI can start now: the endpoint's shape is fixed." });
		for (const m of made) {
			const card = this.spawnCard(overseer, m.rec, m.t.prompt, { ts: at(44 - made.indexOf(m)) });
			items.push(card);
		}
		push({ ts: at(40), kind: "assistant", model: "claude-opus-5-5", text: "All four threads are running. I'll wait for their updates." });
		push({ ts: at(31), kind: "note", label: "agent_mail", text: reportText("docs-sweep", THREAD_IDS["docs-sweep"], docs.s.cwd, "done", "Updated 6 pages under docs/api/ for the new filters; mkdocs build is clean.") });
		push({
			ts: at(31),
			kind: "note",
			label: "overseer_event",
			text: eventText([
				{ thread: "docs-sweep", kind: "idle", summary: "turn finished · example/fast:xhigh · $0.21", text: "Updated 6 pages under docs/api/ for the new filters; mkdocs build is clean." },
				{ thread: "migrations", kind: "error", summary: "the last turn ended in an error (anthropic/claude-opus-5-5)", text: made[2].t.lastError },
			]),
		});
		push({ ts: at(30), kind: "assistant", model: "claude-opus-5-5", text: "docs-sweep is done; closing it. migrations hit a rate limit, so I'll look at where it stopped." });
		items.push({
			id: overseer.newItemId(),
			ts: at(30),
			kind: "tool",
			toolCallId: `toolu_01${this.r.alnum(22)}`,
			name: "overseer",
			summary: "overseer  close",
			args: { action: "close", target: "docs-sweep" },
			status: "ok",
			output: `Closed "docs-sweep": session closed. Resume it later with overseer {action:"resume", target:"${THREAD_IDS["docs-sweep"]}"}.`,
		});
		items.push({
			id: overseer.newItemId(),
			ts: at(29),
			kind: "tool",
			toolCallId: `toolu_01${this.r.alnum(22)}`,
			name: "overseer",
			summary: "overseer  read",
			args: { action: "read", target: "migrations" },
			status: "ok",
			output: `migrations (${THREAD_IDS.migrations}) · idle · anthropic/claude-opus-5-5:high · quiet 2m\n[12:01:10] tool bash npm run migrate:backfill → error · 429 Too Many Requests`,
		});
		push({ ts: at(12), kind: "note", label: "agent_mail", text: reportText("board-ui", THREAD_IDS["board-ui"], made[1].s.cwd, "question", "Should the date-range filter default to the last 7 days or to all time?") });
		items.push({
			id: overseer.newItemId(),
			ts: at(11),
			kind: "tool",
			toolCallId: `toolu_01${this.r.alnum(22)}`,
			name: "overseer",
			summary: "overseer  send",
			args: { action: "send", target: "board-ui", message: "Default to the last 7 days, and keep 'All time' one tap away in the same menu." },
			status: "ok",
			output: 'Sent to "board-ui" (auto). Its reply arrives as an [overseer] update when it goes idle.',
		});
		push({ ts: at(4), kind: "note", label: "overseer_event", text: eventText([{ thread: "board-ui", kind: "idle", summary: "turn finished · example/fast:xhigh · $0.18", text: made[1].t.lastText }]) });
		push({
			ts: at(3),
			kind: "note",
			label: "overseer_event",
			text: eventText([{ thread: "", kind: "heartbeat", summary: "3 threads (1 working)", text: "NAME         ID          BACKEND   STATUS   HEALTH  MODEL\napi-filters  1a2b3c4d-5  forca     working  ok      anthropic/claude-opus-5-5:high" }]),
		});
		push({ ts: at(2), kind: "assistant", model: "claude-opus-5-5", text: "board-ui is done with the 7-day default. api-filters is still working; migrations waits for its rate limit to clear before I retry it." });
		for (const it of items) overseer.upsertItem(it);
		overseer.lastText = oneLine(items[items.length - 1].text);
		overseer.lastActivityAt = now - 2 * min;

		this.reg.add(overseer);
		for (const m of made) {
			if (m.rec.state === "closed") continue;
			this.reg.add(m.s);
			if (m.t.behavior) m.s.scheduleAuto(2500);
		}
		return overseer;
	}

	/** Stored sessions for Session history: the closed thread, and a past overseer with three threads. */
	storedEntries() {
		const now = Date.now();
		const out = [];
		if (this.closedSession) {
			const s = this.closedSession;
			out.push({
				id: s.id,
				title: "docs-sweep",
				named: true,
				cwd: s.cwd,
				createdAt: s.startedAt,
				modifiedAt: now - 31 * 60_000,
				model: { provider: s.model.provider, id: s.model.id },
				items: s.items,
				overseer: { sessionId: OVERSEER_ID, name: OVERSEER_NAME, thread: "docs-sweep" },
			});
		}
		const day = 86_400_000;
		const end = now - day - 3 * 3600_000;
		const name = "Overseer · nightly dependency bumps";
		const h = generateHistory({ seed: 777, count: 14, endTs: end, modelName: "claude-opus-5-5", cwd: path.join(HOME, "ExampleCo"), withError: false });
		out.push({ id: PAST_OVERSEER_ID, title: name, named: true, cwd: path.join(HOME, "ExampleCo"), createdAt: end - 2 * 3600_000, modifiedAt: end, model: { provider: "anthropic", id: "claude-opus-5-5" }, items: h.items, isOverseer: true });
		PAST_THREADS.forEach(([thread, id, rel], i) => {
			const th = generateHistory({ seed: 780 + i, count: 10, endTs: end - (i + 1) * 600_000, modelName: "fast", cwd: path.join(HOME, rel), withError: false });
			out.push({
				id,
				title: thread,
				named: true,
				cwd: path.join(HOME, rel),
				createdAt: end - 2 * 3600_000 + (i + 1) * 60_000,
				modifiedAt: end - (i + 1) * 600_000,
				model: { provider: "example", id: "fast" },
				items: th.items,
				overseer: { sessionId: PAST_OVERSEER_ID, name, thread },
			});
		});
		return out;
	}
}

/** Seeds the overseer and its threads; returns the manager (registry.overseers). */
export function attachOverseers(reg, { enabled = true, log } = {}) {
	const mgr = new OverseerManager(reg, { enabled, log });
	reg.overseers = mgr;
	mgr.seed();
	return mgr;
}
