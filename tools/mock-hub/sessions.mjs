// Fake session registry + scripted session runtime for the mock hub.

import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
	TURNS,
	MODELS,
	HOME,
	THINKING_LEVELS,
	COMMANDS,
	SKILLS,
	PROMPTS,
	rng,
	generateHistory,
	oneLine,
	echoTurn,
	findModel,
	commandsVersion,
	expandPrompt,
} from "./content.mjs";

export const STREAM_MS = 150; // ≤ 8 item updates/s per streaming item
export const UPSERT_MIN_MS = 520; // session.upsert ≤ 2/s per session, trailing edge
export const STATE_MIN_MS = 260; // `state` events ≤ 4/s per session, trailing edge (clarification 11)
const COMMANDS_VERSION = commandsVersion(COMMANDS);
/** TUI built-ins phi remote refuses from the phone (they need a terminal). */
const TERMINAL_ONLY = new Set(["settings", "resume", "fork", "tree", "export", "share", "copy", "hotkeys", "login", "logout", "quit", "reload", "session", "changelog", "scoped-models", "remote"]);

/** Thinking level as reported: a non-reasoning model always reports "off" (clarification 7). */
export function effectiveThinking(model, level) {
	if (!model) return level;
	const m = findModel(model.provider, model.id);
	return m && !m.reasoning ? "off" : level;
}

class Aborted extends Error {
	constructor() {
		super("aborted");
		this.name = "Aborted";
	}
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Aborted());
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(new Aborted());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function chunks(text, r) {
	const out = [];
	let i = 0;
	while (i < text.length) {
		const n = r.int(18, 46);
		out.push(text.slice(0, Math.min(text.length, i + n)));
		i += n;
	}
	return out;
}

export class FakeSession {
	/**
	 * @param {Registry} reg
	 * @param {object} o
	 */
	constructor(reg, o) {
		this.reg = reg;
		this.id = o.id ?? randomUUID();
		this.name = o.name;
		this.cwd = o.cwd;
		this.pid = o.pid ?? 40000 + Math.floor(Math.random() * 20000);
		this.kind = o.kind ?? "interactive";
		this.status = "idle";
		this.model = o.model; // { provider, id, name }
		this.thinkingPref = o.thinkingLevel; // what the user asked for
		this.thinkingLevel = effectiveThinking(o.model, o.thinkingLevel); // what is reported
		this.startedAt = o.startedAt ?? Date.now();
		this.lastActivityAt = o.lastActivityAt ?? this.startedAt;
		this.lastText = o.lastText ? oneLine(o.lastText) : undefined;
		this.tmux = o.tmux; // { session, window? } when the session runs inside tmux
		this.activity = undefined;
		this.usage = o.usage ?? { costUsd: 0, contextPercent: 0 };
		this.behavior = o.behavior ?? "manual"; // manual | loop | periodic
		this.items = [];
		this.index = new Map();
		this.r = rng(o.seed ?? Math.floor(Math.random() * 1e9));
		this.subscribers = new Set();
		this.run = null; // AbortController of the current run
		this.cur = null; // { assistant, tool } items currently live
		this.queue = []; // followUp prompts
		this.timer = null;
		this.turnIdx = 0;
		this.closed = false;
		this.upsertTimer = null;
		this.lastUpsertAt = 0;
		this.stateTimer = null;
		this.lastStateAt = 0;
		this.lastStateKey = JSON.stringify(this.liveState());
		if (o.items) for (const it of o.items) this.#put(it);
	}

