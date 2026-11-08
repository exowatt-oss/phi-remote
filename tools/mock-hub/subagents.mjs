// Subagents (docs/PROTOCOL.md "Subagents (v1 addition)") for the mock hub.
//
// A parent session ("Subagents in phi remote", ~/ExampleCo/phi-remote) runs a turn whose `subagent`
// tool call launches three background subagents, each reported as a session of its own
// (`kind: "subagent"`, id `<parent>~sa~<runId>`):
//   scout  (agent, no name) finishes after ~7 s   (done)
//   ws-b   fails after ~6 s; its model has provider "" (only an id is known)
//   ws-c   long-running, streams items and tool calls for --subagent-long-ms (default 15 min),
//          and gets a "[message from your parent agent] …" user item after its second cycle
// and, later in the same turn, a second launch of two more (so a thread has several launches in
// play, and more subagents than the app's pinned tray lists): lint-fix and docs, long-running
// for half and a third of --subagent-long-ms. The next round's three all succeed.
// Shapes follow docs/PROTOCOL.md "Subagents (v1 addition)": `name` = task name, else agent, else
// the task's first line (repeats get " #2"); `subagent.name` only for an explicit name; the
// transcript starts with `{ id: "u:task", kind: "user" }`; `pid` is the parent's.
// When all three are back the parent reports on them, and a new round starts after a rest.
// Steer (`session.prompt`) and stop (`session.abort`) work while a run is going; a finished run
// refuses prompts with `bad_request "subagent finished"`. Only clients that sent
// `hello.features: ["subagents"]` see subagent sessions (Registry.visibleTo).

import path from "node:path";
import { randomUUID } from "node:crypto";
import { FakeSession } from "./sessions.mjs";
import { HOME, findModel, generateHistory, oneLine } from "./content.mjs";

export const SUBAGENT_PARENT_ID = "a4e1c9d2-7b3f-4c6a-9e8d-2f1b0c3d4e5f";
const STREAM_MS = 150;

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

const model = (provider, id) => {
	const m = findModel(provider, id);
	return { provider: m.provider, id: m.id, name: m.name };
};
/** phi's display name for a task: name, else agent, else the task's first line (≤ 60). */
const displayName = (t) => t.name ?? t.agent ?? oneLine(t.task, 60);

/** A name repeated within one call gets " #2", " #3". */
function numbered(names) {
	const seen = new Map();
	return names.map((x) => {
		const k = (seen.get(x) ?? 0) + 1;
		seen.set(x, k);
		return k > 1 ? `${x} #${k}` : x;
	});
}

