// Strict hand-written validators for phi remote protocol v1 (docs/PROTOCOL.md).
// Wrong type / missing required field / bad enum → error (FAIL).
// Unknown field → warning. Soft semantic hints (lengths, ordering) → warning.

const ERROR_CODES = ["not_found", "bad_request", "session_offline", "forbidden", "internal"];

// ----------------------------------------------------------- schema DSL

export const S = {
	string: { k: "string" },
	nonEmpty: { k: "string", nonEmpty: true },
	number: { k: "number" },
	integer: { k: "integer" },
	epochMs: { k: "epochMs" },
	boolean: { k: "boolean" },
	any: { k: "any" },
	lit: (v) => ({ k: "lit", v }),
	enum: (...vs) => ({ k: "enum", vs }),
	arr: (of) => ({ k: "arr", of }),
	nullable: (of) => ({ k: "nullable", of }),
	obj: (req, opt = {}, check) => ({ k: "obj", req, opt, check }),
	disc: (field, map) => ({ k: "disc", field, map }),
};

const typeName = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export function validate(v, s, p, out) {
	const bad = (msg) => out.errors.push(`${p}: ${msg}`);
	switch (s.k) {
		case "any":
			return;
		case "string":
			if (typeof v !== "string") return bad(`expected string, got ${typeName(v)}`);
			if (s.nonEmpty && !v.length) bad("expected non-empty string");
			return;
		case "number":
			if (typeof v !== "number" || !Number.isFinite(v)) bad(`expected finite number, got ${typeName(v)}`);
			return;
		case "integer":
			if (!Number.isInteger(v)) bad(`expected integer, got ${typeName(v)} ${JSON.stringify(v)}`);
			return;
		case "epochMs":
			if (typeof v !== "number" || !Number.isFinite(v)) return bad(`expected ms epoch number, got ${typeName(v)}`);
			if (v < 1e12 || v > 1e13) bad(`expected ms epoch, got ${v} (seconds? wrong unit?)`);
			return;
		case "boolean":
			if (typeof v !== "boolean") bad(`expected boolean, got ${typeName(v)}`);
			return;
		case "lit":
			if (v !== s.v) bad(`expected ${JSON.stringify(s.v)}, got ${JSON.stringify(v)}`);
			return;
		case "enum":
			if (!s.vs.includes(v)) bad(`expected one of ${s.vs.map((x) => JSON.stringify(x)).join("|")}, got ${JSON.stringify(v)}`);
			return;
		case "nullable":
			if (v === null) return;
			return validate(v, s.of, p, out);
		case "arr":
			if (!Array.isArray(v)) return bad(`expected array, got ${typeName(v)}`);
			v.forEach((x, i) => validate(x, s.of, `${p}[${i}]`, out));
			return;
		case "obj": {
			if (typeName(v) !== "object") return bad(`expected object, got ${typeName(v)}`);
			for (const [k, ks] of Object.entries(s.req)) {
				if (!(k in v) || v[k] === undefined) bad(`missing required field "${k}"`);
				else validate(v[k], ks, `${p}.${k}`, out);
			}
			for (const [k, ks] of Object.entries(s.opt)) {
				if (k in v && v[k] !== undefined) validate(v[k], ks, `${p}.${k}`, out);
			}
			for (const k of Object.keys(v)) if (!(k in s.req) && !(k in s.opt)) out.warnings.push(`${p}: unknown field "${k}"`);
			if (s.check) s.check(v, p, out);
			return;
		}
		case "disc": {
			if (typeName(v) !== "object") return bad(`expected object, got ${typeName(v)}`);
			const d = v[s.field];
			const sub = s.map[d];
			if (!sub) return bad(`unknown ${s.field} ${JSON.stringify(d)} (expected ${Object.keys(s.map).join("|")})`);
			return validate(v, sub, p, out);
		}
		default:
			throw new Error(`bad schema kind ${s.k}`);
	}
}

// ---------------------------------------------------------------- types

const Activity = S.obj({ tool: S.string }, { summary: S.string });