	summary() {
		const s = {
			sessionId: this.id,
			name: this.name,
			cwd: this.cwd,
			host: this.reg.hostName,
			pid: this.pid,
			kind: this.kind,
			status: this.status,
			startedAt: this.startedAt,
			lastActivityAt: this.lastActivityAt,
		};
		if (this.model) s.model = { ...this.model };
		if (this.thinkingLevel) s.thinkingLevel = this.thinkingLevel;
		if (this.lastText) s.lastText = this.lastText;
		if (this.activity) s.activity = { ...this.activity };
		if (this.usage) s.usage = { ...this.usage };
		if (this.reg.commandsEnabled) s.commandsVersion = COMMANDS_VERSION;
		if (this.tmux) s.tmux = { ...this.tmux };
		// Subagents (v1 addition): a parent reports how many of its subagents run, of how many.
		const counts = this.reg.subagentCounts(this.id);
		if (counts) s.subagents = counts;
		// Overseer threads (exo.11): the overseer that started it, and the last turn's error.
		if (this.overseerLink) s.overseer = { ...this.overseerLink };
		if (this.lastError) s.lastError = this.lastError;
		// Overseers (v1 addition): isOverseer + threadCounts (overseer.mjs; none with --no-overseer).
		Object.assign(s, this.reg.overseers?.summaryFields(this) ?? {});
		return s;
	}

	/** `commands.list` (docs/PROTOCOL.md "Slash commands (v1 addition)"). */
	commands() {
		return COMMANDS.map((c) => ({ ...c }));
	}

	liveState() {
		const st = { status: this.status };
		if (this.activity) st.activity = { ...this.activity };
		return st;
	}

	newItemId() {
		let id;
		do id = this.r.hex(8);
		while (this.index.has(id));
		return id;
	}