function fmtDuration(ms) {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// ------------------------------------------------------------------ scripts

const REGISTRY_TS = `export class SessionRegistry {
	private sessions = new Map<string, SessionSummary>();
	private lastEmit = new Map<string, number>();

	upsert(s: SessionSummary): void {
		this.sessions.set(s.sessionId, s);
		this.schedule(s.sessionId);
	}

	remove(id: string, replacedBy?: string): void {
		this.sessions.delete(id);
		this.broadcast({ t: "session.remove", sessionId: id, ...(replacedBy ? { replacedBy } : {}) });
	}
}`;

const RG_FRAMES = `src/remote/ws.ts:88:      this.send(conn, { t: "welcome", host, deviceId });
src/remote/ws.ts:131:      this.send(conn, { t: "sessions", re: f.id, sessions: this.registry.list(conn) });
src/remote/ws.ts:162:      this.send(conn, { t: "session.snapshot", re: f.id, sessionId, items, hasMore, state });
src/remote/registry.ts:41:    this.broadcast({ t: "session.upsert", session: s });
src/remote/registry.ts:52:    this.broadcast({ t: "session.remove", sessionId: id });
src/remote/bridge.ts:77:    this.toSubscribers(id, { t: "session.event", sessionId: id, event });`;

const THROTTLE_FAIL = ` RUN  v3.2.4

 ❯ test/throttle.test.ts (3 tests | 1 failed) 1204ms
   ✓ coalesces upserts inside one window
   ✓ always delivers the trailing edge
   × caps a streaming tool at 2 upserts/s
     → expected 5 to be less than or equal to 2

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)`;

const SUITE_LINES = [
	" RUN  v3.2.4",
	"",
	" ✓ test/pairing.test.ts (14 tests) 61ms",
	" ✓ test/pairing-code.test.ts (9 tests) 22ms",
	" ✓ test/registry.test.ts (21 tests) 48ms",
	" ✓ test/frames.test.ts (31 tests) 63ms",
	" ✓ test/throttle.test.ts (6 tests) 1204ms",
	" ✓ test/push.test.ts (11 tests) 37ms",
	"",
	" Test Files  6 passed (6)",
	"      Tests  92 passed (92)",
];

const LONG_CYCLE = [
	{
		say: "Reading the old pairing handler before moving it onto the registry.",
		tool: { name: "read", args: { path: "src/remote/pairing.ts" }, summary: "read  src/remote/pairing.ts", output: "export async function pair(code: string, device: DeviceInfo): Promise<PairResult> {\n\tconst entry = codes.take(normalize(code));\n\tif (!entry) throw new PairError(\"invalid_code\");\n\treturn devices.add(device);\n}", ms: 1800 },
	},
	{
		say: "The code store and the device list now live on the registry; moving `pair()` over.",
		tool: { name: "edit", args: { path: "src/remote/pairing.ts" }, summary: "edit  src/remote/pairing.ts", output: "Successfully replaced 2 blocks in src/remote/pairing.ts.", ms: 1200 },
	},
	{
		tool: { name: "bash", args: { command: "npx tsc --noEmit" }, summary: "bash  npx tsc --noEmit", output: "", ms: 4200 },
	},
	{
		say: "Types are clean. Running the whole suite.",
		tool: { name: "bash", args: { command: "npx vitest run" }, summary: "bash  npx vitest run", output: SUITE_LINES.join("\n"), ms: 6400 },
	},
	{
		say: "Green. Next: the rate limiter still keys on the old device map, so I'll check its callers.",
		tool: { name: "bash", args: { command: "rg -n 'devices\\.' src/remote" }, summary: "bash  rg -n 'devices\\.' src/remote", output: "src/remote/ratelimit.ts:19:  const known = devices.has(ip);\nsrc/remote/pairing.ts:44:  return registry.devices.add(device);", ms: 1500 },
	},
	{
		tool: { name: "edit", args: { path: "src/remote/ratelimit.ts" }, summary: "edit  src/remote/ratelimit.ts", output: "Successfully replaced 1 block in src/remote/ratelimit.ts.", ms: 900 },
	},
];

function quickScript() {
	return [
		{ say: "I'll start with the registry, then the WebSocket router." },
		{ tool: { name: "read", args: { path: "src/remote/registry.ts" }, summary: "read  src/remote/registry.ts", output: REGISTRY_TS, ms: 1600 } },
		{ tool: { name: "bash", args: { command: "rg -n 't: \"session\\.|t: \"welcome' src/remote" }, summary: "bash  rg -n 't: \"session\\.' src/remote", output: RG_FRAMES, ms: 2200 } },
		{ say: "Checking how the bridge fans events out to subscribers." },
		{ tool: { name: "read", args: { path: "src/remote/bridge.ts", offset: 60, limit: 40 }, summary: "read  src/remote/bridge.ts:60-100", output: "toSubscribers(id: string, frame: HubFrame): void {\n\tfor (const c of this.conns) if (c.subscriptions.has(id)) c.send(frame);\n}", ms: 1400 } },
		{
			say: "The hub sends **six** frame types to clients:\n\n- `welcome`, `sessions` (on request)\n- `session.upsert`, `session.remove` (broadcast, throttled ≤ 2/s)\n- `session.snapshot` (subscribe reply)\n- `session.event` (subscribers only)\n\nSessions register in `SessionRegistry.upsert`, which schedules a throttled broadcast.",
		},
	];
}

const PUSH_PASS = ` RUN  v3.2.4

 ✓ test/push.test.ts (12 tests) 41ms
   ✓ drops the registration on 410 Unregistered

 Test Files  1 passed (1)
      Tests  12 passed (12)`;

function passScript() {
	return [
		{ say: "Adding a test where APNs answers 410 for one device." },
		{ tool: { name: "edit", args: { path: "test/push.test.ts" }, summary: "edit  test/push.test.ts", output: "Successfully replaced 1 block in test/push.test.ts.", ms: 1300 } },
		{ tool: { name: "bash", args: { command: "npx vitest run test/push.test.ts" }, summary: "bash  npx vitest run test/push.test.ts", output: PUSH_PASS, ms: 3200 } },
		{ say: "The 410 path already drops the registration; the new test pins it down." },
	];
}

function failScript() {
	return [
		{ say: "Adding a test that streams 40 tool updates and counts the upserts." },
		{ tool: { name: "edit", args: { path: "test/throttle.test.ts" }, summary: "edit  test/throttle.test.ts", output: "Successfully replaced 1 block in test/throttle.test.ts.", ms: 1100 } },
		{ tool: { name: "bash", args: { command: "npx vitest run test/throttle.test.ts" }, summary: "bash  npx vitest run test/throttle.test.ts", output: THROTTLE_FAIL, ms: 3600, status: "error" } },
		{ say: "The cap is not enforced while a tool streams: `flush()` stamps `lastEmit` after broadcasting." },
		{ fail: "Subagent exited with code 1: 1 test still failing (test/throttle.test.ts)" },
	];
}

const ROUNDS = [
	{
		user: "Split the remote hub work across subagents: map the frames, add throttle tests, and port pairing onto the registry. Run them in the background.",
		thinking: "Three independent pieces. A quick scout for the frame map, a cheap model for the throttle tests, and a longer worker for the pairing port. Background so I can keep answering.",
		text: "I'll split this into three parallel subagents and run them in the background.",
		tasks: [
			{ agent: "scout", model: "anthropic/claude-sonnet-5", task: "Map how the hub registers sessions and list every frame it sends to clients.", script: quickScript, seed: 101 },
			{ name: "ws-b", model: "claude-haiku-4-5", idOnly: true, task: "Add throttle tests for session.upsert (at most 2 per second per session) and make them pass.", script: failScript, seed: 102 },
			{ name: "ws-c", model: "example/fast", task: "Port the pairing flow to the new session registry, then run the full suite until it is green.", script: "long", seed: 103 },
		],
		// A second launch later in the same turn.
		more: [
			{ name: "lint-fix", model: "example/fast", task: "Fix the lint errors the registry move left in src/remote.", script: "long", span: 0.5, seed: 104, doneText: "Done. `npm run lint` is clean in src/remote." },
			{ name: "docs", model: "anthropic/claude-haiku-4-5", task: "Update docs/remote.md for the registry-based pairing flow.", script: "long", span: 0.3, seed: 105, doneText: "Done. docs/remote.md describes pairing through the registry." },
		],
	},
	{
		user: "Same split for the push path: map it, test the 410 handling, and port it onto the registry.",
		text: "Launching three more subagents for the push path.",
		tasks: [
			{ agent: "scout", model: "anthropic/claude-sonnet-5", task: "Map the push path from session idle to the APNs request.", script: quickScript, seed: 201 },
			{ agent: "scout", model: "anthropic/claude-haiku-4-5", task: "Add a test that a 410 from APNs drops the device's push registration.", script: passScript, seed: 202 },
			{ name: "push-port", model: "example/fast", task: "Move push registrations onto the registry and keep the suite green.", script: "long", seed: 203 },
		],
	},
];

// ------------------------------------------------------------------ sessions

/** One subagent run, as a session of its own. */
export class SubagentSession extends FakeSession {
	constructor(reg, parent, o) {
		const [provider, id] = o.model.includes("/") ? o.model.split("/") : ["", o.model];
		super(reg, {
			id: `${parent.id}~sa~${o.runId}`,
			name: o.displayName,
			cwd: parent.cwd,
			pid: parent.pid, // the parent's until the child has started
			kind: "subagent",
			// provider "" when only a model id is known (no name then either)
			model: provider ? model(provider, id) : { provider: "", id },
			thinkingLevel: "medium",
			seed: o.seed,
			usage: { costUsd: 0, contextPercent: 0 },
		});
		this.parent = parent;
		this.runInfo = {
			runId: o.runId,
			toolCallId: o.toolCallId,
			index: o.index,
			...(o.name ? { name: o.name } : {}), // only an explicit task name
			...(o.agent ? { agent: o.agent } : {}),
			task: oneLine(o.task, 200),
			status: "running",
			startedAt: Date.now(),
			turns: 0,
			toolCalls: 0,
			background: true,
		};
		this.script = o.script;
		this.longMs = Math.round(o.longMs * (o.span ?? 1));
		this.doneText = o.doneText;
		this.ctl = null;
		this.live = null; // { assistant, tool } items currently streaming / running
		this.steers = [];
		this.round = o.round;
		this.acceptsAt = Date.now() + 1500; // "not accepting messages yet" while the child starts
		this.childPid = 40000 + Math.floor(Math.random() * 20000);
	}

	summary() {
		const s = super.summary();
		delete s.commandsVersion;
		delete s.subagents;
		s.parentSessionId = this.parent.id;
		s.subagent = { ...this.runInfo };
		return s;
	}

	start() {
		this.ctl = new AbortController();
		this.upsertItem({ id: "u:task", ts: this.runInfo.startedAt, kind: "user", text: this.fullTask });
		this.setStatus("working");
		setTimeout(() => {
			if (this.closed) return;
			this.pid = this.childPid; // the child process is up
			this.markDirty();
		}, 1500);
		const signal = this.ctl.signal;
		this.#run(signal).then(
			(outcome) => {
				if (signal.aborted) return;
				this.#finish(outcome);
			},
			(err) => {
				if (err instanceof Aborted || signal.aborted) return;
				this.reg.log(`[subagent ${this.name}] crashed: ${err?.stack ?? err}`);
				this.#finish("failed", String(err?.message ?? err));
			},
		);
	}

	async #run(signal) {
		const steps = this.script === "long" ? null : this.script();
		if (steps) {
			for (const step of steps) {
				if (step.fail) {
					await this.#say("", signal, step.fail);
					return "failed";
				}
				await this.#step(step, signal);
			}
			return "done";
		}
		const until = this.runInfo.startedAt + this.longMs;
		let i = 0;
		while (Date.now() < until) {
			await this.#step(LONG_CYCLE[i % LONG_CYCLE.length], signal);
			i++;
			if (i === LONG_CYCLE.length * 2) {
				// The parent agent's message action (`subagent  message ws-c  …`).
				this.upsertItem({ id: this.newItemId(), ts: Date.now(), kind: "user", text: "[message from your parent agent] Also update docs/remote.md once the suite is green." });
			}
			await sleep(this.r.int(600, 1400), signal);
		}
		await this.#say(this.doneText ?? `Done. The pairing flow runs on the registry and the suite is green (${SUITE_LINES[SUITE_LINES.length - 1].trim()}).`, signal);
		return "done";
	}

	async #step(step, signal) {
		const steer = this.steers.shift();
		if (steer) await this.#say(`Got it — ${oneLine(steer, 120)}. Adjusting the plan.`, signal);
		if (step.say) await this.#say(step.say, signal);
		if (step.tool) await this.#tool(step.tool, signal);
	}

	async #say(text, signal, error) {
		const a = { id: this.newItemId(), ts: Date.now(), kind: "assistant", text: "", streaming: true, model: this.model.id };
		this.live = { assistant: a, tool: null };
		this.runInfo.turns += 1;
		this.setActivity(undefined);
		for (let n = 0; n < text.length; ) {
			n = Math.min(text.length, n + this.r.int(18, 46));
			a.text = text.slice(0, n);
			this.upsertItem(a);
			await sleep(STREAM_MS, signal);
		}
		delete a.streaming;
		a.text = text;
		if (error) a.error = error;
		this.upsertItem(a);
		if (text) this.lastText = oneLine(text);
		this.markDirty();
		this.live = null;
	}

	async #tool(t, signal) {
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
		this.live = { assistant: null, tool };
		this.runInfo.toolCalls += 1;
		this.upsertItem(tool);
		this.setActivity({ tool: t.name, summary: t.summary.replace(/^\S+\s+/, "") });
		const lines = (t.output ?? "").split("\n");
		if (t.name === "bash" && lines.length > 6) {
			for (let i = 1; i < 4; i++) {
				await sleep(Math.floor(t.ms / 4), signal);
				tool.output = lines.slice(0, Math.floor((lines.length * i) / 4)).join("\n");
				this.upsertItem(tool);
			}
			await sleep(Math.floor(t.ms / 4), signal);
		} else {
			await sleep(t.ms, signal);
		}
		tool.status = t.status === "error" ? "error" : "ok";
		tool.output = t.output ?? "";
		this.upsertItem(tool);
		this.usage.costUsd = Math.round((this.usage.costUsd + 0.002 + this.r.next() * 0.01) * 10000) / 10000;
		this.usage.contextPercent = Math.min(90, Math.round((this.usage.contextPercent + 0.6 + this.r.next()) * 10) / 10);
		this.live = null;
		this.markDirty();
	}

	#finish(status, error) {
		if (this.runInfo.status !== "running") return;
		this.runInfo.status = status;
		this.runInfo.endedAt = Date.now();
		if (error) this.lastText = oneLine(error);
		this.setStatus("idle", { aborted: status === "killed" });
		this.parent.markDirty();
		this.reg.subagents?.childFinished(this);
	}

	/** auto/steer steer the run, followUp queues after its turn. Finished or starting → refused. */
	prompt(text, images, mode = "auto") {
		if (images?.length) return { error: { code: "bad_request", message: "subagents take text only" } };
		if (this.runInfo.status !== "running") return { error: { code: "bad_request", message: "subagent finished" } };
		if (Date.now() < this.acceptsAt) return { error: { code: "bad_request", message: "not accepting messages yet; try again" } };
		this.upsertItem({ id: this.newItemId(), ts: Date.now(), kind: "user", text });
		this.steers.push(text);
		return undefined;
	}

	/** Stop the run: status "killed". */
	abort() {
		if (this.runInfo.status !== "running") return false;
		this.ctl?.abort();
		const live = this.live;
		this.live = null;
		if (live?.tool?.status === "running") {
			live.tool.status = "error";
			live.tool.output = `${live.tool.output ? `${live.tool.output}\n` : ""}Operation aborted`;
			this.upsertItem(live.tool);
		}
		if (live?.assistant?.streaming) {
			delete live.assistant.streaming;
			live.assistant.error = "aborted";
			this.upsertItem(live.assistant);
		}
		this.#finish("killed");
		return true;
	}

	close() {
		this.ctl?.abort();
		super.close();
	}
}