// Overseers (v1 addition): the overseer that started a thread (exo.11 summaries and PastSession).
export const OverseerLink = S.obj({ sessionId: S.nonEmpty }, { name: S.string, thread: S.string });
const THREAD_BUCKETS = ["working", "idle", "error", "exited", "closed"];
export const ThreadCounts = S.obj(
	{ total: S.integer, working: S.integer, idle: S.integer, error: S.integer, exited: S.integer, closed: S.integer },
	{},
	(v, p, out) => {
		for (const k of ["total", ...THREAD_BUCKETS]) if (Number.isInteger(v[k]) && v[k] < 0) out.errors.push(`${p}.${k}: negative`);
		const sum = THREAD_BUCKETS.reduce((n, k) => n + (Number.isInteger(v[k]) ? v[k] : 0), 0);
		// phi's hub: disjoint buckets that sum to total (contract: "computed from the registry plus live summaries").
		if (Number.isInteger(v.total) && sum !== v.total) out.warnings.push(`${p}: buckets sum to ${sum}, total ${v.total}`);
	},
);
export const BoardThread = S.obj(
	{
		name: S.nonEmpty,
		sessionId: S.nonEmpty,
		backend: S.enum("forca", "tmux", "headless", "external"),
		cwd: S.string,
		state: S.enum("running", "exited", "closed"),
		live: S.boolean,
		createdAt: S.epochMs,
	},
	{
		adopted: S.boolean,
		model: S.string,
		thinking: S.string,
		status: S.enum("working", "idle"),
		activity: S.string,
		lastText: S.string,
		lastError: S.string,
		costUsd: S.number,
		contextPercent: S.number,
		lastActivityAt: S.epochMs,
		exitedAt: S.epochMs,
		closedAt: S.epochMs,
		subagentModels: S.obj({}, { default: S.string, allow: S.arr(S.string) }),
	},
	(v, p, out) => {
		if (v.live === false && v.status !== undefined) out.warnings.push(`${p}.status: present on a thread that is not live`);
		if (v.activity !== undefined && v.status !== "working") out.warnings.push(`${p}.activity: present while not working`);
		if (typeof v.model === "string" && v.model && !v.model.includes("/")) out.warnings.push(`${p}.model: "${v.model}" is not "provider/id"`);
		if (v.state === "closed" && v.closedAt === undefined) out.warnings.push(`${p}: state closed without closedAt`);
	},
);

// Subagents (v1 addition): SessionSummary.subagent
export const SUBAGENT_STATUSES = ["running", "done", "failed", "killed"];
export const SubagentInfo = S.obj(
	{ runId: S.nonEmpty, task: S.string, status: S.enum(...SUBAGENT_STATUSES), startedAt: S.epochMs },
	{
		toolCallId: S.nonEmpty,
		index: S.integer,
		name: S.string,
		agent: S.string,
		endedAt: S.epochMs,
		turns: S.integer,
		toolCalls: S.integer,
		background: S.boolean,
	},
	(v, p, out) => {
		if (v.status !== "running" && v.endedAt === undefined) out.warnings.push(`${p}.endedAt: absent on a ${v.status} run`);
		if (v.status === "running" && v.endedAt !== undefined) out.warnings.push(`${p}.endedAt: present on a running run`);
		if (Number.isInteger(v.index) && v.index < 0) out.errors.push(`${p}.index: must be >= 0`);
		if (typeof v.endedAt === "number" && typeof v.startedAt === "number" && v.endedAt < v.startedAt) out.warnings.push(`${p}: endedAt < startedAt`);
	},
);

