import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_TARGETS,
	isContextOverflowText,
	isFallbackTrigger,
	isProbeHealthy,
	matchesPrimary,
	normalizeModelId,
	pickFallback,
} from "../extensions/codebuddy-fallback/decide.ts";
import {
	getCodebuddyFallbackEnabled,
	isFallbackEnvForced,
	setCodebuddyFallbackEnabled,
} from "../extensions/codebuddy-fallback/settings.ts";

// ── 模型归属判断 ─────────────────────────────────────────────────────────────

test("matchesPrimary accepts the credit-rate suffixed codebuddy ids", () => {
	// codebuddy 的 id 由官方 /v3/config 动态生成，倍率会变，不能死盯一个后缀
	assert.equal(matchesPrimary({ provider: "codebuddy", id: "deepseek-v4.1-flash (x0.11)" }, DEFAULT_TARGETS), true);
	assert.equal(matchesPrimary({ provider: "codebuddy", id: "deepseek-v4.1-flash (x0.03)" }, DEFAULT_TARGETS), true);
	assert.equal(matchesPrimary({ provider: "codebuddy", id: "deepseek-v4.1-flash" }, DEFAULT_TARGETS), true);
	assert.equal(matchesPrimary({ provider: "codebuddy", id: "deepseek-v4.1-flash-vision-exp (x0.5)" }, DEFAULT_TARGETS), true);
});

test("matchesPrimary ignores other providers and other codebuddy models", () => {
	assert.equal(matchesPrimary({ provider: "deepseek", id: "deepseek-flash" }, DEFAULT_TARGETS), false);
	assert.equal(matchesPrimary({ provider: "codebuddy", id: "kimi-k3-1 (x1.62)" }, DEFAULT_TARGETS), false);
	assert.equal(matchesPrimary({ provider: "codebuddy", id: "hy4-preview (x0.29)" }, DEFAULT_TARGETS), false);
	assert.equal(matchesPrimary(undefined, DEFAULT_TARGETS), false);
});

test("normalizeModelId strips the trailing rate suffix only", () => {
	assert.equal(normalizeModelId("deepseek-v4.1-flash (x0.11)"), "deepseek-v4.1-flash");
	assert.equal(normalizeModelId("  DeepSeek-V4.1-Flash  "), "deepseek-v4.1-flash");
	assert.equal(normalizeModelId("kimi-k3-1 (x1.62)"), "kimi-k3-1");
	// 中间括号不是倍率后缀，保留
	assert.equal(normalizeModelId("model (beta) (x1)"), "model (beta)");
});

// ── 触发条件 ─────────────────────────────────────────────────────────────────

test("isFallbackTrigger fires for every kind of unavailability", () => {
	const cases = [
		"429 Too Many Requests",
		"rate limit exceeded",
		"insufficient_quota",
		"500 Internal Server Error",
		"502 Bad Gateway",
		"503 Service Unavailable",
		"fetch failed",
		"getaddrinfo ENOTFOUND copilot.tencent.com",
		"401 Unauthorized",
		"model deepseek-v4.1-flash not found",
		"",
	];
	for (const errorMessage of cases) {
		assert.equal(isFallbackTrigger({ stopReason: "error", errorMessage }), true, errorMessage || "<empty>");
	}
	// 没有 errorMessage 也算不可用
	assert.equal(isFallbackTrigger({ stopReason: "error" }), true);
});

test("isFallbackTrigger never fires for success or user abort", () => {
	assert.equal(isFallbackTrigger({ stopReason: "stop" }), false);
	assert.equal(isFallbackTrigger({ stopReason: "toolUse" }), false);
	assert.equal(isFallbackTrigger({ stopReason: "length" }), false);
	// 用户按 Esc 不算故障，不能切模型
	assert.equal(isFallbackTrigger({ stopReason: "aborted", errorMessage: "Request was aborted" }), false);
});