	#put(item) {
		const idx = this.index.get(item.id);
		if (idx === undefined) {
			this.index.set(item.id, this.items.length);
			this.items.push(item);
		} else this.items[idx] = item;
	}

	/** Upsert an item and stream it to subscribers. */
	upsertItem(item) {
		const copy = structuredClone(item);
		this.#put(copy);
		this.lastActivityAt = Date.now();
		this.reg.toSubscribers(this, { t: "session.event", sessionId: this.id, event: { type: "item.upsert", item: copy } });
	}

	/** Throttled session.upsert broadcast (≤ 2/s, trailing edge). */
	markDirty() {
		if (this.closed) return;
		if (this.upsertTimer) return;
		const wait = Math.max(0, this.lastUpsertAt + UPSERT_MIN_MS - Date.now());
		const fire = () => {
			this.upsertTimer = null;
			if (this.closed) return;
			this.lastUpsertAt = Date.now();
			this.reg.broadcast({ t: "session.upsert", session: this.summary() }, this);
			// An overseer's counts follow its threads (overseer.mjs).
			this.reg.overseers?.touched(this);
		};
		if (wait === 0) fire();
		else this.upsertTimer = setTimeout(fire, wait);
	}

	/**
	 * `state` event on every status/activity change, ≤ 4/s per session with a trailing edge: the
	 * final state is always delivered; unchanged states are not re-sent.
	 */
	emitState() {
		if (this.closed || this.stateTimer) return; // a pending trailing fire sends the latest state
		if (JSON.stringify(this.liveState()) === this.lastStateKey) return;
		const fire = () => {
			this.stateTimer = null;
			if (this.closed) return;
			const state = this.liveState();
			const key = JSON.stringify(state);
			if (key === this.lastStateKey) return;
			this.lastStateKey = key;
			this.lastStateAt = Date.now();
			this.reg.toSubscribers(this, { t: "session.event", sessionId: this.id, event: { type: "state", state } });
		};
		const wait = Math.max(0, this.lastStateAt + STATE_MIN_MS - Date.now());
		if (wait === 0) fire();
		else this.stateTimer = setTimeout(fire, wait);
	}

	setActivity(activity) {
		this.activity = activity;
		this.emitState();
		this.markDirty();
	}

	/** `aborted`: the run was aborted by a client — an abort never triggers a push (clarification 9). */
	setStatus(status, { finalText, error, aborted = false } = {}) {
		const prev = this.status;
		this.status = status;
		if (status === "idle") this.activity = undefined;
		// lastError: the last turn's error, cleared by the next turn that ends without one.
		if (status === "idle" && prev === "working" && !aborted) {
			if (error) this.lastError = oneLine(error, 200);
			else delete this.lastError;
		}
		this.lastActivityAt = Date.now();
		this.emitState();
		this.markDirty();
		if (prev === "working" && status === "idle" && !aborted) this.reg.onFinished(this, { finalText, error });
	}

	setModel(m) {
		this.model = { provider: m.provider, id: m.id, name: m.name };
		this.thinkingLevel = effectiveThinking(this.model, this.thinkingPref ?? "medium");
		this.markDirty();
	}

	setThinking(level) {
		this.thinkingPref = level;
		this.thinkingLevel = effectiveThinking(this.model, level);
		this.markDirty();
	}

	// ----------------------------------------------------------------- runs

	/** Play a scripted turn now (a user item first when `turn.user` is set). False when busy. */
	runTurn(turn) {
		if (this.closed || this.status !== "idle" || this.run) return false;
		if (turn.user) this.upsertItem({ id: this.newItemId(), ts: Date.now(), kind: "user", text: turn.user });
		this.#start(turn);
		return true;
	}

	scheduleAuto(ms) {
		clearTimeout(this.timer);
		this.timer = null;
		if (this.closed) return;
		if (this.behavior === "loop") {
			this.timer = setTimeout(() => this.#autoTurn(), ms ?? this.r.int(4000, 6500));
		} else if (this.behavior === "periodic") {
			this.timer = setTimeout(() => this.#autoTurn(), ms ?? this.reg.periodicMs);
		}
	}

	#autoTurn() {
		this.timer = null;
		if (this.status !== "idle" || this.closed) return this.scheduleAuto();
		const turn = this.behavior === "periodic" ? TURNS[[4, 2][this.turnIdx++ % 2]] : TURNS[this.turnIdx++ % TURNS.length];
		this.upsertItem({ id: this.newItemId(), ts: Date.now(), kind: "user", text: turn.user });
		this.#start(turn);
	}

	#start(turn) {
		clearTimeout(this.timer);
		this.timer = null;
		const ctl = new AbortController();
		this.run = ctl;
		this.setStatus("working");
		this.#play(turn, ctl.signal).then(
			(finalText) => {
				if (this.run !== ctl) return;
				this.run = null;
				this.cur = null;
				this.setStatus("idle", { finalText });
				this.#afterRun();
			},
			(err) => {
				if (!(err instanceof Aborted)) {
					this.reg.log(`[session ${this.id.slice(0, 8)}] run crashed: ${err?.stack ?? err}`);
					if (this.run === ctl) {
						this.run = null;
						this.setStatus("idle", { error: String(err?.message ?? err) });
					}
				}
			},
		);
	}

	#afterRun() {
		if (this.closed) return;
		const next = this.queue.shift();
		if (next) {
			this.upsertItem(next.item);
			this.#start(echoTurn(next.item.text, this.cwd));
			return;
		}
		this.scheduleAuto();
	}

	async #play(turn, signal) {
		const modelName = this.model?.id;
		// assistant message (thinking + text), streamed
		const a = { id: this.newItemId(), ts: Date.now(), kind: "assistant", text: "", streaming: true };
		if (modelName) a.model = modelName;
		this.cur = { assistant: a, tool: null };
		this.setActivity(undefined);
		if (turn.thinking && this.thinkingLevel !== "off") {
			for (const part of chunks(turn.thinking, this.r)) {
				a.thinking = part;
				this.upsertItem(a);
				await sleep(STREAM_MS, signal);
			}
		}
		if (turn.text) {
			for (const part of chunks(turn.text, this.r)) {
				a.text = part;
				this.upsertItem(a);
				await sleep(STREAM_MS, signal);
			}
		}
		delete a.streaming;
		a.text = turn.text ?? "";
		this.upsertItem(a);
		if (a.text) {
			this.lastText = oneLine(a.text);
			this.markDirty();
		}
		// tool calls, one item each, running → ok/error
		for (const t of turn.tools) {
			const tool = {
				id: this.newItemId(),
				ts: Date.now(),
				kind: "tool",
				toolCallId: `toolu_01${this.r.alnum(22)}`,
				name: t.name,
				summary: t.summary,
				args: t.args,
				status: "running",
			};
			this.cur.tool = tool;
			this.upsertItem(tool);
			this.setActivity({ tool: t.name, summary: t.summary.replace(/^\S+\s+/, "") });
			t.onStart?.(tool); // e.g. the `subagent` tool launching its child sessions
			const out = (t.output ?? "").replaceAll("${CWD}", this.cwd);
			const lines = out.split("\n");
			if (t.name === "bash" && lines.length > 6) {
				// streamed partial output, like phi's bash tool updates
				const steps = 3;
				for (let i = 1; i < steps; i++) {
					await sleep(Math.max(STREAM_MS, Math.floor(t.ms / steps)), signal);
					tool.output = lines.slice(0, Math.floor((lines.length * i) / steps)).join("\n");
					this.upsertItem(tool);
				}
				await sleep(Math.max(STREAM_MS, Math.floor(t.ms / steps)), signal);
			} else {
				await sleep(t.ms, signal);
			}
			tool.status = t.status === "error" ? "error" : "ok";
			tool.output = out;
			this.upsertItem(tool);
			this.cur.tool = null;
			this.usage.costUsd = Math.round((this.usage.costUsd + 0.004 + this.r.next() * 0.02) * 10000) / 10000;
			this.usage.contextPercent = Math.min(95, Math.round((this.usage.contextPercent + 0.4 + this.r.next()) * 10) / 10);
		}
		this.setActivity(undefined);
		// final assistant message
		const f = { id: this.newItemId(), ts: Date.now(), kind: "assistant", text: "", streaming: true };
		if (modelName) f.model = modelName;
		this.cur.assistant = f;
		for (const part of chunks(turn.final, this.r)) {
			f.text = part;
			this.upsertItem(f);
			if (part.length > 40) {
				this.lastText = oneLine(part);
				this.markDirty();
			}
			await sleep(STREAM_MS, signal);
		}
		f.text = turn.final;
		delete f.streaming;
		this.upsertItem(f);
		this.lastText = oneLine(turn.final);
		return turn.final;
	}

	// ------------------------------------------------------------- commands

	/**
	 * Returns `{ error: { code, message } }` when the prompt is refused (the hub nacks it), else
	 * undefined. Slash commands are routed the way phi remote's bridge does (built-ins, extension
	 * commands, prompt templates, skills, then plain text).
	 */
	prompt(rawText, images, mode = "auto") {
		// Overseers: a first prompt that invokes the overseer skill, or "Start a new thread: …".
		if (this.reg.overseers?.handlePrompt(this, rawText)) return;
		const routed = this.reg.commandsEnabled ? this.#route(rawText) : { userText: rawText, turn: rawText };
		if (routed.handled) return routed.error ? { error: routed.error } : undefined;
		const text = routed.userText;
		const item = { id: this.newItemId(), ts: Date.now(), kind: "user", text };
		if (images?.length) item.images = images.length;
		if (this.status === "idle") {
			this.upsertItem(item);
			this.#start(echoTurn(routed.turn, this.cwd));
			return;
		}
		if (mode === "followUp") {
			this.queue.push({ item });
			this.upsertItem({ id: this.newItemId(), ts: Date.now(), kind: "note", label: "queued", text: `Follow-up queued: ${oneLine(text, 120)}` });
			return;
		}
		// auto / steer while working → steer
		this.upsertItem(item);
		this.upsertItem({ id: this.newItemId(), ts: Date.now(), kind: "note", label: "steer", text: "steered — delivered after the current tool call" });
	}

	#route(text) {
		const t = text.trim();
		if (!t.startsWith("/")) return { userText: text, turn: text };
		const sp = t.indexOf(" ");
		const name = sp === -1 ? t.slice(1) : t.slice(1, sp);
		const args = sp === -1 ? "" : t.slice(sp + 1).trim();
		const refuse = (code, message) => ({ handled: true, error: { code, message } });
		switch (name) {
			case "new":
			case "clear":
				this.reg.replaceWithNew(this);
				return { handled: true };
			case "compact":
				this.#compact(args);
				return { handled: true };
			case "name":
				if (!args) return refuse("bad_request", "/name needs a name");
				this.name = args.slice(0, 120);
				this.markDirty();
				return { handled: true };
			case "model": {
				const [provider, id] = args.includes("/") ? args.split("/", 2) : [undefined, args];
				const m = MODELS.find((x) => x.id === id && (!provider || x.provider === provider));
				if (!m) return refuse("not_found", `unknown model ${args || "(none)"}`);
				this.setModel(m);
				return { handled: true };
			}
			case "thinking":
				if (!THINKING_LEVELS.includes(args)) return refuse("bad_request", `level must be one of ${THINKING_LEVELS.join(", ")}`);
				this.setThinking(args);
				return { handled: true };
			case "mcp":
				this.upsertItem({
					id: this.newItemId(),
					ts: Date.now(),
					kind: "note",
					label: "mcp",
					text: "MCP servers: browser (connected, 41 tools), github (connected, 18 tools), slack (idle)",
				});
				return { handled: true };
		}
		if (TERMINAL_ONLY.has(name)) return refuse("bad_request", `/${name} needs the phi terminal`);
		const prompt = PROMPTS.find((p) => p.name === name);
		if (prompt) return { userText: expandPrompt(prompt, args), turn: args || prompt.name };
		const skillName = name.startsWith("skill:") ? name.slice("skill:".length) : name;
		const skill = SKILLS.find((x) => x.name === skillName);
		// The session expands `/skill:x args`; the bridge shows it as typed (`/skill:x args`) and also
		// accepts the bare `/x` when nothing else has that name.
		if (skill) return { userText: `/skill:${skill.name}${args ? ` ${args}` : ""}`, turn: args || `the ${skill.name} skill` };
		return { userText: text, turn: text };
	}

	/** /compact: a compaction summary note, a fresh context, and a reset (clients resubscribe). */
	#compact(args) {
		const messages = this.items.filter((it) => it.kind === "user" || it.kind === "assistant").length;
		this.upsertItem({
			id: this.newItemId(),
			ts: Date.now(),
			kind: "note",
			label: "compaction",
			text: `Compacted ${messages} messages into a summary${args ? ` (focus: ${oneLine(args, 80)})` : ""}.`,
		});
		this.usage.contextPercent = 6;
		this.markDirty();
		this.reg.toSubscribers(this, { t: "session.event", sessionId: this.id, event: { type: "reset" } });
	}

	/** Abort the current run. Idle → no-op (false). Never pushes. */
	abort() {
		if (!this.run) return false;
		const ctl = this.run;
		this.run = null;
		ctl.abort();
		this.queue = [];
		if (this.cur?.tool && this.cur.tool.status === "running") {
			this.cur.tool.status = "error";
			this.cur.tool.output = `${this.cur.tool.output ? `${this.cur.tool.output}\n` : ""}Operation aborted`;
			this.upsertItem(this.cur.tool);
		}
		// only the assistant item that is still streaming gets error: "aborted"
		if (this.cur?.assistant?.streaming) {
			delete this.cur.assistant.streaming;
			this.cur.assistant.error = "aborted";
			this.upsertItem(this.cur.assistant);
		}
		this.cur = null;
		this.setStatus("idle", { aborted: true });
		this.scheduleAuto(this.behavior === "loop" ? 8000 : undefined);
		return true;
	}

	close() {
		this.closed = true;
		clearTimeout(this.timer);
		clearTimeout(this.upsertTimer);
		clearTimeout(this.stateTimer);
		if (this.run) this.run.abort();
		this.run = null;
	}
}