export const SessionSummary = S.obj(
	{
		sessionId: S.nonEmpty,
		name: S.string,
		cwd: S.nonEmpty,
		host: S.string,
		pid: S.integer,
		// "subagent": Subagents (v1 addition), only for clients that sent hello.features ["subagents"]
		kind: S.enum("interactive", "headless", "subagent"),
		status: S.enum("working", "idle"),
		startedAt: S.epochMs,
		lastActivityAt: S.epochMs,
	},
	{
		model: S.obj({ provider: S.string, id: S.string }, { name: S.string }),
		thinkingLevel: S.string,
		lastText: S.string,
		activity: Activity,
		usage: S.obj({}, { costUsd: S.number, contextPercent: S.number }),
		// Slash commands (v1 addition): opaque string, compared for equality only.
		commandsVersion: S.any,
		// Subagents (v1 addition)
		parentSessionId: S.nonEmpty,
		subagent: SubagentInfo,
		subagents: S.obj({ running: S.integer, total: S.integer }),
		tmux: S.obj({ session: S.nonEmpty }, { window: S.string }),
		// Overseer threads (exo.11) and Overseers (v1 addition)
		overseer: OverseerLink,
		lastError: S.string,
		isOverseer: S.lit(true),
		threadCounts: ThreadCounts,
	},
	(v, p, out) => {
		if (typeof v.lastText === "string") {
			if (v.lastText.length > 200) out.errors.push(`${p}.lastText: ${v.lastText.length} chars > 200`);
			if (/[\r\n]/.test(v.lastText)) out.errors.push(`${p}.lastText: must be single line`);
		}
		if (typeof v.name === "string" && v.name.length > 60) out.warnings.push(`${p}.name: ${v.name.length} chars (> 60; fine only if the user named it)`);
		if (typeof v.name === "string" && !v.name.trim()) out.warnings.push(`${p}.name: empty`);
		if (Number.isInteger(v.pid) && v.pid <= 0) out.errors.push(`${p}.pid: must be > 0`);
		if (v.status === "idle" && v.activity) out.warnings.push(`${p}.activity: present while idle`);
		const cp = v.usage?.contextPercent;
		if (typeof cp === "number" && (cp < 0 || cp > 100)) out.warnings.push(`${p}.usage.contextPercent: ${cp} outside 0..100`);
		if (typeof v.startedAt === "number" && typeof v.lastActivityAt === "number" && v.lastActivityAt < v.startedAt)
			out.warnings.push(`${p}: lastActivityAt < startedAt`);
		if (v.kind === "subagent") {
			if (v.parentSessionId === undefined) out.errors.push(`${p}.parentSessionId: required for kind "subagent"`);
			if (v.subagent === undefined) out.errors.push(`${p}.subagent: required for kind "subagent"`);
			if (v.subagents !== undefined) out.warnings.push(`${p}.subagents: counts belong on the parent, not on a subagent`);
		} else if (v.parentSessionId !== undefined || v.subagent !== undefined) {
			out.errors.push(`${p}: parentSessionId / subagent only belong on kind "subagent"`);
		}
		const sa = v.subagents;
		if (sa && Number.isInteger(sa.running) && Number.isInteger(sa.total) && (sa.running < 0 || sa.running > sa.total))
			out.errors.push(`${p}.subagents: running ${sa.running} not within 0..total ${sa.total}`);
		if (v.threadCounts !== undefined && v.isOverseer !== true) out.warnings.push(`${p}.threadCounts without isOverseer`);
		if (typeof v.lastError === "string" && /[\r\n]/.test(v.lastError)) out.warnings.push(`${p}.lastError: not one line`);
		if (v.overseer?.sessionId !== undefined && v.overseer.sessionId === v.sessionId) out.errors.push(`${p}.overseer: names itself`);
		if (v.commandsVersion !== undefined && typeof v.commandsVersion !== "string") {
			if (typeof v.commandsVersion === "number") out.warnings.push(`${p}.commandsVersion: number (contract says opaque string)`);
			else out.errors.push(`${p}.commandsVersion: expected string, got ${typeName(v.commandsVersion)}`);
		}
	},
);

// Slash commands (v1 addition)
export const COMMAND_SOURCES = ["builtin", "extension", "skill", "prompt"]; // the hub's order
export const CommandInfo = S.obj({ name: S.nonEmpty, source: S.enum(...COMMAND_SOURCES) }, { description: S.string, argumentHint: S.string }, (v, p, out) => {
	if (typeof v.name === "string") {
		if (/\s/.test(v.name)) out.errors.push(`${p}.name: contains whitespace`);
		if (v.name.startsWith("/")) out.errors.push(`${p}.name: must not include the slash`);
	}
	if (typeof v.description === "string") {
		if (/[\r\n]/.test(v.description)) out.warnings.push(`${p}.description: should be one line`);
		if (v.description.length > 160) out.warnings.push(`${p}.description: ${v.description.length} chars (> 160)`);
	}
});

export const LiveState = S.obj({ status: S.enum("working", "idle") }, { activity: Activity });

