import assert from "node:assert/strict";
import test from "node:test";
import {
	CharRatio,
	DEFAULT_TEXT_RATIO,
	DEFAULT_TOOL_RATIO,
	estimateDeltaTokens,
	fastClassifyModel,
	TOKENIZER_REGISTRY,
	TokenRateMeter,
} from "../extensions/tokenspeed.ts";

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Stream `perDelta` words every 100ms from `from` to `to`. */
function stream(meter: TokenRateMeter, from: number, to: number, perDelta: number) {
	const delta = `${"w ".repeat(perDelta)}`;
	for (let t = from; t < to; t += 100) meter.push(delta, t);
}

/** `count` messages of 600 tokens over 10s at 60 tok/s, 5s tool gaps, billed as counted. Returns the clock. */
function settle(meter: TokenRateMeter, count: number, billed = 600): number {
	let clock = 0;
	for (let i = 0; i < count; i++) {
		meter.begin(clock);
		stream(meter, clock, clock + 10_000, 6);
		clock += 10_000;
		meter.end(billed, clock);
		clock += 5_000;
	}
	return clock;
}

test("TokenRateMeter reports null until enough tokens and stream time accumulate", () => {
	const meter = new TokenRateMeter(words);
	assert.equal(meter.rate(0), null);
	meter.begin(0);
	// Before 500ms / min tokens, rate is null
	meter.push("w ".repeat(3), 200);
	assert.equal(meter.rate(200), null);
	// Once enough tokens and time accumulate, rate is reported
	meter.push("w ".repeat(10), 600);
	const rate = meter.rate(600);
	assert.ok(rate !== null && rate > 0, `expected rate, got ${rate}`);
});

test("TokenRateMeter holds across tool execution and is only nudged by a short burst", () => {
	const meter = new TokenRateMeter(words);
	const clock = settle(meter, 6);
	const baseRate = meter.rate(clock);
	assert.ok(baseRate !== null && Math.abs(baseRate - 60) < 5, `expected ~60, got ${baseRate}`);
	const afterIdle = meter.rate(clock + 60_000);
	assert.ok(afterIdle !== null && Math.abs(afterIdle - 60) < 5, `expected ~60, got ${afterIdle}`);

	meter.begin(clock);
	stream(meter, clock, clock + 2000, 20);
	const peak = meter.rate(clock + 2000) ?? 0;
	assert.ok(peak > 60 && peak < 80, `expected peak between 60 and 80, got ${peak}`);
});

test("TokenRateMeter converges to a sustained new rate within the longest half-life", () => {
	const meter = new TokenRateMeter(words);
	const clock = settle(meter, 6);
	meter.begin(clock);
	stream(meter, clock, clock + 80_000, 20);
	const after = meter.rate(clock + 80_000) ?? 0;
	assert.ok(after > 150 && after < 200, `expected after between 150 and 200, got ${after}`);
});

test("TokenRateMeter charges hidden pre-delta reasoning against its silent span", () => {
	const meter = new TokenRateMeter(words);
	meter.begin(0);
	meter.push("x y", 20_000);
	meter.end(1500, 20_100);
	const rate = meter.rate(20_100);
	assert.ok(rate !== null && Math.abs(rate - 1500 / 20.1) < 5, `expected ~74.6, got ${rate}`);
});

test("TokenRateMeter never amplifies a visible burst by overhead learned from small tool calls", () => {
	const meter = new TokenRateMeter(words);
	let clock = 0;
	for (let i = 0; i < 10; i++) {
		meter.begin(clock);
		meter.push("w ".repeat(25), clock + 1500);
		clock += 2000;
		meter.end(80, clock);
		clock += 3000;
	}
	const rate1 = meter.rate(clock);
	assert.ok(rate1 !== null && Math.abs(rate1 - 40) < 10, `expected ~40, got ${rate1}`);

	meter.begin(clock);
	let peak = 0;
	for (let t = 0; t < 20_000; t += 100) {
		meter.push("w ".repeat(10), clock + t);
		peak = Math.max(peak, meter.rate(clock + t) ?? 0);
	}
	assert.ok(peak < 115, `expected peak < 115, got ${peak}`);
	meter.end(2055, clock + 20_000);
	const finalRate = meter.rate(clock + 20_000) ?? 0;
	assert.ok(finalRate > 80 && finalRate < 105, `expected between 80 and 105, got ${finalRate}`);
});