export class Registry {
	constructor({ hostName, log, onPush, periodicMs = 45_000, commandsEnabled = true }) {
		this.hostName = hostName;
		this.commandsEnabled = commandsEnabled;
		this.log = log;
		this.onPush = onPush;
		this.periodicMs = periodicMs;
		this.sessions = new Map();
		this.conns = new Set(); // authenticated connections
		this.recentCwds = []; // most recent first
		/** Subagents (v1 addition): set by subagents.mjs `attachSubagents`. */
		this.subagents = null;
		/** Session history (v1 addition): a session that stops being live is kept (history.mjs). */
		this.onEnded = null;
	}

	/** `{ running, total }` for a parent with subagents, else undefined. */
	subagentCounts(parentId) {
		return this.subagentsHidden ? undefined : this.subagents?.counts(parentId);
	}

	/**
	 * Subagent sessions are only visible to clients that sent `hello.features: ["subagents"]`
	 * (and to nobody with --no-subagents).
	 */
	visibleTo(conn, s) {
		return s.kind !== "subagent" || (!this.subagentsHidden && !!conn.features?.has("subagents"));
	}

	add(s, { announce = true } = {}) {
		this.sessions.set(s.id, s);
		this.touchCwd(s.cwd);
		if (announce) this.announce(s);
		return s;
	}