const base = { id: S.nonEmpty, ts: S.epochMs };
export const TranscriptItem = S.disc("kind", {
	user: S.obj({ ...base, kind: S.lit("user"), text: S.string }, { images: S.integer }, (v, p, out) => {
		if (Number.isInteger(v.images) && v.images < 0) out.errors.push(`${p}.images: negative`);
	}),
	assistant: S.obj(
		{ ...base, kind: S.lit("assistant"), text: S.string },
		{ thinking: S.string, model: S.string, streaming: S.boolean, error: S.string },
	),
	tool: S.obj(
		{ ...base, kind: S.lit("tool"), toolCallId: S.nonEmpty, name: S.string, summary: S.string, status: S.enum("running", "ok", "error") },
		{ args: S.any, output: S.string, outputTruncated: S.boolean },
		(v, p, out) => {
			if (typeof v.summary === "string" && /[\r\n]/.test(v.summary)) out.warnings.push(`${p}.summary: should be one line`);
			if (v.args !== undefined) {
				const n = JSON.stringify(v.args)?.length ?? 0;
				if (n > 8 * 1024) out.warnings.push(`${p}.args: ${n} bytes JSON (contract says truncated to ~4 KB)`);
			}
			if (typeof v.output === "string" && v.output.length > 16 * 1024)
				out.warnings.push(`${p}.output: ${v.output.length} chars (contract says truncated to ~8 KB)`);
		},
	),
	note: S.obj({ ...base, kind: S.lit("note"), text: S.string }, { label: S.string }),
});

export const LiveEvent = S.disc("type", {
	"item.upsert": S.obj({ type: S.lit("item.upsert"), item: TranscriptItem }),
	state: S.obj({ type: S.lit("state"), state: LiveState }),
	// replacedBy: /new, /resume, /fork … moved the conversation to that session id
	reset: S.obj({ type: S.lit("reset") }, { replacedBy: S.nonEmpty }),
});

// hubId is an opaque string, ≤ 64 chars (clarification 15)
const hubIdCheck = (get) => (v, p, out) => {
	const id = get(v);
	if (typeof id === "string" && id.length > 64) out.errors.push(`${p}: hubId is ${id.length} chars (> 64)`);
};
export const Info = S.obj({ name: S.string, hubId: S.nonEmpty, hubVersion: S.string, protocol: S.lit(1) }, {}, hubIdCheck((v) => v.hubId));
export const PairOk = S.obj({ deviceId: S.nonEmpty, token: S.nonEmpty, hubId: S.nonEmpty, name: S.string }, {}, hubIdCheck((v) => v.hubId));
export const PairErr = S.obj({ error: S.lit("invalid_code") });
// clarification 5
export const PairRateLimited = S.obj({ error: S.lit("rate_limited") });
export const PairBadRequest = S.obj({ error: S.lit("bad_request") });

/** Request types whose success reply is `ack`; they fail with `ack ok:false` (clarification 2). */
export const ACK_REQUESTS = new Set([
	"session.prompt",
	"session.abort",
	"session.setModel",
	"session.setThinking",
	"session.spawn",
	"session.close",
	"session.resume",
	"push.register",
	"push.unregister",
]);
/** Allowed image mimeTypes (clarification 15). */
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const ErrBody = S.obj({ code: S.enum(...ERROR_CODES), message: S.string });

/** Session history (v1 addition): one stored session in `sessions.past`. */
export const PastSession = S.obj(
	{
		sessionId: S.nonEmpty,
		title: S.string,
		named: S.boolean,
		cwd: S.string,
		createdAt: S.epochMs,
		modifiedAt: S.epochMs,
		messageCount: S.integer,
		live: S.boolean,
		resumable: S.boolean,
	},
	{
		preview: S.string,
		model: S.obj({ provider: S.nonEmpty, id: S.nonEmpty }),
		liveKind: S.enum("interactive", "headless"),
		// Overseers (v1 addition)
		overseer: OverseerLink,
		isOverseer: S.lit(true),
	},
	(v, p, out) => {
		if (typeof v.title === "string" && v.title.length > 120 && !v.named) out.warnings.push(`${p}.title: ${v.title.length} chars (first-message titles are <= 120)`);
		if (typeof v.preview === "string" && v.preview.length > 200) out.warnings.push(`${p}.preview: ${v.preview.length} chars (<= 200)`);
		if (typeof v.preview === "string" && /\n/.test(v.preview)) out.warnings.push(`${p}.preview: not one line`);
		if (v.liveKind !== undefined && v.live !== true) out.warnings.push(`${p}.liveKind without live: true`);
		if (typeof v.messageCount === "number" && v.messageCount < 1) out.warnings.push(`${p}.messageCount: ${v.messageCount} (sessions with 0 messages are excluded)`);
	},
);

