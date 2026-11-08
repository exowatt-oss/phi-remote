// Fake but realistic phi transcript content for the mock hub.
// Everything here is deterministic given a seed so restarts look the same.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";

export const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-remote-mock-'));
fs.mkdirSync(path.join(HOME, 'ExampleCo'));

/** mulberry32 seeded PRNG */
export function rng(seed) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
		pick: (arr) => arr[Math.floor(next() * arr.length)],
		hex: (n) => {
			let s = "";
			for (let i = 0; i < n; i++) s += Math.floor(next() * 16).toString(16);
			return s;
		},
		alnum: (n) => {
			const cs = "ABCDEFGHJKMNPQRSTVWXYZabcdefghijkmnopqrstuvwxyz0123456789";
			let s = "";
			for (let i = 0; i < n; i++) s += cs[Math.floor(next() * cs.length)];
			return s;
		},
	};
}

export const MODELS = [
	{ provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true },
	{ provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true },
	{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: true },
	{ provider: "openai", id: "gpt-5.6", name: "GPT-5.6", reasoning: true },
	{ provider: "example", id: "fast", name: "Fast (GPT-5.6)", reasoning: true },
	{ provider: "example", id: "large", name: "Large", reasoning: true },
	{ provider: "google", id: "gemini-3-pro", name: "Gemini 3 Pro", reasoning: true },
	// a long name, so pills and rows show their truncation
	{ provider: "openrouter", id: "deepseek-v4.1-flash-reasoner-preview", name: "DeepSeek V4.1 Flash Reasoner Preview (OpenRouter, 1M context)", reasoning: true },
	{ provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 mini", reasoning: false },
];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function findModel(provider, id) {
	return MODELS.find((m) => m.provider === provider && m.id === id);
}

// ---------------------------------------------------------------------------
// Turn templates. A turn = user prompt, optional thinking, assistant text with
// tool calls, tool results, final assistant text.
// ---------------------------------------------------------------------------

const BASH_LS = `total 64
drwxr-xr-x  14 alex  staff   448 Oct 29 13:02 .
drwxr-xr-x  41 alex  staff  1312 Oct 29 09:15 ..
-rw-r--r--   1 alex  staff   612 Oct 28 17:40 .editorconfig
drwxr-xr-x  12 alex  staff   384 Oct 29 13:02 .git
-rw-r--r--   1 alex  staff  1880 Oct 29 11:21 package.json
-rw-r--r--   1 alex  staff 98213 Oct 29 11:21 package-lock.json
-rw-r--r--   1 alex  staff  2371 Oct 27 10:03 README.md
drwxr-xr-x   9 alex  staff   288 Oct 29 12:44 src
drwxr-xr-x   6 alex  staff   192 Oct 29 12:44 test
-rw-r--r--   1 alex  staff   511 Oct 26 16:12 tsconfig.json`;

const VITEST_OK = ` RUN  v3.2.4 ${"${CWD}"}

 ✓ test/session-registry.test.ts (14 tests) 41ms
 ✓ test/pairing.test.ts (9 tests) 22ms
 ✓ test/frames.test.ts (31 tests) 63ms
 ✓ test/throttle.test.ts (6 tests) 1204ms

 Test Files  4 passed (4)
      Tests  60 passed (60)
   Start at  13:04:51
   Duration  1.91s (transform 212ms, setup 0ms, collect 498ms, tests 1.33s)`;

const VITEST_FAIL = ` RUN  v3.2.4 ${"${CWD}"}

 ❯ test/auth/login.test.ts (7 tests | 1 failed) 3021ms
   × login > redirects to /sites after OAuth callback 3004ms
     → Timed out in 3000ms.
 ✓ test/auth/session.test.ts (12 tests) 88ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/auth/login.test.ts > login > redirects to /sites after OAuth callback
Error: Timed out in 3000ms.
 ❯ test/auth/login.test.ts:48:5
     46|   it("redirects to /sites after OAuth callback", async () => {
     47|     render(<App />);
     48|     await screen.findByText("Sites");
       |     ^
     49|   });

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 18 passed (19)

Command exited with code 1`;

const READ_TS = `import { WebSocketServer, type WebSocket } from "ws";
import { createHash, randomBytes } from "node:crypto";
import type { SessionSummary, TranscriptItem } from "./types.js";

export interface Conn {
	ws: WebSocket;
	deviceId: string;
	focus: string | null;
	subscriptions: Set<string>;
}

const THROTTLE_MS = 500;

export class SessionRegistry {
	private sessions = new Map<string, SessionSummary>();
	private lastEmit = new Map<string, number>();
	private pending = new Map<string, NodeJS.Timeout>();

	constructor(private readonly broadcast: (frame: unknown) => void) {}

	upsert(summary: SessionSummary): void {
		this.sessions.set(summary.sessionId, summary);
		this.schedule(summary.sessionId);
	}

	private schedule(id: string): void {
		const last = this.lastEmit.get(id) ?? 0;
		const wait = Math.max(0, last + THROTTLE_MS - Date.now());
		if (this.pending.has(id)) return;
		this.pending.set(id, setTimeout(() => this.flush(id), wait));
	}
}`;

const GIT_STATUS = `On branch feat/remote-hub
Your branch is up to date with 'origin/feat/remote-hub'.

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
	modified:   src/remote/hub.ts
	modified:   src/remote/registry.ts
	modified:   test/frames.test.ts

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	src/remote/push.ts

no changes added to commit (use "git add" and/or "git commit -a")`;

const RG_OUT = `src/remote/hub.ts:41:  const wss = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });
src/remote/hub.ts:88:      ws.close(4401, "hello timeout");
src/remote/hub.ts:97:      ws.close(4426, "protocol mismatch");
src/remote/registry.ts:12:const THROTTLE_MS = 500;
src/remote/push.ts:5:const APNS_HOST = { sandbox: "api.sandbox.push.apple.com", production: "api.push.apple.com" };`;

const TSC_ERR = `src/remote/push.ts:27:18 - error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
  Type 'undefined' is not assignable to type 'string'.

27   const jwt = sign(cfg.keyPath, cfg.keyId);
                    ~~~~~~~~~~~

Found 1 error in src/remote/push.ts:27`;

export const TURNS = [
	{
		user: "Why is the session.upsert throttle letting through more than 2/s when a tool streams output?",
		thinking:
			"The registry schedules a flush per session, but `schedule` checks `pending` after computing the wait. If a flush runs and then two upserts arrive inside the same tick, the second one sees no pending timer and computes wait = 0 because lastEmit was not updated yet. I should read registry.ts and check where lastEmit is set.",
		text:
			"Let me look at how the registry schedules flushes — I suspect `lastEmit` is only updated after the frame is serialized.",
		tools: [
			{ name: "read", args: { path: "src/remote/registry.ts" }, summary: "read  src/remote/registry.ts", output: READ_TS, ms: 700 },
			{ name: "bash", args: { command: "rg -n 'THROTTLE_MS|close\\(44' src" }, summary: "bash  rg -n 'THROTTLE_MS|close\\(44' src", output: RG_OUT, ms: 900 },
		],
		final: `Found it. \`schedule()\` computes the wait from \`lastEmit\`, but \`flush()\` sets \`lastEmit\` *after* the broadcast, so an upsert that arrives during the broadcast sees the old timestamp and gets \`wait = 0\`.

Fix: stamp \`lastEmit\` before broadcasting:

\`\`\`ts
private flush(id: string): void {
	this.pending.delete(id);
	this.lastEmit.set(id, Date.now()); // stamp first
	const s = this.sessions.get(id);
	if (s) this.broadcast({ t: "session.upsert", session: s });
}
\`\`\`

With that, a burst of 40 tool-output updates now produces **2 upserts/s**, matching the contract.`,
	},
	{
		user: "Run the tests and fix anything that fails.",
		text: "Running the suite first.",
		tools: [
			{ name: "bash", args: { command: "npx vitest run" }, summary: "bash  npx vitest run", output: VITEST_FAIL, ms: 3200, status: "error" },
			{ name: "read", args: { path: "test/auth/login.test.ts", offset: 30, limit: 30 }, summary: "read  test/auth/login.test.ts:30-60", output: `  beforeEach(() => {
    vi.useFakeTimers();
    server.use(oauthCallbackHandler);
  });

  it("redirects to /sites after OAuth callback", async () => {
    render(<App />);
    await screen.findByText("Sites");
  });`, ms: 500 },
			{ name: "edit", args: { path: "test/auth/login.test.ts", edits: [{ oldText: "    vi.useFakeTimers();\n", newText: "    vi.useFakeTimers({ shouldAdvanceTime: true });\n" }] }, summary: "edit  test/auth/login.test.ts", output: "Successfully replaced 1 block in test/auth/login.test.ts.", ms: 300 },
			{ name: "bash", args: { command: "npx vitest run test/auth" }, summary: "bash  npx vitest run test/auth", output: ` ✓ test/auth/login.test.ts (7 tests) 412ms
 ✓ test/auth/session.test.ts (12 tests) 91ms

 Test Files  2 passed (2)
      Tests  19 passed (19)`, ms: 2100 },
		],
		final: `The login test hung because \`vi.useFakeTimers()\` froze the timer that \`findByText\` polls with. Using \`shouldAdvanceTime: true\` keeps fake timers but lets real time advance:

\`\`\`diff
-    vi.useFakeTimers();
+    vi.useFakeTimers({ shouldAdvanceTime: true });
\`\`\`

All 19 auth tests pass now.`,
	},
	{
		user: "What's uncommitted right now?",
		text: "Checking the working tree.",
		tools: [{ name: "bash", args: { command: "git status" }, summary: "bash  git status", output: GIT_STATUS, ms: 400 }],
		final: `Three modified files and one new one:

| File | Change | Why |
|---|---|---|
| \`src/remote/hub.ts\` | hello timeout + 4426 close | a client that never says hello held its socket open forever |
| \`src/remote/registry.ts\` | throttle fix | sessions.list fanned out on every keystroke from the composer |
| \`test/frames.test.ts\` | new frame-shape tests | covers every frame type in PROTOCOL.md |
| \`src/remote/push.ts\` | **untracked** — APNs sender | pushes finished turns while the app is in the background |

Last test run:

| Suite | Tests | Passed | Failed | Skipped | Time |
|---|---|---|---|---|---|
| frames | 14 | 14 | 0 | 0 | 0.4 s |
| hub | 22 | 21 | 1 | 0 | 2.9 s |
| registry | 9 | 9 | 0 | 0 | 0.2 s |

Nothing is staged.`,
	},
	{
		user: "Typecheck the push module",
		thinking: "Run tsc --noEmit scoped to the project; push.ts reads apns.json which has optional fields, so keyPath may be typed string | undefined.",
		text: "Running the typechecker.",
		tools: [
			{ name: "bash", args: { command: "npx tsc --noEmit -p ." }, summary: "bash  npx tsc --noEmit -p .", output: TSC_ERR, ms: 4100, status: "error" },
			{ name: "edit", args: { path: "src/remote/push.ts", edits: [{ oldText: "const jwt = sign(cfg.keyPath, cfg.keyId);", newText: "if (!cfg.keyPath) return; // push not configured\n\tconst jwt = sign(cfg.keyPath, cfg.keyId);" }] }, summary: "edit  src/remote/push.ts", output: "Successfully replaced 1 block in src/remote/push.ts.", ms: 250 },
			{ name: "bash", args: { command: "npx tsc --noEmit -p ." }, summary: "bash  npx tsc --noEmit -p .", output: "", ms: 3900 },
		],
		final: "`keyPath` is optional in `apns.json`, so I added an early return when push isn't configured. `tsc --noEmit` is clean now.",
	},
	{
		user: "List the repo root",
		text: "",
		tools: [{ name: "bash", args: { command: "ls -la" }, summary: "bash  ls -la", output: BASH_LS, ms: 200 }],
		final: "Standard TypeScript layout: `src/`, `test/`, `package.json`, `tsconfig.json`. No build output checked in.",
	},
	{
		user: "Add a test that checks the hub closes with 4401 when hello doesn't arrive in 5 seconds",
		text: "I'll add it next to the existing frame tests.",
		tools: [
			{ name: "edit", args: { path: "test/frames.test.ts", edits: [{ oldText: "describe(\"hello\", () => {\n", newText: "describe(\"hello\", () => {\n\tit(\"closes 4401 without hello\", async () => {\n\t\tvi.useFakeTimers();\n\t\tconst ws = await connect();\n\t\tvi.advanceTimersByTime(5_001);\n\t\texpect(await closed(ws)).toBe(4401);\n\t});\n" }] }, summary: "edit  test/frames.test.ts", output: "Successfully replaced 1 block in test/frames.test.ts.", ms: 300 },
			{ name: "bash", args: { command: "npx vitest run test/frames.test.ts" }, summary: "bash  npx vitest run test/frames.test.ts", output: VITEST_OK, ms: 2600 },
		],
		final: `Added \`closes 4401 without hello\`:

\`\`\`ts
it("closes 4401 without hello", async () => {
	vi.useFakeTimers();
	const ws = await connect();
	vi.advanceTimersByTime(5_001);
	expect(await closed(ws)).toBe(4401);
});
\`\`\`

Suite is green (60 tests).`,
	},
];

const EXTRA_USERS = [
	"ok, keep going",
	"looks good — can you also handle the revoked-device case?",
	"use the same pattern as in hub.ts",
	"shorter please",
	"why did that fail?",
	"commit message?",
];

const NOTES = [
	{ label: "compaction", text: `## Goal
Ship the phi remote hub: pairing, WS frames, session registry, APNs push.

## Progress
- Pairing endpoint with Crockford codes, 10-min TTL, 5/min/IP rate limit — done, tested.
- WS hello/welcome, 4401 on bad token and timeout — done.
- session.upsert throttle (≤2/s) — fixed lastEmit ordering bug.

## Next
- APNs JWT signing, 410 handling.
- focus-based push suppression.

## Key files
src/remote/hub.ts, src/remote/registry.ts, src/remote/push.ts, test/frames.test.ts` },
	{ label: "branch summary", text: "Explored an alternative where sessions push events over HTTP instead of the unix socket; abandoned because it required sessions to know the hub port." },
	{ label: "!bash", text: "$ git log --oneline -3\n4f1c2aa remote: stamp lastEmit before broadcast\n91be0d3 remote: 4426 on protocol mismatch\n2c7d110 remote: pairing codes + rate limit" },
	{ label: "subagent", text: "fast (worker 2/3) finished: added 14 frame-shape tests in test/frames.test.ts; all pass. No changes outside test/." },
];

/**
 * Build a long history of transcript items.
 * @returns {{ items: object[], lastText: string, firstPrompt: string }}
 */
export function generateHistory({ seed, count, endTs, modelName, cwd, withImages = false, withError = true }) {
	const r = rng(seed);
	const items = [];
	const ids = new Set();
	const newId = () => {
		let id;
		do id = r.hex(8);
		while (ids.has(id));
		ids.add(id);
		return id;
	};
	let ts = endTs - count * 45_000;
	const step = () => (ts += r.int(2_000, 60_000));
	let turnIdx = r.int(0, TURNS.length - 1);
	let lastText = "";
	let firstPrompt = "";
	let usedImages = false;
	let usedNoteAt = Math.floor(count / 3);
	let noteIdx = 0;
	while (items.length < count) {
		const turn = TURNS[turnIdx++ % TURNS.length];
		let userText = items.length === 0 || r.next() < 0.7 ? turn.user : `${r.pick(EXTRA_USERS)}`;
		const user = { id: newId(), ts: step(), kind: "user", text: userText };
		if (withImages && !usedImages && items.length > count / 2) {
			user.text = "Here's what the app shows on my phone — the session list is empty even though two sessions are running";
			user.images = 2;
			usedImages = true;
		}
		if (!firstPrompt) firstPrompt = user.text;
		items.push(user);
		const a = { id: newId(), ts: step(), kind: "assistant", text: turn.text, model: modelName };
		if (turn.thinking && r.next() < 0.8) a.thinking = turn.thinking;
		items.push(a);
		for (const t of turn.tools) {
			const status = t.status === "error" && withError ? "error" : "ok";
			const tool = {
				id: newId(),
				ts: step(),
				kind: "tool",
				toolCallId: `toolu_01${r.alnum(22)}`,
				name: t.name,
				summary: t.summary,
				args: t.args,
				status,
				output: t.output.replaceAll("${CWD}", cwd),
			};
			items.push(tool);
		}
		const fin = { id: newId(), ts: step(), kind: "assistant", text: turn.final, model: modelName };
		items.push(fin);
		lastText = turn.final;
		if (items.length >= usedNoteAt && noteIdx < NOTES.length) {
			const n = NOTES[noteIdx++];
			items.push({ id: newId(), ts: step(), kind: "note", label: n.label, text: n.text });
			usedNoteAt += Math.floor(count / 5);
		}
	}
	// re-base timestamps so the newest item lands at endTs
	const shift = endTs - items[items.length - 1].ts;
	for (const it of items) it.ts += shift;
	return { items, lastText, firstPrompt };
}

export function oneLine(s, max = 200) {
	const flat = String(s ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Make a streamed echo reply for a user prompt. */
export function echoTurn(prompt, cwd) {
	const short = oneLine(prompt, 120);
	return {
		thinking: `The user asked: "${short}". I'll look at the working directory first, then answer.`,
		text: `You said: **${short}**\n\nLet me take a quick look at \`${path.basename(cwd) || cwd}\` before answering.`,
		tools: [
			{ name: "bash", args: { command: "ls -la" }, summary: "bash  ls -la", output: BASH_LS, ms: 900 },
		],
		final: `Here's my answer to "${short}":\n\n1. The directory looks like a standard TypeScript project.\n2. Nothing needs to change for this request.\n\n\`\`\`sh\n# echo of your prompt\necho ${JSON.stringify(short)}\n\`\`\`\n\nLet me know if you want me to go further.`,
	};
}

export function shortCwd(cwd) {
	return cwd.startsWith(HOME) ? `~${cwd.slice(HOME.length)}` : cwd;
}

// ------------------------------------------------------------------ slash commands
// What `commands.list` returns (docs/PROTOCOL.md "Slash commands (v1 addition)"): the phi remote
// built-ins, then extension commands, skills and prompt templates, each group alphabetical — the
// order the real hub sends. Descriptions are single-line (≤ 160 chars) like the real hub's.

const SKILL_ROOT = path.join(HOME, ".pi", "agent", "skills");

export const SKILLS = [
	{
		name: "checkin",
		description: "Give a concise but useful status check-in on the current session: what has landed, what the agent is doing now, what remains.",
		body: "# Check-in\n\nGive a short status update: what landed, what is in progress, what remains, and any real blocker.",
	},
	{
		name: "jev-mobile",
		description: "Drive the person's own signed-in browser on their iPhone through a browser service.",
		body: "# Jev on your phone\n\nHand Jev the whole goal with `run`, then verify with `observe`, `extract` or `shot`.",
	},
	{
		name: "make-plan",
		description: "Create a repository-grounded, execution-ready implementation plan for a feature, bug fix, refactor or migration.",
		body: "# Make a plan\n\nRead the code first. Produce self-contained tasks with exact code anchors, dependencies and acceptance evidence.",
	},
	{
		name: "overseer",
		description: "Run long-lived parallel work as full phi sessions (threads) that this session starts and manages with the overseer tool.",
		body: "# overseer\n\nPlan workstreams, start one thread per workstream with the `overseer` tool, watch them, answer them, close them.",
	},
	{
		name: "orchestrate",
		description: "Pure-orchestrator mode for executing an existing plan: the main thread implements nothing itself and delegates every piece of work.",
		body: "# Orchestrate\n\nDecompose the plan into waves, delegate each task to subagents, review at every phase boundary.",
	},
	{
		name: "example-skill",
		description: "Swarm-implement decomposable work with parallel cheap, fast subagents at max reasoning.",
		body: "# Example skill\n\nSplit the work into small tasks and run them in parallel with fast workers; present the result for review.",
	},
	{
		name: "use-subs",
		description: "Mixed subagent swarm: route each task to the right worker, mixing cheap and strong models in one wave.",
		body: "# Use subagents\n\nRoute trivial work to fast workers and complex work to strong ones; run waves in parallel.",
	},
	{
		name: "web-design",
		description: "End-to-end web UI design, implementation and programmatic validation for pages, components and dashboards.",
		body: "# Web design\n\nDiscovery first, then layout, typography, colour and motion; validate in a real browser.",
	},
].map((s) => ({ ...s, location: path.join(SKILL_ROOT, s.name, "SKILL.md") }));

export const PROMPTS = [
	{
		name: "jev",
		description: "Drive my signed-in browser with Jev; first action is the browser call, no reconnaissance",
		argumentHint: "<goal>",
		body: "The browser is already bridged as MCP server `browser`. The FIRST action is the call that does the job.\nGoal: $@",
	},
	{
		name: "make-report",
		description: "Create a polished, self-contained ExampleCo HTML report from a topic, data, or files",
		argumentHint: "[topic, data, files, or delivery request]",
		body: "Discover and force-load the `make-report` skill, then follow it completely. Create the finished report artifact for: $@",
	},
];

export const BUILTIN_COMMANDS = [
	{ name: "compact", description: "Compact the session context", source: "builtin", argumentHint: "[instructions]" },
	{ name: "model", description: "Switch this session's model", source: "builtin", argumentHint: "<provider/model>" },
	{ name: "name", description: "Set the session display name", source: "builtin", argumentHint: "<name>" },
	{ name: "new", description: "Start a new session", source: "builtin" },
	{ name: "thinking", description: "Set the thinking level", source: "builtin", argumentHint: "<level>" },
];

export const EXTENSION_COMMANDS = [{ name: "mcp", description: "Show MCP server status", source: "extension", argumentHint: "[server]" }];

export const COMMANDS = [
	...BUILTIN_COMMANDS,
	...EXTENSION_COMMANDS,
	...SKILLS.map((s) => ({ name: `skill:${s.name}`, description: s.description, source: "skill" })),
	...PROMPTS.map((p) => ({ name: p.name, description: p.description, source: "prompt", argumentHint: p.argumentHint })),
];

/** Opaque, changes whenever the list does (the real hub hashes it the same way). */
export function commandsVersion(commands) {
	let h = 0x811c9dc5;
	for (const c of commands) {
		for (const part of [c.source, c.name, c.argumentHint ?? "", c.description ?? ""]) {
			for (let i = 0; i < part.length; i++) h = Math.imul(h ^ part.charCodeAt(i), 0x01000193);
			h = Math.imul(h ^ 0x1f, 0x01000193);
		}
	}
	return `${commands.length.toString(36)}-${(h >>> 0).toString(36)}`;
}

/** phi's skill expansion (agent-session `_expandSkillCommand`). */
export function expandSkill(skill, args) {
	const block = `<skill name="${skill.name}" location="${skill.location}">\nReferences are relative to ${path.dirname(skill.location)}.\n\n${skill.body}\n</skill>`;
	return args ? `${block}\n\n${args}` : block;
}

/** phi's prompt-template expansion ($@ / $ARGUMENTS = all arguments). */
export function expandPrompt(prompt, args) {
	return prompt.body.replaceAll("$@", args).replaceAll("$ARGUMENTS", args);
}