	announce(s) {
		if (s.closed) return;
		this.broadcast({ t: "session.upsert", session: s.summary() }, s);
		s.lastUpsertAt = Date.now();
	}

	remove(id) {
		const s = this.sessions.get(id);
		if (!s) return;
		this.subagents?.parentGone(id); // its subagents' removes go first
		this.overseers?.gone(s);
		this.onEnded?.(s);
		s.close();
		this.sessions.delete(id);
		for (const c of this.conns) c.subscriptions.delete(id);
		this.broadcast({ t: "session.remove", sessionId: id }, s);
	}

	/**
	 * /new (and /clear): the same phi process continues under a new session id. Subscribers of the
	 * old id get `reset { replacedBy }`, everyone `session.remove { replacedBy }`, then the new
	 * session's `session.upsert`.
	 */
	replaceWithNew(old) {
		const s = new FakeSession(this, {
			name: path.basename(old.cwd) || old.cwd,
			cwd: old.cwd,
			pid: old.pid,
			kind: old.kind,
			model: old.model ? { ...old.model } : undefined,
			thinkingLevel: old.thinkingPref,
		});
		this.toSubscribers(old, { t: "session.event", sessionId: old.id, event: { type: "reset", replacedBy: s.id } });
		this.subagents?.parentGone(old.id); // its subagents' removes go first
		this.onEnded?.(old);
		old.close();
		this.sessions.delete(old.id);
		for (const c of this.conns) c.subscriptions.delete(old.id);
		this.broadcast({ t: "session.remove", sessionId: old.id, replacedBy: s.id });
		this.add(s);
		this.log(`[session ${old.id.slice(0, 8)}] /new → ${s.id.slice(0, 8)}`);
		return s;
	}