// ------------------------------------------------------------ hub → client

export const HubFrames = {
	welcome: S.obj(
		{
			t: S.lit("welcome"),
			// features: optional additions the hub implements (Session history: "history").
			host: S.obj({ name: S.string, hubId: S.nonEmpty, hubVersion: S.string, protocol: S.lit(1) }, { features: S.arr(S.string) }, hubIdCheck((v) => v.hubId)),
			deviceId: S.nonEmpty,
		},
	),
	pong: S.obj({ t: S.lit("pong"), re: S.string }),
	ack: S.obj({ t: S.lit("ack"), re: S.string, ok: S.boolean }, { error: ErrBody, sessionId: S.nonEmpty, cwd: S.nonEmpty, cwdFallback: S.boolean }, (v, p, out) => {
		if (v.ok === false && !v.error) out.errors.push(`${p}: ok:false without error`);
		if (v.ok === true && v.error) out.warnings.push(`${p}: ok:true with error`);
		if (v.cwdFallback === true && !v.cwd) out.errors.push(`${p}: cwdFallback without cwd`);
	}),
	error: S.obj({ t: S.lit("error"), code: S.enum(...ERROR_CODES), message: S.string }, { re: S.string }),
	sessions: S.obj({ t: S.lit("sessions"), re: S.string, sessions: S.arr(SessionSummary) }, {}, (v, p, out) => {
		if (!Array.isArray(v.sessions)) return;
		const ids = v.sessions.map((s) => s?.sessionId);
		if (new Set(ids).size !== ids.length) out.errors.push(`${p}.sessions: duplicate sessionId`);
	}),
	"session.upsert": S.obj({ t: S.lit("session.upsert"), session: SessionSummary }),
	"session.remove": S.obj({ t: S.lit("session.remove"), sessionId: S.nonEmpty }, { replacedBy: S.nonEmpty }, (v, p, out) => {
		if (v.replacedBy !== undefined && v.replacedBy === v.sessionId) out.errors.push(`${p}.replacedBy: equals sessionId`);
	}),
	"session.snapshot": S.obj(
		{ t: S.lit("session.snapshot"), re: S.string, sessionId: S.nonEmpty, items: S.arr(TranscriptItem), hasMore: S.boolean, state: LiveState },
		{},
		(v, p, out) => itemListChecks(v.items, `${p}.items`, out),
	),
	"sessions.past": S.obj(
		{ t: S.lit("sessions.past"), re: S.string, sessions: S.arr(PastSession) },
		{ nextCursor: S.nonEmpty, indexing: S.boolean },
		(v, p, out) => {
			const list = Array.isArray(v.sessions) ? v.sessions : [];
			const ids = new Set();
			for (let i = 0; i < list.length; i++) {
				const s = list[i];
				if (!s || typeof s !== "object") continue;
				if (ids.has(s.sessionId)) out.errors.push(`${p}.sessions[${i}]: duplicate sessionId ${s.sessionId}`);
				ids.add(s.sessionId);
				if (i > 0 && typeof s.modifiedAt === "number" && typeof list[i - 1]?.modifiedAt === "number" && s.modifiedAt > list[i - 1].modifiedAt)
					out.errors.push(`${p}.sessions[${i}]: not newest-first (modifiedAt ${s.modifiedAt} > ${list[i - 1].modifiedAt})`);
			}
		},
	),
	"session.transcript": S.obj(
		{ t: S.lit("session.transcript"), re: S.string, sessionId: S.nonEmpty, items: S.arr(TranscriptItem), hasMore: S.boolean },
		{},
		(v, p, out) => itemListChecks(v.items, `${p}.items`, out),
	),
	"session.history": S.obj(
		{ t: S.lit("session.history"), re: S.string, sessionId: S.nonEmpty, items: S.arr(TranscriptItem), hasMore: S.boolean },
		{},
		(v, p, out) => itemListChecks(v.items, `${p}.items`, out),
	),
	"session.event": S.obj({ t: S.lit("session.event"), sessionId: S.nonEmpty, event: LiveEvent }),
	// Overseers (v1 addition): every thread an overseer started or adopted, registry order.
	"overseer.board": S.obj({ t: S.lit("overseer.board"), re: S.string, sessionId: S.nonEmpty, threads: S.arr(BoardThread) }, { name: S.string }, (v, p, out) => {
		const list = Array.isArray(v.threads) ? v.threads : [];
		const ids = list.map((t) => t?.sessionId);
		if (new Set(ids).size !== ids.length) out.errors.push(`${p}.threads: duplicate sessionId`);
		if (ids.includes(v.sessionId)) out.errors.push(`${p}.threads: lists the overseer itself`);
	}),
	models: S.obj(
		{
			t: S.lit("models"),
			re: S.string,
			models: S.arr(S.obj({ provider: S.nonEmpty, id: S.nonEmpty, name: S.string, reasoning: S.boolean })),
			thinkingLevels: S.arr(S.string),
		},
		{ current: S.obj({ provider: S.string, id: S.string }), thinkingLevel: S.string },
		(v, p, out) => {
			if (!Array.isArray(v.models)) return;
			if (v.current && !v.models.some((m) => m?.provider === v.current.provider && m?.id === v.current.id))
				out.warnings.push(`${p}.current: ${v.current.provider}/${v.current.id} not in models[]`);
			if (typeof v.thinkingLevel === "string" && Array.isArray(v.thinkingLevels) && !v.thinkingLevels.includes(v.thinkingLevel))
				out.warnings.push(`${p}.thinkingLevel: ${v.thinkingLevel} not in thinkingLevels`);
			// a non-reasoning model reports thinking "off" (clarification 7)
			const cur = v.current && v.models.find((m) => m?.provider === v.current.provider && m?.id === v.current.id);
			if (cur && cur.reasoning === false && v.thinkingLevel !== undefined && v.thinkingLevel !== "off")
				out.errors.push(`${p}.thinkingLevel: ${JSON.stringify(v.thinkingLevel)} but current model ${cur.provider}/${cur.id} is non-reasoning (must be "off")`);
			const keys = v.models.map((m) => `${m?.provider}/${m?.id}`);
			if (new Set(keys).size !== keys.length) out.warnings.push(`${p}.models: duplicate provider/id`);
		},
	),
	commands: S.obj({ t: S.lit("commands"), re: S.string, sessionId: S.nonEmpty, commands: S.arr(CommandInfo) }, {}, (v, p, out) => {
		if (!Array.isArray(v.commands)) return;
		const names = v.commands.map((c) => c?.name);
		if (new Set(names).size !== names.length) out.errors.push(`${p}.commands: duplicate name`);
		const order = v.commands.map((c) => COMMAND_SOURCES.indexOf(c?.source));
		if (order.some((o, i) => i > 0 && o < order[i - 1])) out.warnings.push(`${p}.commands: not grouped builtin → extension → skill → prompt`);
	}),
	cwds: S.obj({ t: S.lit("cwds"), re: S.string, cwds: S.arr(S.string) }, {}, (v, p, out) => {
		if (!Array.isArray(v.cwds)) return;
		if (new Set(v.cwds).size !== v.cwds.length) out.warnings.push(`${p}.cwds: duplicates`);
		for (const c of v.cwds) if (typeof c === "string" && !c.startsWith("/")) out.warnings.push(`${p}.cwds: not absolute: ${c}`);
	}),
};

function itemListChecks(items, p, out) {
	if (!Array.isArray(items)) return;
	const seen = new Set();
	let prevTs = -Infinity;
	items.forEach((it, i) => {
		if (!it || typeof it !== "object") return;
		if (seen.has(it.id)) out.errors.push(`${p}[${i}]: duplicate item id ${it.id}`);
		seen.add(it.id);
		if (typeof it.ts === "number") {
			if (it.ts < prevTs) out.warnings.push(`${p}[${i}]: ts goes backwards (oldest → newest expected)`);
			prevTs = Math.max(prevTs, it.ts);
		}
	});
}

/** Validate any hub → client frame. */
export function validateHubFrame(frame) {
	const out = { errors: [], warnings: [] };
	if (typeName(frame) !== "object") {
		out.errors.push(`frame: expected object, got ${typeName(frame)}`);
		return out;
	}
	const s = HubFrames[frame.t];
	if (!s) {
		out.warnings.push(`frame: unknown t ${JSON.stringify(frame.t)}`);
		return out;
	}
	validate(frame, s, frame.t, out);
	return out;
}

export function check(value, schema, p = "value") {
	const out = { errors: [], warnings: [] };
	validate(value, schema, p, out);
	return out;
}

export { ERROR_CODES };
