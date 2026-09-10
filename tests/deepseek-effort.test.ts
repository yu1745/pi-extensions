import assert from "node:assert/strict";
import test from "node:test";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import extension, { buildReasoningEffortPrefix, isDeepSeekV41, rewriteEffortPayload } from "../extensions/deepseek-effort.ts";

// Model capabilities match the user's V4.1 configuration. In particular,
// minimal/medium are clamped away; xhigh is not available.
const model = {
	id: "deepseek-flash", provider: "deepseek",
	api: "openai-completions", baseUrl: "https://api.deepseek.com", reasoning: true,
	compat: { thinkingFormat: "deepseek" },
	thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
};

function harness({ level = "high", selected = model, deferred = false, branch = [] as any[] } = {}) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const statuses = new Map<string, string>();
	const notifications: string[] = [];
	const pending: Array<() => unknown> = [];
	let entries = structuredClone(branch);
	const ctx: any = {
		model: structuredClone(selected), hasUI: true,
		get thinkingLevel() { return level; },
		sessionManager: { getBranch: () => entries },
		ui: {
			setStatus: (key: string, value: string) => statuses.set(key, value),
			theme: { fg: (_: string, value: string) => value },
			notify: (message: string) => notifications.push(message),
		},
	};
	const emit = (name: string, data: any = {}) => handlers.get(name)?.({ type: name, ...data }, ctx);
	function setLevel(requested: string) {
		const previousLevel = level;
		level = clampThinkingLevel(ctx.model, requested as any);
		if (level === previousLevel) return;
		entries.push({ type: "thinking_level_change", thinkingLevel: level });
		const event = { level, previousLevel };
		if (deferred) pending.push(() => emit("thinking_level_select", event));
		else emit("thinking_level_select", event);
	}
	extension({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getThinkingLevel: () => level,
		setThinkingLevel: setLevel,
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
	} as any);
	emit("session_start");
	return {
		ctx, statuses, notifications, emit, setLevel,
		get level() { return level; },
		get branch() { return structuredClone(entries); },
		async flush() { while (pending.length) await pending.shift()!(); },
		command: (input: string) => commands.get("effort").handler(input, ctx),
		request: (payload: any = { model: ctx.model.id, messages: [{ role: "system", content: "Base instructions" }] }) =>
			emit("before_provider_request", { payload }) ?? payload,
		tree(branch: any[], newLevel?: string) { entries = structuredClone(branch); if (newLevel !== undefined) level = newLevel; emit("session_tree"); },
	};
}

for (const deferred of [false, true]) {
	test(`exact scalar survives self-emitted events and clamping (deferred=${deferred})`, async () => {
		const h = harness({ deferred });
		for (const value of [1, 24, 42, 59, 76, 93, 100]) {
			await h.command(String(value));
			await h.flush();
			assert.match(h.statuses.get("deepseek-effort")!, new RegExp(`Effort: ${value} \\[prompt\\?\\]$`));
		}
	});
}

test("strict input rejects suffixes, decimals, exponents and inherited property names", async () => {
	const h = harness();
	await h.command("42");
	for (const value of ["50abc", "2.5", "1e2", "101", "-1", "NaN", "Infinity", "constructor", "toString", "1 2"]) {
		await h.command(value);
		assert.match(h.statuses.get("deepseek-effort")!, /Effort: 42 \[prompt\?\]$/);
		assert.match(h.notifications.at(-1)!, /invalid/i);
	}
});

test("startup honors Pi off and low rather than unconditionally enabling 75", () => {
	for (const [level, expected] of [["off", "off"], ["low", "50"], ["high", "75"]]) {
		const h = harness({ level });
		assert.equal(h.statuses.get("deepseek-effort"), `Effort: ${expected}${expected === "off" ? "" : " [API]"}`);
	}
});

test("built-in changes override exact scalar; delayed stale events do not", async () => {
	const h = harness({ deferred: true });
	await h.command("42");
	h.setLevel("max");
	await h.flush();
	assert.equal(h.statuses.get("deepseek-effort"), "Effort: 100 [prompt?]");
	h.setLevel("off");
	await h.flush();
	assert.equal(h.statuses.get("deepseek-effort"), "Effort: off");
});

