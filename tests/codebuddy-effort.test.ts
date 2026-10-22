import assert from "node:assert/strict";
import test from "node:test";
import { piThinkingLevelMap, resolveEffort } from "../extensions/codebuddy-fp/index.ts";

test("官方声明 supportedEfforts 时严格 1:1 映射（medium 未声明就不可选）", () => {
	const map = piThinkingLevelMap(["low", "high", "max"], true, "high");
	assert.ok(map);
	assert.equal(map!.off, "none", "官方允许关思考 → off 映射为 none");
	assert.equal(map!.minimal, null);
	assert.equal(map!.low, "low");
	assert.equal(map!.medium, null);
	assert.equal(map!.high, "high");
	assert.equal(map!.xhigh, null);
	assert.equal(map!.max, "max");
});

test("官方没声明 supportedEfforts 时不再把 pi 档位名原样发给上游", () => {
	// hy3 / kimi-k3-1 / glm-4.x / minimax-* 这类只给了一个 defaultEffort 的模型：
	// 旧实现返回 undefined → pi 把 minimal/xhigh 原样发给上游，上游不认。
	const map = piThinkingLevelMap(undefined, false, "high");
	assert.ok(map);
	assert.equal(map!.low, "low");
	assert.equal(map!.medium, "medium");
	assert.equal(map!.high, "high");
	assert.equal(map!.xhigh, "max");
	assert.equal(map!.max, "max");
	assert.equal(map!.minimal, "high", "minimal 落到官方默认档");
	assert.equal(map!.off, null, "上游关不掉思考 → off 档隐藏");
});

test("官方允许关思考时 off 才映射为 none", () => {
	assert.equal(piThinkingLevelMap(["low", "high"], true, "high")!.off, "none");
	assert.equal(piThinkingLevelMap(["low", "high"], false, "high")!.off, null);
});

test("既无 supportedEfforts 也无默认档时返回 undefined（不臆造映射）", () => {
	assert.equal(piThinkingLevelMap(undefined, false, undefined), undefined);
});

test("resolveEffort：pi 给了档位就原样透传", () => {
	assert.equal(resolveEffort("none", "high"), "none");
	assert.equal(resolveEffort("low", "high"), "low");
	assert.equal(resolveEffort("high", "high"), "high");
	assert.equal(resolveEffort("max", "high"), "max");
});

test("resolveEffort：pi 没给档位时用模型官方默认档，而不是硬编码 high", () => {
	assert.equal(resolveEffort(undefined, "medium"), "medium");
	assert.equal(resolveEffort(undefined, undefined), "high");
});