// ------------------------------------------------------------------ manager

class SubagentManager {
	constructor(reg, { longMs, restMs, startMs }) {
		this.reg = reg;
		this.longMs = longMs;
		this.restMs = restMs;
		this.startMs = startMs;
		this.roundIdx = 0;
		this.timer = null;
	}

	children(parentId) {
		const out = [];
		for (const s of this.reg.sessions.values()) if (s.kind === "subagent" && s.parent?.id === parentId) out.push(s);
		return out;
	}

	counts(parentId) {
		const kids = this.children(parentId);
		if (!kids.length) return undefined;
		return { running: kids.filter((k) => k.runInfo.status === "running").length, total: kids.length };
	}

	/** The parent ended or was replaced: its subagents go too. */
	parentGone(parentId) {
		for (const k of this.children(parentId)) this.reg.remove(k.id);
		if (parentId === SUBAGENT_PARENT_ID) clearTimeout(this.timer);
	}

	childFinished(child) {
		const round = this.children(child.parent.id).filter((k) => k.round === child.round);
		if (round.some((k) => k.runInfo.status === "running")) return;
		const parent = child.parent;
		const parts = round
			.sort((a, b) => a.runInfo.index - b.runInfo.index)
			.map((k) => {
				const took = fmtDuration(k.runInfo.endedAt - k.runInfo.startedAt);
				const st = k.runInfo.status;
				return `${k.name} ${st === "done" ? `done in ${took}` : st === "failed" ? `failed after ${took}` : `stopped after ${took}`}`;
			});
		parent.upsertItem({ id: parent.newItemId(), ts: Date.now(), kind: "note", label: "subagent", text: `Background subagents finished: ${parts.join(" · ")}` });
		const failed = round.filter((k) => k.runInfo.status === "failed").map((k) => k.name);
		parent.runTurn({
			text: "All of this round's subagents are back.",
			tools: [],
			final: failed.length
				? `Results are in. **${failed.join(", ")}** failed — the throttle cap is still not enforced while a tool streams; I'll fix \`flush()\` to stamp \`lastEmit\` first. The others finished cleanly.`
				: "Results are in and every subagent finished cleanly.",
		});
		this.schedule(this.restMs);
	}

