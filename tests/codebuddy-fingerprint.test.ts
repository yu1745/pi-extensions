import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { beginChatRound, resetChatRound, shapeChatBody } from "../extensions/codebuddy-fp/index.ts";
import {
	getCodebuddyFingerprint,
	isFingerprintEnvForced,
	setCodebuddyFingerprint,
} from "../extensions/codebuddy-fp/settings.ts";

const model = {
	id: "deepseek-v4.1-flash (x0.03)",
	upstreamId: "deepseek-v4.1-flash",
	maxTokens: 128_000,
};

const piTools = [
	{ type: "function", function: { name: "read", description: "pi read", parameters: { type: "object" } } },
	{ type: "function", function: { name: "bash", description: "pi bash", parameters: { type: "object" } } },
];

function payload(overrides: Record<string, unknown> = {}) {
	return {
		model: "deepseek-v4.1-flash (x0.03)",
		messages: [
			{ role: "system", content: "PI SYSTEM PROMPT" },
			{ role: "user", content: "hello" },
		],
		tools: piTools,
		temperature: 0.7,
		stream: true,
		stream_options: { include_usage: true },
		...overrides,
	};
}

test("off mode keeps exactly one copy of pi's prompt and tools", () => {
	const p = payload();
	const out = shapeChatBody(p, model, false);

	assert.equal(out.tools, p.tools, "pi tools must pass through untouched");
	assert.equal(out.messages, p.messages, "pi messages must pass through untouched");
	assert.equal(out.messages[0].content, "PI SYSTEM PROMPT");
	assert.equal(out.messages.length, 2, "no injected extra system message");
	assert.deepEqual(out.messages.map((m: any) => m.role), ["system", "user"]);

	// 关键契约：模型绝不可能同时看到两份提示词/两份工具
	const names = out.tools.map((t: any) => t.function.name);
	assert.deepEqual(names, ["read", "bash"]);
	assert.equal(out.messages.filter((m: any) => m.role === "system" || m.role === "developer").length, 1);
});

test("off mode still strips the credit-rate suffix from the outgoing model id", () => {
	assert.equal(shapeChatBody(payload(), model, false).model, "deepseek-v4.1-flash");
});

test("full mode swaps in the official prompt and tool set on the first round", () => {
	const out = shapeChatBody(payload(), model, true);

	assert.equal(out.model, "deepseek-v4.1-flash");
	assert.notEqual(out.tools, payload().tools, "official tool set replaces pi's");
	assert.ok(Array.isArray(out.tools) && out.tools.length > 0);
	const names = out.tools.map((t: any) => t.function?.name ?? t.name);
	assert.ok(names.includes("Read"), `expected official Read tool, got ${names.slice(0, 6).join(",")}`);
	assert.ok(!names.includes("read"), "pi's lowercase read must not be present");

	// 官方 system 提示词模板已填充，且仍是单条 system 消息
	assert.equal(out.messages.length, 2);
	assert.equal(out.messages.filter((m: any) => m.role === "system").length, 1);
	assert.notEqual(out.messages[0].content, "PI SYSTEM PROMPT");
	assert.match(out.messages[0].content, /CodeBuddy Code/, "official system prompt template applied");
	assert.match(out.messages[0].content, /<env>/, "<env> block filled with real values");
	assert.doesNotMatch(out.messages[0].content, /\{\{ENV\}\}|\{\{MODEL_NAME\}\}|\{\{MODEL_ID\}\}/, "no unsubstituted placeholders");
});

test("full mode is byte-identical to the official baseline field order", () => {
	const out = shapeChatBody(payload(), model, false);
	assert.deepEqual(Object.keys(out), [
		"model", "messages", "tools", "temperature", "max_tokens",
		"stream", "stream_options", "reasoning_effort", "verbosity", "reasoning_summary",
	]);
});

test("body keeps official defaults for effort/verbosity/summary and model max_tokens", () => {
	const out = shapeChatBody(payload(), model, false);
	assert.equal(out.reasoning_effort, "high");
	assert.equal(out.verbosity, "high");
	assert.equal(out.reasoning_summary, "auto");
	assert.equal(out.max_tokens, 128_000);
	assert.equal(out.temperature, 0.7);
});

// ── 设置持久化 ──────────────────────────────────────────────────────────────
// getAgentDir() 每次调用都重读 PI_CODING_AGENT_DIR，所以只需在用例里切换环境变量。
async function withAgentDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "codebuddy-fp-settings-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousMode = process.env.CODEBUDDY_FINGERPRINT;
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.CODEBUDDY_FINGERPRINT;
	try {
		await run(dir);
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		if (previousMode === undefined) delete process.env.CODEBUDDY_FINGERPRINT;
		else process.env.CODEBUDDY_FINGERPRINT = previousMode;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("fingerprint defaults to off, persists, and merges into existing settings.json", async () => {
	await withAgentDir(async (dir) => {
		const file = join(dir, "settings.json");
		writeFileSync(file, JSON.stringify({ theme: "dark", webSearchBackend: "zai" }, null, 2));

		assert.equal(getCodebuddyFingerprint(), "off", "default must be off (no disguise)");
		assert.equal(isFingerprintEnvForced(), false);

		setCodebuddyFingerprint("full");
		const saved = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(saved.codebuddyFingerprint, "full");
		assert.equal(saved.theme, "dark", "unrelated settings preserved");
		assert.equal(saved.webSearchBackend, "zai", "unrelated settings preserved");
		assert.equal(getCodebuddyFingerprint(), "full");

		setCodebuddyFingerprint("off");
		assert.equal(JSON.parse(readFileSync(file, "utf8")).codebuddyFingerprint, "off");
		assert.equal(getCodebuddyFingerprint(), "off");
	});
});

test("CODEBUDDY_FINGERPRINT env var overrides the settings file", async () => {
	await withAgentDir(async (dir) => {
		process.env.CODEBUDDY_FINGERPRINT = "on";
		assert.equal(getCodebuddyFingerprint(), "full", "'on' is accepted as an alias for full");
		assert.equal(isFingerprintEnvForced(), true);

		process.env.CODEBUDDY_FINGERPRINT = "off";
		assert.equal(getCodebuddyFingerprint(), "off");

		process.env.CODEBUDDY_FINGERPRINT = "garbage";
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ codebuddyFingerprint: "full" }));
		assert.equal(getCodebuddyFingerprint(), "full", "invalid env value falls back to the file");
		assert.equal(isFingerprintEnvForced(), false);
	});
});

test("corrupt settings.json falls back to the default instead of throwing", async () => {
	await withAgentDir(async (dir) => {
		writeFileSync(join(dir, "settings.json"), "{ not json");
		assert.equal(getCodebuddyFingerprint(), "off");
	});
});

// ── 轮次门控 ────────────────────────────────────────────────────────────────

test("off mode never disguises, not even the first round", async () => {
	await withAgentDir(async (dir) => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ codebuddyFingerprint: "off" }));
		resetChatRound();
		for (let round = 1; round <= 3; round++) {
			assert.equal(beginChatRound(), false, `round ${round} must not disguise`);
		}
	});
});

test("full mode disguises only the first round, and resets per session", async () => {
	await withAgentDir(async (dir) => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ codebuddyFingerprint: "full" }));
		resetChatRound();
		assert.equal(beginChatRound(), true, "first round of a session disguises");
		assert.equal(beginChatRound(), false, "second round falls back to pi's own tools");

		resetChatRound(); // 模拟 session_start
		assert.equal(beginChatRound(), true, "a new session starts a fresh round 1");
	});
});