test("context overflow is left to pi's compaction, not to fallback", () => {
	const overflow = "This model's maximum context length is 1000000 tokens, however you requested 1200000 tokens";
	assert.equal(isContextOverflowText(overflow), true);
	assert.equal(isFallbackTrigger({ stopReason: "error", errorMessage: overflow }), false);
	// 429 文本里如果同时出现 "too many tokens" 也不能被误判成溢出
	assert.equal(
		isFallbackTrigger({ stopReason: "error", errorMessage: "429 Too many requests: too many tokens" }),
		true,
	);
});

// ── 备用模型选择 ─────────────────────────────────────────────────────────────

test("pickFallback prefers the configured deepseek-flash", () => {
	const models = [
		{ provider: "codebuddy", id: "deepseek-v4.1-flash (x0.11)" },
		{ provider: "deepseek", id: "deepseek-pro" },
		{ provider: "deepseek", id: "deepseek-flash" },
	];
	assert.equal(pickFallback(models, DEFAULT_TARGETS)?.id, "deepseek-flash");
});

test("pickFallback falls back to any model of that provider, and gives up otherwise", () => {
	const onlyOther = [
		{ provider: "deepseek", id: "deepseek-pro" },
		{ provider: "zai-coding-cn", id: "glm-5.3" },
	];
	assert.equal(pickFallback(onlyOther, DEFAULT_TARGETS)?.id, "deepseek-pro");
	assert.equal(pickFallback([{ provider: "codebuddy", id: "deepseek-v4.1-flash (x0.11)" }], DEFAULT_TARGETS), undefined);
	assert.equal(pickFallback([], DEFAULT_TARGETS), undefined);
});

// ── 探测结果判定 ─────────────────────────────────────────────────────────────

test("isProbeHealthy accepts a normal reply and rejects failures", () => {
	assert.equal(isProbeHealthy({ stopReason: "stop" }), true);
	assert.equal(isProbeHealthy({ stopReason: "length" }), true);
	assert.equal(isProbeHealthy({ stopReason: "toolUse" }), true);
	assert.equal(isProbeHealthy({ stopReason: "error", errorMessage: "429 Too Many Requests" }), false);
	assert.equal(isProbeHealthy({ stopReason: "aborted" }), false);
});

// ── 设置持久化 ───────────────────────────────────────────────────────────────

async function withAgentDir(run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "codebuddy-fallback-settings-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousEnv = process.env.CODEBUDDY_FALLBACK;
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.CODEBUDDY_FALLBACK;
	try {
		await run(dir);
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		if (previousEnv === undefined) delete process.env.CODEBUDDY_FALLBACK;
		else process.env.CODEBUDDY_FALLBACK = previousEnv;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("fallback is enabled by default", async () => {
	await withAgentDir(() => {
		assert.equal(getCodebuddyFallbackEnabled(), true);
		assert.equal(isFallbackEnvForced(), false);
	});
});

test("setCodebuddyFallbackEnabled persists into settings.json without clobbering other keys", async () => {
	await withAgentDir((dir) => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark", codebuddyFingerprint: "off" }, null, 2));

		setCodebuddyFallbackEnabled(false);
		assert.equal(getCodebuddyFallbackEnabled(), false);

		const written = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
		assert.equal(written.codebuddyFallback, false);
		// 其他设置必须原样保留
		assert.equal(written.theme, "dark");
		assert.equal(written.codebuddyFingerprint, "off");

		setCodebuddyFallbackEnabled(true);
		assert.equal(getCodebuddyFallbackEnabled(), true);
	});
});

test("CODEBUDDY_FALLBACK overrides the settings file", async () => {
	await withAgentDir((dir) => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ codebuddyFallback: true }));
		process.env.CODEBUDDY_FALLBACK = "off";
		assert.equal(getCodebuddyFallbackEnabled(), false);
		assert.equal(isFallbackEnvForced(), true);

		process.env.CODEBUDDY_FALLBACK = "on";
		setCodebuddyFallbackEnabled(false);
		// 环境变量优先，命令改动对外部无效（状态提示会说明这一点）
		assert.equal(getCodebuddyFallbackEnabled(), true);
	});
});
