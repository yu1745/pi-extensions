import assert from "node:assert/strict";
import test from "node:test";
import {
	bakedRates,
	DEEPSEEK_ULTRAFAST,
	discountPercent,
	GLM_ULTRAFAST,
	livePiecesFromPayload,
	liveRates,
	longContextFactor,
	nextChange,
	OPENGATEWAY_MODELS,
	reprice,
	tierAt,
} from "../extensions/opengateway/pricing.ts";

// 时间换算：KST = UTC+9。2026-11-06 是周五。
// 09:59 KST = 00:59Z，10:00 KST = 01:00Z，13:00 KST = 04:00Z，
// 15:00 KST = 06:00Z，19:00 KST = 10:00Z，24:00 KST = 15:00Z。
const at = (iso: string) => new Date(iso);
const DAY = 1_000_000; // 一个完整 1M 单位

// 总输入 250K，未触发 >256K 长上下文档位，便于按费率直接断言。
const usage = { input: 200_000, output: 500_000, cacheRead: 50_000, cacheWrite: 0 };

/** 期望成本：费率（USD/1M）× token 数。 */
const c = (ratePerMillion: number, tokens: number) => (ratePerMillion * tokens) / 1e6;
const close = (actual: number, expected: number) =>
	assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} !== ${expected}`);

function message(model: string, timestamp: string) {
	return { role: "assistant", provider: "opengateway", model, timestamp: at(timestamp).getTime(), usage: { ...usage } };
}

test("工作日档位按 KST 窗口切换（deepseek）", () => {
	// 周五各时段
	assert.equal(tierAt(DEEPSEEK_ULTRAFAST, at("2026-11-06T00:59:00Z")), "offpeak"); // 09:59
	assert.equal(tierAt(DEEPSEEK_ULTRAFAST, at("2026-11-06T01:00:00Z")), "peak"); // 10:00
	assert.equal(tierAt(DEEPSEEK_ULTRAFAST, at("2026-11-06T04:00:00Z")), "standard"); // 13:00
	assert.equal(tierAt(DEEPSEEK_ULTRAFAST, at("2026-11-06T06:00:00Z")), "peak"); // 15:00
	assert.equal(tierAt(DEEPSEEK_ULTRAFAST, at("2026-11-06T10:00:00Z")), "standard"); // 19:00
	assert.equal(tierAt(DEEPSEEK_ULTRAFAST, at("2026-11-06T15:00:00Z")), "offpeak"); // 次日 00:00
});

test("周末整段低谷", () => {
	// 2026-11-07 周六 15:00 KST、2026-11-08 周日 15:00 KST
	assert.equal(tierAt(DEEPSEEK_ULTRAFAST, at("2026-11-07T06:00:00Z")), "offpeak");
	assert.equal(tierAt(DEEPSEEK_ULTRAFAST, at("2026-11-08T06:00:00Z")), "offpeak");
	assert.equal(tierAt(GLM_ULTRAFAST, at("2026-11-07T06:00:00Z")), "offpeak");
});

test("GLM 只有工作日白天平峰 + 其余低谷", () => {
	assert.equal(tierAt(GLM_ULTRAFAST, at("2026-11-06T00:59:00Z")), "offpeak"); // 09:59
	assert.equal(tierAt(GLM_ULTRAFAST, at("2026-11-06T01:00:00Z")), "standard"); // 10:00
	assert.equal(tierAt(GLM_ULTRAFAST, at("2026-11-06T14:59:00Z")), "standard"); // 23:59
	assert.equal(tierAt(GLM_ULTRAFAST, at("2026-11-06T15:00:00Z")), "offpeak"); // 24:00
});

test("内置费率与挂牌价折扣", () => {
	const peak = bakedRates(DEEPSEEK_ULTRAFAST, at("2026-11-06T02:00:00Z"));
	assert.deepEqual(peak.rates, { input: 0.21, output: 0.84, cacheRead: 0.0042, cacheWrite: 0 });
	assert.equal(discountPercent(DEEPSEEK_ULTRAFAST, peak.rates), 30);

	const standard = bakedRates(DEEPSEEK_ULTRAFAST, at("2026-11-06T05:00:00Z"));
	assert.deepEqual(standard.rates, { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 });
	assert.equal(discountPercent(DEEPSEEK_ULTRAFAST, standard.rates), 50);

	const offpeak = bakedRates(DEEPSEEK_ULTRAFAST, at("2026-11-06T16:00:00Z"));
	assert.deepEqual(offpeak.rates, { input: 0.09, output: 0.36, cacheRead: 0.0018, cacheWrite: 0 });
	assert.equal(discountPercent(DEEPSEEK_ULTRAFAST, offpeak.rates), 70);

	const glm = bakedRates(GLM_ULTRAFAST, at("2026-11-06T16:00:00Z"));
	assert.deepEqual(glm.rates, { input: 0.015, output: 0.05, cacheRead: 0.003, cacheWrite: 0 });
	assert.equal(discountPercent(GLM_ULTRAFAST, glm.rates), 90);
});

test("message_end 按消息时间戳改价（provider 与模型都受管）", () => {
	const peak = reprice(message(DEEPSEEK_ULTRAFAST.id, "2026-11-06T02:00:00Z"), new Map()) as any;
	assert.ok(peak, "受管模型必须被重算");
	close(peak.usage.cost.input, c(0.21, 200_000));
	close(peak.usage.cost.output, c(0.84, 500_000));
	close(peak.usage.cost.cacheRead, c(0.0042, 50_000));
	close(peak.usage.cost.total, c(0.21, 200_000) + c(0.84, 500_000) + c(0.0042, 50_000));

	const offpeak = reprice(message(DEEPSEEK_ULTRAFAST.id, "2026-11-07T02:00:00Z"), new Map()) as any;
	close(offpeak.usage.cost.input, c(0.09, 200_000)); // 周六低谷
});

test("未受管 provider / 非 assistant 消息不动", () => {
	assert.equal(reprice({ ...message(DEEPSEEK_ULTRAFAST.id, "2026-11-06T02:00:00Z"), provider: "deepseek" }, new Map()), undefined);
	assert.equal(reprice({ ...message(DEEPSEEK_ULTRAFAST.id, "2026-11-06T02:00:00Z"), role: "user" }, new Map()), undefined);
	assert.equal(reprice(message("openai/gpt-4o", "2026-11-06T02:00:00Z"), new Map()), undefined);
});

test("总输入 >256K 时整请求 ×2", () => {
	assert.equal(longContextFactor({ input: 256_000 }), 1);
	assert.equal(longContextFactor({ input: 256_001 }), 2);
	assert.equal(longContextFactor({ input: 200_000, cacheRead: 60_000 }), 2);

	const patched = reprice(
		{
			role: "assistant",
			provider: "opengateway",
			model: DEEPSEEK_ULTRAFAST.id,
			timestamp: at("2026-11-07T02:00:00Z").getTime(),
			usage: { input: 300_000, output: DAY, cacheRead: DAY, cacheWrite: 0 },
		},
		new Map(),
	) as any;
	// 低谷 0.09/0.36/0.0018，全部翻倍
	assert.equal(patched.usage.cost.input, 0.09 * 2 * 0.3);
	assert.equal(patched.usage.cost.output, 0.36 * 2);
	assert.equal(patched.usage.cost.cacheRead, 0.0018 * 2);
});

/** 抓自 https://opengateway.ai/api/model-prices (2026-11-05)，只保留两个受管模型。 */
const LIVE_PAYLOAD = {
	entries: {
		"sionic-ai/deepseek-v4.1-flash-ultrafast": {
			provider: "sionic-ai",
			modelOwner: "deepseek",
			modelName: "deepseek-v4.1-flash-ultrafast",
			pricing: {
				current: {
					effectivePrice: {
						inputCostPerToken: 9e-8,
						outputCostPerToken: 3.6e-7,
						cacheReadInputTokenCost: 1.8e-9,
					},
				},
				timeline: [
					{
						until: "2026-11-06T01:00:00Z",
						effectivePrice: {
							inputCostPerToken: 9e-8,
							outputCostPerToken: 3.6e-7,
							cacheReadInputTokenCost: 1.8e-9,
						},
					},
					{
						at: "2026-11-06T01:00:00Z",
						until: "2026-11-06T04:00:00Z",
						effectivePrice: {
							inputCostPerToken: 2.1e-7,
							outputCostPerToken: 8.4e-7,
							cacheReadInputTokenCost: 4.2e-9,
						},
					},
					{
						at: "2026-11-06T04:00:00Z",
						until: "2026-11-06T15:00:00Z",
						effectivePrice: {
							inputCostPerToken: 1.5e-7,
							outputCostPerToken: 6e-7,
							cacheReadInputTokenCost: 3e-9,
						},
					},
				],
			},
		},
		"sionic-ai/glm-5.3-flash-ultrafast": {
			provider: "sionic-ai",
			modelOwner: "z-ai",
			modelName: "glm-5.3-flash-ultrafast",
			pricing: {
				current: {},
				timeline: [
					{
						at: "2026-11-06T01:00:00Z",
						until: "2026-11-06T15:00:00Z",
						effectivePrice: {
							inputCostPerToken: 7.5e-8,
							outputCostPerToken: 2.5e-7,
							cacheReadInputTokenCost: 1.5e-8,
						},
					},
				],
			},
		},
	},
};

test("线上时段解析：USD/1M、开区间、按模型隔离", () => {
	const deepseek = livePiecesFromPayload(LIVE_PAYLOAD, DEEPSEEK_ULTRAFAST)!;
	assert.equal(deepseek.length, 3);
	assert.deepEqual(deepseek[0].rates, { input: 0.09, output: 0.36, cacheRead: 0.0018, cacheWrite: 0 });
	assert.deepEqual(deepseek[1].rates, { input: 0.21, output: 0.84, cacheRead: 0.0042, cacheWrite: 0 });

	// 区间左闭右开
	assert.equal(liveRates(deepseek, at("2026-11-06T00:59:59Z"))?.input, 0.09);
	assert.equal(liveRates(deepseek, at("2026-11-06T01:00:00Z"))?.input, 0.21);
	assert.equal(liveRates(deepseek, at("2026-11-06T04:00:00Z"))?.input, 0.15);
	assert.equal(liveRates(deepseek, at("2026-11-06T15:00:00Z")), undefined); // 已超出公布时段

	const glm = livePiecesFromPayload(LIVE_PAYLOAD, GLM_ULTRAFAST)!;
	assert.equal(glm.length, 1);
	assert.deepEqual(glm[0].rates, { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 });

	assert.equal(livePiecesFromPayload({}, DEEPSEEK_ULTRAFAST), undefined);
	assert.equal(livePiecesFromPayload(null, DEEPSEEK_ULTRAFAST), undefined);
});

test("线上价优先于内置表；超出时段回退内置表", () => {
	const live = new Map([
		[DEEPSEEK_ULTRAFAST.id, livePiecesFromPayload(LIVE_PAYLOAD, DEEPSEEK_ULTRAFAST)!],
	]);
	// 10:30 KST 线上 0.21，内置同为 peak 0.21
	const inRange = reprice(message(DEEPSEEK_ULTRAFAST.id, "2026-11-06T01:30:00Z"), live) as any;
	close(inRange.usage.cost.input, c(0.21, 200_000));

	// 周六 10:00 KST 已超出本批公布时段 → 内置低谷 0.09
	const beyond = reprice(message(DEEPSEEK_ULTRAFAST.id, "2026-11-07T01:00:00Z"), live) as any;
	close(beyond.usage.cost.input, c(0.09, 200_000));
});

test("nextChange 指向下一个真正换档的时刻（含跨周末）", () => {
	// 周五 09:59 KST → 10:00 转 peak
	const a = nextChange(DEEPSEEK_ULTRAFAST, at("2026-11-06T00:59:00Z"))!;
	assert.equal(a.at.toISOString(), "2026-11-06T01:00:00.000Z");
	assert.equal(a.tier, "peak");

	// 周五 23:59 KST → 周六 00:00 转 offpeak
	const b = nextChange(DEEPSEEK_ULTRAFAST, at("2026-11-06T14:59:00Z"))!;
	assert.equal(b.tier, "offpeak");
	assert.equal(b.at.toISOString(), "2026-11-06T15:00:00.000Z");

	// 周六 12:00 KST → 周一 10:00 peak（周日/周一凌晨都是低谷）
	const c = nextChange(DEEPSEEK_ULTRAFAST, at("2026-11-07T03:00:00Z"))!;
	assert.equal(c.tier, "peak");
	assert.equal(c.at.toISOString(), "2026-11-09T01:00:00.000Z");

	// 低谷期间 nextChange 不应返回同一档位
	const d = nextChange(GLM_ULTRAFAST, at("2026-11-06T16:00:00Z"))!;
	assert.equal(d.tier, "standard");
	assert.equal(d.at.toISOString(), "2026-11-09T01:00:00.000Z");
});

test("模型清单只有受管的两个", () => {
	assert.deepEqual(
		OPENGATEWAY_MODELS.map((model) => model.id),
		["deepseek/deepseek-v4.1-flash-ultrafast", "z-ai/glm-5.3-flash-ultrafast"],
	);
});

test("session 结束后（ctx 失效）后台刷新不抛错、不杀进程", async () => {
	const { default: extension } = await import("../extensions/opengateway/index.ts");
	const handlers = new Map<string, Function>();
	extension({
		registerProvider: () => {},
		registerCommand: () => {},
		on: (name: string, handler: Function) => handlers.set(name, handler),
	} as any);

	const STALE =
		"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";
	const disposed = {
		get model(): never {
			throw new Error(STALE);
		},
		get ui(): never {
			throw new Error(STALE);
		},
	};

	// 内置表路径不应依赖网络：这里只验证 ctx 读取失败被吞掉。
	await assert.doesNotReject(
		handlers.get("message_end")!(
			{
				type: "message_end",
				message: {
					role: "assistant",
					provider: "opengateway",
					model: "deepseek/deepseek-v4.1-flash-ultrafast",
					timestamp: Date.parse("2026-11-07T02:00:00Z"),
					usage: { input: 200_000, output: 500_000, cacheRead: 50_000, cacheWrite: 0 },
				},
			},
			disposed,
		),
	);
});
