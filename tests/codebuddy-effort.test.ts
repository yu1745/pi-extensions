import assert from "node:assert/strict";
import test from "node:test";
import {
	formatEffortLevels,
	piThinkingLevelMap,
	refineThinkingLevelMap,
	resolveEffort,
} from "../extensions/codebuddy-fp/index.ts";

test("官方声明 supportedEfforts 时用严格 1:1 映射（medium 未声明就不可选）", () => {
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

test("官方没声明 supportedEfforts 时先按同名档位走（实测不生效的再由 refine 修正）", () => {
	const map = piThinkingLevelMap(undefined, false, "high");
	assert.ok(map);
	assert.equal(map!.low, "low");
	assert.equal(map!.medium, "medium");
	assert.equal(map!.high, "high");
	assert.equal(map!.xhigh, "max");
	assert.equal(map!.max, "max");
	assert.equal(map!.off, null, "上游关不掉思考 → off 档隐藏");
});

test("官方允许关思考时 off 才映射为 none", () => {
	assert.equal(piThinkingLevelMap(["low", "high"], true, "high")!.off, "none");
	assert.equal(piThinkingLevelMap(["low", "high"], false, "high")!.off, null);
});

test("既无 supportedEfforts 也无默认档时返回 undefined（不臆造映射）", () => {
	assert.equal(piThinkingLevelMap(undefined, false, undefined), undefined);
});

test("refine：实测零思考的档位被换成真会思考的档（hy3 medium 实测 0）", () => {
	// hy3 实测：low=159, medium=0, high=118, max=143
	const base = piThinkingLevelMap(undefined, false, "high")!;
	const refined = refineThinkingLevelMap(base, { low: 159, medium: 0, high: 118, max: 143 }, "high");
	assert.equal(refined.medium, "high", "哑档 medium → 官方默认档 high");
	assert.equal(refined.low, "low", "正常档保持原样");
	assert.equal(refined.high, "high");
	assert.equal(refined.max, "max");
});

test("refine：思考量不到最优档 10% 也算哑档（glm-5.3 high 实测 10 vs max 234）", () => {
	const base = piThinkingLevelMap(["low", "high", "max"], false, "max")!;
	const refined = refineThinkingLevelMap(base, { low: 0, high: 10, max: 234 }, "max");
	assert.equal(refined.low, "max");
	assert.equal(refined.high, "max");
	assert.equal(refined.max, "max");
});

test("refine：有思考的档位保持原样（kimi-k3-1 各档都思考）", () => {
	const base = piThinkingLevelMap(undefined, false, "medium")!;
	const refined = refineThinkingLevelMap(base, { low: 72, medium: 74, high: 123, max: 176 }, "medium");
	assert.equal(refined.low, "low");
	assert.equal(refined.medium, "medium");
	assert.equal(refined.high, "high");
	assert.equal(refined.max, "max");
});

test("resolveEffort：pi 给了档位就按修正表换算", () => {
	assert.equal(resolveEffort("none", "high"), "none");
	assert.equal(resolveEffort("low", "high"), "low");
	assert.equal(resolveEffort("medium", "high", { medium: "high" }), "high");
	assert.equal(resolveEffort("high", "high", { high: "high" }), "high");
});

test("resolveEffort：pi 没给档位时用模型官方默认档，而不是硬编码 high", () => {
	assert.equal(resolveEffort(undefined, "medium"), "medium");
	assert.equal(resolveEffort(undefined, undefined), "high");
});

test("formatEffortLevels 标出「一次都没思考」的档位", () => {
	const out = formatEffortLevels("glm-5.3", { low: 0, high: 0, max: 260 });
	assert.match(out, /glm-5\.3/);
	assert.match(out, /max: 260/);
	assert.match(out, /low, high/);
});