test("state is isolated per instance and restored from active branch", async () => {
	const a = harness();
	await a.command("42");
	const b = harness();
	assert.equal(b.statuses.get("deepseek-effort"), "Effort: 75 [API]");
	const resumed = harness({ branch: a.branch, level: a.level });
	assert.equal(resumed.statuses.get("deepseek-effort"), "Effort: 42 [prompt?]");
	const oldBranch = a.branch;
	await a.command("93");
	a.tree(oldBranch, "low");
	assert.equal(a.statuses.get("deepseek-effort"), "Effort: 42 [prompt?]");
	a.tree([], "high");
	assert.equal(a.statuses.get("deepseek-effort"), "Effort: 75 [API]");
});

test("unrelated models and unsupported transports are not rewritten", async () => {
	for (const selected of [
		{ ...model, id: "deepseek-v4-flash" },
		{ ...model, id: "deepseek-v5-flash" },
		{ ...model, id: "deepseek-v4.1garbage" },
		{ ...model, api: "anthropic-messages" },
		{ ...model, reasoning: false },
		{ ...model, provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", compat: { thinkingFormat: "openrouter" } },
	]) {
		const h = harness({ selected });
		const payload = { messages: [{ role: "system", content: "untouched" }], reasoning_effort: "high" };
		assert.equal(h.request(payload), payload);
		await h.command("42");
		assert.equal(h.level, "high");
	}
});

test("known model IDs include official alias and legacy V4.1 names only", () => {
	for (const id of ["deepseek-flash", "deepseek-v4.1", model.id, "deepseek-v4.1-flash-expires-on-0910", "deepseek-ai/DeepSeek-V4.1-Flash"]) {
		assert.equal(isDeepSeekV41(id), true, id);
	}
	for (const id of ["deepseek-v4.10-flash", "deepseek-v5", "not-deepseek-v4.1", "deepseek-v4.1garbage"]) {
		assert.equal(isDeepSeekV41(id), false, id);
	}
});

test("prompt requests use the exact scalar and omit quantized API effort", async () => {
	const h = harness({ deferred: true });
	await h.command("42");
	await h.flush();
	const original = { model: model.id, messages: [{ role: "system", content: "Base" }, { role: "user", content: "hello" }], reasoning_effort: "low", max_tokens: 4000, thinking: { type: "disabled", extra: true } };
	const frozen = structuredClone(original);
	const next = h.request(original);
	assert.equal(next.messages[0].content, buildReasoningEffortPrefix(42) + "Base");
	assert.equal(Object.hasOwn(next, "reasoning_effort"), false);
	assert.deepEqual(next.thinking, { type: "enabled", extra: true });
	assert.equal(next.max_tokens, 4000);
	assert.deepEqual(original, frozen);
	assert.deepEqual(h.request(next), next); // Retry/idempotence.
	await h.command("93");
	const changed = h.request(next);
	assert.equal(changed.messages[0].content, buildReasoningEffortPrefix(93) + "Base");
	await h.command("off");
	const off = h.request(changed);
	assert.equal(off.messages[0].content, "Base");
	assert.equal(off.reasoning_effort, "none");
	assert.equal(off.thinking.type, "disabled");
});

test("named presets switch to API-only mode and remove stale numeric prefixes", async () => {
	const h = harness();
	await h.command("42");
	let payload = h.request();
	for (const preset of ["low", "high", "max"]) {
		await h.command(preset);
		payload = h.request(payload);
		assert.equal(payload.reasoning_effort, preset);
		assert.equal(payload.messages[0].content, "Base instructions");
		assert.equal(payload.thinking.type, "enabled");
		assert.match(h.statuses.get("deepseek-effort")!, /\[API\]$/);
	}
});

test("strings, text blocks, empty/missing system messages, and report prefix migration", () => {
	const select = { mode: "prompt" as const, effort: 37 };
	const prefix = buildReasoningEffortPrefix(37);
	for (const messages of [[], [{ role: "user", content: "hello" }]]) {
		const next: any = rewriteEffortPayload({ messages }, select);
		assert.deepEqual(next.messages, [{ role: "system", content: prefix }, ...messages]);
	}
	const report = "Reasoning Effort: 75 (range 1-100; higher values request more thorough reasoning)\n\n";
	for (const content of ["Base", report + "Base", report + report + "Base"]) {
		const next: any = rewriteEffortPayload({ messages: [{ role: "developer", content }] }, select);
		assert.equal(next.messages[0].role, "developer");
		assert.equal(next.messages[0].content, prefix + "Base");
	}
	const blocks = [{ type: "text", text: report + "Base", cache_control: { type: "ephemeral" } }, { type: "text", text: "More" }];
	const original = structuredClone(blocks);
	const next: any = rewriteEffortPayload({ messages: [{ role: "system", content: blocks }] }, select);
	assert.equal(next.messages[0].content[0].text, prefix + "Base");
	assert.deepEqual(next.messages[0].content[0].cache_control, { type: "ephemeral" });
	assert.deepEqual(next.messages[0].content[1], blocks[1]);
	assert.deepEqual(blocks, original);
});

test("wrong request models and unknown payloads are left untouched", () => {
	const h = harness();
	const payload = { model: "some-other-model", messages: [], reasoning_effort: "max" };
	assert.equal(h.request(payload), payload);
	for (const payload of [null, "text", [], { input: [] }, { messages: null }]) {
		assert.equal(rewriteEffortPayload(payload, { mode: "prompt", effort: 42 }), payload);
	}
});

test("model switches clear UI and never leak prefixes into another model", async () => {
	const h = harness();
	await h.command("42");
	h.ctx.model = { ...model, id: "unrelated" };
	h.emit("model_select");
	assert.equal(h.statuses.get("deepseek-effort"), undefined);
	const payload = { model: "unrelated", messages: [{ role: "system", content: "Base" }] };
	assert.equal(h.request(payload), payload);
	h.ctx.model = { ...model };
	h.emit("model_select");
	assert.equal(h.statuses.get("deepseek-effort"), "Effort: 42 [prompt?]");
	assert.equal(h.emit("before_agent_start", { systemPrompt: "Base" }), undefined);
});

test("corrupt persistent entries are ignored; changed Pi startup level wins", async () => {
	const h = harness();
	await h.command("42");
	const resumed = harness({ branch: h.branch, level: "off" });
	assert.equal(resumed.statuses.get("deepseek-effort"), "Effort: off");
	for (const data of [null, {}, { version: 1, modelKey: `${model.provider}/${model.id}`, mode: "prompt", effort: 900, level: "high" }]) {
		const bad = harness({ branch: [{ type: "custom", customType: "deepseek-effort-state", data }] });
		assert.equal(bad.statuses.get("deepseek-effort"), "Effort: 75 [API]");
	}
});

test("headless requests do not require a UI", async () => {
	const h = harness();
	h.ctx.hasUI = false;
	h.ctx.ui.setStatus = () => { throw new Error("UI unavailable"); };
	h.emit("session_start");
	assert.equal(h.request().reasoning_effort, "high");
});

test("real /tree lifecycle leaves Pi level unchanged until extension restores the carrier", async () => {
	for (const deferred of [false, true]) {
		const h = harness({ deferred });
		await h.command("42");
		await h.flush();
		const oldBranch = h.branch;
		await h.command("93");
		await h.flush();
		assert.equal(h.level, "max");
		h.tree(oldBranch); // Actual Pi navigates messages without restoring thinking.
		await h.flush();
		assert.equal(h.level, "low");
		assert.equal(h.statuses.get("deepseek-effort"), "Effort: 42 [prompt?]");
		assert.equal(h.request().messages[0].content, buildReasoningEffortPrefix(42) + "Base instructions");
	}
});

test("leaving prompt mode removes the prefix-only message added to user-first payloads", async () => {
	for (const messages of [[], [{ role: "user", content: "hello" }]]) {
		for (const command of ["off", "high"]) {
			const h = harness();
			await h.command("42");
			const prompted = h.request({ messages });
			await h.command(command);
			assert.deepEqual(h.request(prompted).messages, messages);
		}
	}
});

test("delayed user cycling back to the carrier is not confused with our own echo", async () => {
	const h = harness({ deferred: true });
	await h.command("42"); // Queues own high -> low echo.
	h.setLevel("max");
	h.setLevel("low");
	await h.flush();
	assert.equal(h.statuses.get("deepseek-effort"), "Effort: 50 [prompt?]");
	assert.equal(h.request().messages[0].content, buildReasoningEffortPrefix(50) + "Base instructions");
});

test("back-to-back exact commands survive both queued echoes", async () => {
	const h = harness({ deferred: true });
	await h.command("42");
	await h.command("93");
	await h.flush();
	assert.equal(h.statuses.get("deepseek-effort"), "Effort: 93 [prompt?]");
});

test("an older UI event cannot quantize a newer exact command on the same carrier", async () => {
	const h = harness({ deferred: true });
	h.setLevel("low"); // Notification is delayed until after the command.
	await h.command("42"); // Carrier already low, so the command emits no event.
	await h.flush();
	assert.equal(h.statuses.get("deepseek-effort"), "Effort: 42 [prompt?]");
});