	schedule(ms) {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.launch(), ms);
	}

	launch() {
		this.timer = null;
		const parent = this.reg.sessions.get(SUBAGENT_PARENT_ID);
		if (!parent || parent.closed) return;
		if (parent.status !== "idle" || parent.run) return this.schedule(10_000);
		const n = this.roundIdx++;
		const round = ROUNDS[n % ROUNDS.length];
		// Keep the last round's subagents around (as phi does), drop older ones.
		for (const k of this.children(parent.id)) if (k.round < n - 1) this.reg.remove(k.id);
		const names = numbered(round.tasks.map(displayName));
		const more = round.more ? numbered(round.more.map(displayName)) : [];
		const started = parent.runTurn({
			user: round.user,
			thinking: round.thinking,
			text: round.text,
			tools: [
				{
					name: "subagent",
					summary: `${names.length} subagents: ${names.join(", ")}`,
					args: {
						tasks: round.tasks.map(({ name, agent, model, task }) => ({ ...(name ? { name } : {}), ...(agent ? { agent } : {}), model, task })),
						background: true,
					},
					output: `Launched ${names.length} subagents in the background (parallel mode): ${names.join(", ")}.`,
					ms: 900,
					onStart: (tool) => this.#spawn(parent, tool, round.tasks, n),
				},
				// Not a launch: stays a small tool row in the app.
				{ name: "subagent", summary: "subagent  status", args: { action: "status" }, output: `${names.length} running: ${names.join(", ")}`, ms: 500 },
				...(round.more
					? [
							{
								name: "subagent",
								summary: `${more.length} subagents: ${more.join(", ")}`,
								args: {
									tasks: round.more.map(({ name, agent, model, task }) => ({ ...(name ? { name } : {}), ...(agent ? { agent } : {}), model, task })),
									background: true,
								},
								output: `Launched ${more.length} subagents in the background (parallel mode): ${more.join(", ")}.`,
								ms: 700,
								onStart: (tool) => this.#spawn(parent, tool, round.more, n),
							},
						]
					: []),
			],
			final: `Launched ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} in the background${more.length ? `, then ${more.join(" and ")} for the cleanup` : ""}. I'll report back when they finish.`,
		});
		if (!started) this.schedule(10_000);
	}

	#spawn(parent, tool, tasks, n) {
		const names = numbered(tasks.map(displayName));
		tasks.forEach((t, index) => {
			const child = new SubagentSession(this.reg, parent, {
				runId: randomUUID(),
				toolCallId: tool.toolCallId,
				index,
				name: t.name,
				displayName: names[index],
				agent: t.agent,
				task: t.task,
				model: t.model,
				script: t.script,
				seed: t.seed + n * 1000,
				longMs: this.longMs,
				span: t.span,
				doneText: t.doneText,
				round: n,
			});
			child.fullTask = t.task;
			this.reg.add(child);
			child.start();
		});
		parent.markDirty();
		this.reg.log(`[subagents] ${parent.id.slice(0, 8)} launched ${names.join(", ")}`);
	}
}

/** Seeds the subagent parent session and starts its first round. */
export function attachSubagents(reg, { longMs = 15 * 60_000, restMs = 90_000, startMs = 3_000 } = {}) {
	const mgr = new SubagentManager(reg, { longMs, restMs, startMs });
	reg.subagents = mgr;
	const now = Date.now();
	const parent = new FakeSession(reg, {
		id: SUBAGENT_PARENT_ID,
		name: "Subagents in phi remote",
		cwd: path.join(HOME, "ExampleCo/phi-remote"),
		model: model("anthropic", "claude-opus-5-5"),
		thinkingLevel: "xhigh",
		startedAt: now - 25 * 60_000,
		seed: 71,
		usage: { costUsd: 1.284, contextPercent: 23 },
	});
	const h = generateHistory({ seed: 71, count: 16, endTs: now - 60_000, modelName: "claude-opus-5-5", cwd: parent.cwd, withError: false });
	for (const it of h.items) parent.upsertItem(it);
	parent.lastText = oneLine(h.lastText);
	reg.add(parent);
	mgr.schedule(startMs);
	return mgr;
}