	touchCwd(cwd) {
		this.recentCwds = [cwd, ...this.recentCwds.filter((c) => c !== cwd)].slice(0, 30);
	}

	/** `about`: the session the frame is about, so subagent frames reach opted-in clients only. */
	broadcast(frame, about) {
		for (const c of this.conns) if (!about || this.visibleTo(c, about)) c.send(frame);
	}

	toSubscribers(s, frame) {
		for (const c of this.conns) if (c.subscriptions.has(s.id)) c.send(frame);
	}

	onFinished(s, { finalText, error }) {
		if (s.kind === "subagent") return; // never pushed (docs/PROTOCOL.md "Subagents")
		this.onPush?.(s, { body: oneLine(error ? `Error: ${error}` : (finalText ?? s.lastText ?? ""), 140), error });
	}

	/** Seed the fake sessions described in tools/README.md. */
	seed() {
		const now = Date.now();
		const m = (p, id) => {
			const x = findModel(p, id);
			return { provider: x.provider, id: x.id, name: x.name };
		};
		const cwdOf = (rel) => path.join(HOME, rel);

		// (a) working session that loops realistic turns
		const work = new FakeSession(this, {
			id: "5b0c4f7e-1d2a-4c3b-9e8f-a1b2c3d4e5f6",
			name: "phi remote hub — session registry",
			cwd: cwdOf("ExampleCo/phi"),
			model: m("anthropic", "claude-opus-5-5"),
			thinkingLevel: "high",
			startedAt: now - 52 * 60_000,
			seed: 11,
			behavior: "loop",
			usage: { costUsd: 3.4172, contextPercent: 41.5 },
		});
		const h0 = generateHistory({ seed: 11, count: 60, endTs: now - 5_000, modelName: "claude-opus-5-5", cwd: work.cwd });
		for (const it of h0.items) work.upsertItem(it);
		work.lastText = oneLine(h0.lastText);

		// (b) idle sessions with long histories
		const idle = [
			{ id: "9a7e2c41-6f0b-4d8e-b3a2-7c5d1e9f0a12", name: "Fix flaky login test", rel: "ExampleCo/example-service", model: m("anthropic", "claude-sonnet-5"), thinking: "medium", count: 340, seed: 21, images: false, age: 3 * 3600_000, usage: { costUsd: 1.92, contextPercent: 63 } },
			{ id: "c3d9e1f0-2b4a-4e6c-8d7f-0a1b2c3d4e5f", name: "Grafana panel for example-service", rel: "ExampleCo/deployments", model: m("example", "fast"), thinking: "xhigh", count: 640, seed: 31, images: true, age: 26 * 3600_000, usage: { costUsd: 0.38, contextPercent: 88.2 } },
			{ id: "e8f7a6b5-c4d3-4e2f-9a1b-0c9d8e7f6a5b", name: "example-service example-service", rel: "ExampleCo/example-service", model: m("openai", "gpt-5.6"), thinking: "low", count: 310, seed: 41, images: true, age: 5 * 86400_000, usage: { costUsd: 0.77, contextPercent: 22 } },
			// A devbox tab: runs inside tmux, so its name is the tmux session name.
			{ id: "7d3c2b1a-0f9e-4d8c-b7a6-5e4d3c2b1a09", name: "example-service", rel: "ExampleCo/example-service", model: m("example", "fast"), thinking: "high", count: 48, seed: 61, images: false, age: 40 * 60_000, usage: { costUsd: 0.12, contextPercent: 17 }, tmux: { session: "example-service", window: "1" } },
		];
		for (const d of idle) {
			const end = now - d.age;
			const s = new FakeSession(this, {
				id: d.id,
				name: d.name,
				cwd: cwdOf(d.rel),
				model: d.model,
				thinkingLevel: d.thinking,
				startedAt: end - d.count * 50_000,
				lastActivityAt: end,
				seed: d.seed,
				usage: d.usage,
				tmux: d.tmux,
			});
			const h = generateHistory({ seed: d.seed, count: d.count, endTs: end, modelName: d.model.id, cwd: s.cwd, withImages: d.images });
			for (const it of h.items) s.upsertItem(it);
			s.lastActivityAt = end;
			s.lastText = oneLine(h.lastText);
			this.add(s);
		}

		// (c) session that finishes every ~45 s (push notifications)
		const pinger = new FakeSession(this, {
			id: "1f2e3d4c-5b6a-4798-8a9b-c0d1e2f3a4b5",
			name: "watch CI on feat/remote-hub",
			cwd: cwdOf("ExampleCo/phi-remote"),
			model: m("anthropic", "claude-haiku-4-5"),
			thinkingLevel: "off",
			startedAt: now - 15 * 60_000,
			seed: 51,
			behavior: "periodic",
			usage: { costUsd: 0.05, contextPercent: 4 },
		});
		const h3 = generateHistory({ seed: 51, count: 24, endTs: now - 30_000, modelName: "claude-haiku-4-5", cwd: pinger.cwd, withError: false });
		for (const it of h3.items) pinger.upsertItem(it);
		pinger.lastText = oneLine(h3.lastText);

		this.add(work);
		this.add(pinger);
		work.scheduleAuto(1500);
		pinger.scheduleAuto(8000);
	}
}

export { MODELS };
export const HOSTNAME = os.hostname().replace(/\.local$/, "");