test("TokenRateMeter blanks on reset", () => {
	const meter = new TokenRateMeter(words);
	const clock = settle(meter, 2);
	meter.reset();
	assert.equal(meter.rate(clock), null);
});

test("TokenRateMeter seed shows a completed turn's rate immediately", () => {
	const meter = new TokenRateMeter(words);
	meter.seed(600, 10_000);
	const r1 = meter.rate(1_000);
	assert.ok(r1 !== null && Math.abs(r1 - 60) < 1, `expected 60, got ${r1}`);
	const r2 = meter.rate(61_000);
	assert.ok(r2 !== null && Math.abs(r2 - 60) < 1, `expected 60, got ${r2}`);
});

test("TokenRateMeter seed scales small turns past evidence gate without changing rate", () => {
	const meter = new TokenRateMeter(words);
	meter.seed(120, 2_000);
	const r = meter.rate(0);
	assert.ok(r !== null && Math.abs(r - 60) < 1, `expected 60, got ${r}`);

	meter.seed(0, 2_000);
	assert.equal(meter.rate(0), null);
});

test("TokenRateMeter blends new turn with seeded baseline", () => {
	const meter = new TokenRateMeter(words);
	meter.seed(600, 10_000);
	meter.begin(5_000);
	stream(meter, 5_000, 15_000, 3);
	const blended = meter.rate(15_000) ?? 0;
	assert.ok(blended > 30 && blended < 60, `expected between 30 and 60, got ${blended}`);
});

test("estimateDeltaTokens handles CJK, ASCII, and tool calls", () => {
	assert.equal(estimateDeltaTokens("", 2.5, false), 0);

	const toolTokens = estimateDeltaTokens("1234567", 2.5, true);
	assert.equal(toolTokens, 7 / DEFAULT_TOOL_RATIO);

	const cjkTokens = estimateDeltaTokens("你好世界", 2.5, false);
	assert.ok(Math.abs(cjkTokens - 2.8) < 0.01);

	const mixedTokens = estimateDeltaTokens("Hello 世界", 2.5, false);
	const expected = 2 * 0.7 + 6 / 2.5;
	assert.ok(Math.abs(mixedTokens - expected) < 0.01);
});

test("CharRatio updates with authoritative usage", () => {
	const cr = new CharRatio();
	assert.equal(cr.value(), DEFAULT_TEXT_RATIO);

	cr.update(100, 0, 50);
	assert.equal(cr.value(), 2.0);

	cr.update(1000, 0, 10);
	assert.equal(cr.value(), 2.0);
});

test("fastClassifyModel correctly detects core model families", () => {
	assert.equal(fastClassifyModel("minimax-cn/MiniMax-M3"), "minimax");
	assert.equal(fastClassifyModel("codebuddy/deepseek-v4.1-flash"), "deepseek");
	assert.equal(fastClassifyModel("zai-coding-cn/glm-5.3"), "glm");
	assert.equal(fastClassifyModel("openrouter/qwen/qwen-2.5-72b-instruct"), "qwen");
	assert.equal(fastClassifyModel("openai-codex/gpt-5.6-luna"), "openai");
	assert.equal(fastClassifyModel("antigravity/claude-sonnet-4-6"), "claude");
	assert.equal(fastClassifyModel("openrouter/meta-llama/llama-3.3-70b-instruct"), "llama");
	assert.equal(fastClassifyModel("antigravity/gemini-3.8-flash"), "gemma");
	assert.equal(fastClassifyModel("openrouter/mistralai/mistral-large-2411"), "mistral");
	assert.equal(fastClassifyModel("openrouter/01-ai/yi-1.5-34b-chat"), "yi");
	assert.equal(fastClassifyModel("unknown-model-xyz"), null);
});

test("TOKENIZER_REGISTRY contains URLs for all major families", () => {
	const families = ["minimax", "qwen", "deepseek", "glm", "openai", "llama", "claude", "mistral", "gemma", "yi", "grok", "phi"];
	for (const f of families) {
		assert.ok(TOKENIZER_REGISTRY[f], `Missing family ${f} in TOKENIZER_REGISTRY`);
		assert.ok(TOKENIZER_REGISTRY[f].url.startsWith("https://"), `Invalid URL for ${f}`);
	}
});
