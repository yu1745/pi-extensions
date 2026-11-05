// opengateway/index.ts — OpenGateway 作为 pi 的 provider，含 Ultrafast 峰谷价。
//
// 只注册两个模型（其余模型不在此列出）：
//   deepseek/deepseek-v4.1-flash-ultrafast
//   z-ai/glm-5.3-flash-ultrafast
//
// 计价完全按 OpenGateway 的时段价目（见 pricing.ts）：pi 自己的 `cost` 只有平价与
// 输入阈值档，这里在 message_end 依据消息时间戳重算 `usage.cost`，所以 footer、
// /session、子代理成本统计都跟随峰谷价。
//
// 线上价优先：启动/切模型时（以及每 30 分钟）抓一次
// https://opengateway.ai/api/model-prices，命中时段就用实价；抓不到或时间超出
// 已公布时段时回退 pricing.ts 里的内置表（低谷兜底）。
//
// 命令：/opengateway-pricing — 当前档位、费率、折扣与下次切换时间。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	bakedRates,
	discountPercent,
	DEEPSEEK_ULTRAFAST,
	GLM_ULTRAFAST,
	formatMinutes,
	kstTime,
	livePiecesFromPayload,
	LONG_CONTEXT_FACTOR,
	LONG_CONTEXT_THRESHOLD,
	modelFor,
	nextChange,
	OPENGATEWAY_MODELS,
	ratesForTier,
	reprice,
	TIER_LABELS,
	weekdayLabel,
	type LivePiece,
	type ModelPrice,
	type TierId,
} from "./pricing.ts";

const PROVIDER_ID = "opengateway";
const BASE_URL = "https://apis.opengateway.ai/v1";
const PRICING_URL = "https://opengateway.ai/api/model-prices";
const STATUS_KEY = "opengateway-pricing";
const LIVE_TTL_MS = 30 * 60_000;
const LIVE_TIMEOUT_MS = 10_000;

/** 线上时段缓存，key 为模型 ID。 */
const live = new Map<string, LivePiece[]>();
let liveFetchedAt = 0;
let liveInFlight: Promise<void> | undefined;

type PlatformConfig = {
	name: string;
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap: Record<string, string | null>;
	compat: Record<string, boolean | string>;
	inputLimits?: {
		images: { resize: { maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number } };
	};
};

/** 平台差异（与 models.json 里原来的配置保持一致）。 */
const MODEL_CONFIG: Record<string, PlatformConfig> = {
	[DEEPSEEK_ULTRAFAST.id]: {
		name: "DeepSeek V4.1 Flash Ultrafast (OpenGateway)",
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		thinkingLevelMap: {
			off: "none",
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		},
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		},
	},
	[GLM_ULTRAFAST.id]: {
		name: "GLM-5.3-Flash-Ultrafast (OpenGateway)",
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		},
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			thinkingFormat: "zai",
			supportsStrictMode: true,
			zaiToolStream: true,
		},
		inputLimits: {
			images: {
				resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 },
			},
		},
	},
};

/** pi 的静态 `cost`：用注册时刻的档位，长上下文档摆成 ×2 阈值档。 */
function modelConfig(model: ModelPrice) {
	const { rates } = bakedRates(model, new Date());
	const platform = MODEL_CONFIG[model.id]!;
	return {
		id: model.id,
		type: "chat" as const,
		name: platform.name,
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: {
			input: rates.input,
			output: rates.output,
			cacheRead: rates.cacheRead,
			cacheWrite: rates.cacheWrite,
			tiers: [
				{
					inputTokensAbove: LONG_CONTEXT_THRESHOLD,
					input: rates.input * LONG_CONTEXT_FACTOR,
					output: rates.output * LONG_CONTEXT_FACTOR,
					cacheRead: rates.cacheRead * LONG_CONTEXT_FACTOR,
					cacheWrite: rates.cacheWrite * LONG_CONTEXT_FACTOR,
				},
			],
		},
		contextWindow: platform.contextWindow,
		maxTokens: platform.maxTokens,
		thinkingLevelMap: platform.thinkingLevelMap,
		compat: platform.compat,
		...(platform.inputLimits ? { inputLimits: platform.inputLimits } : {}),
	};
}

async function refreshLive(force = false): Promise<void> {
	if (!force && Date.now() - liveFetchedAt < LIVE_TTL_MS) return;
	if (liveInFlight) return liveInFlight;

	liveInFlight = (async () => {
		try {
			const response = await fetch(PRICING_URL, { signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
			if (!response.ok) return;
			const payload = await response.json();
			for (const model of OPENGATEWAY_MODELS) {
				const pieces = livePiecesFromPayload(payload, model);
				// 只在解析成功时覆盖，避免一次坏响应把实价清空。
				if (pieces) live.set(model.id, pieces);
			}
			liveFetchedAt = Date.now();
		} catch {
			// 网络失败 → 继续用内置表，不打扰用户。
		} finally {
			liveInFlight = undefined;
		}
	})();

	return liveInFlight;
}

/** 当前生效费率：线上命中优先，其次内置表。 */
function currentRates(model: ModelPrice, at: Date): { tier: TierId; rates: ModelPrice["list"]; livePrice: boolean } {
	const pieces = live.get(model.id);
	const t = at.getTime();
	const piece = pieces?.find((item) => t >= item.start && t < item.end);
	if (piece) {
		const tier = tierForRates(model, piece.rates);
		return { tier, rates: piece.rates, livePrice: true };
	}
	const baked = bakedRates(model, at);
	return { tier: baked.tier, rates: baked.rates, livePrice: false };
}

/** 把线上费率映射回档位名（用于状态行文案）。 */
function tierForRates(model: ModelPrice, rates: ModelPrice["list"]): TierId {
	const tiers: TierId[] = ["peak", "standard", "offpeak"];
	return tiers.find((tier) => Math.abs(ratesForTier(model, tier).input - rates.input) < 1e-9) ?? "offpeak";
}

function statusText(model: ModelPrice, at: Date): string {
	const { tier, rates, livePrice } = currentRates(model, at);
	const discount = discountPercent(model, rates);
	return (
		`${model.label} ${TIER_LABELS[tier]}` +
		` $${rates.input}/$${rates.output}/M` +
		(discount > 0 ? ` −${discount}%` : "") +
		(livePrice ? "" : " (内置价)")
	);
}

/**
 * pi 会在会话结束时让捕获的 ctx 失效（`pi -p` 退出、/new、切换会话、/reload），
 * 之后读 ctx.model / ctx.ui 会抛 “extension ctx is stale”。后台刷新是在
 * 分离的 task 里回写状态行，必须把这种错误当成“已经没人要画了”丢掉：
 * 逃逸的 rejection 会直接杀掉整个 pi 进程。
 */
function isStaleCtxError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /extension ctx is stale after session replacement or reload/i.test(message);
}

function updateStatus(ctx: ExtensionContext): void {
	try {
		const model = ctx.model?.provider === PROVIDER_ID ? modelFor(ctx.model.id) : undefined;
		if (!model) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, statusText(model, new Date()));
	} catch (error) {
		if (!isStaleCtxError(error)) throw error;
	}
}

/** 后台抓价后回写状态行；会话已销毁时静默跳过。 */
function refreshThenUpdate(ctx: ExtensionContext): void {
	void refreshLive()
		.then(() => updateStatus(ctx))
		.catch((error) => {
			if (!isStaleCtxError(error)) console.error(`[opengateway] status refresh failed: ${error}`);
		});
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		name: "OpenGateway",
		baseUrl: BASE_URL,
		apiKey: "$OPENGATEWAY_API_KEY",
		api: "openai-completions",
		models: OPENGATEWAY_MODELS.map(modelConfig),
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
		refreshThenUpdate(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
		refreshThenUpdate(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (event.message.provider !== PROVIDER_ID) return;

		updateStatus(ctx);
		refreshThenUpdate(ctx);

		const patched = reprice(event.message, live);
		if (!patched) return;
		return { message: patched as unknown as typeof event.message };
	});

	pi.registerCommand("opengateway-pricing", {
		description: "Show the OpenGateway Ultrafast tier, rates, discount and next switch (KST)",
		handler: async (_args, ctx) => {
			await refreshLive(true);
			const now = new Date();
			const current = ctx.model?.provider === PROVIDER_ID ? modelFor(ctx.model.id) : undefined;

			if (current) {
				const { tier, rates, livePrice } = currentRates(current, now);
				const change = nextChange(current, now);
				const changeText = change
					? `，${weekdayLabel(kstTime(change.at).weekday)} ${formatMinutes(kstTime(change.at).minutes)}（KST）起转${TIER_LABELS[change.tier]}`
					: "";
				ctx.ui.notify(
					`${current.label} 当前${TIER_LABELS[tier]}价：输入 $${rates.input} / 输出 $${rates.output} / ` +
						`缓存命中 $${rates.cacheRead} 每百万 token` +
						`（挂牌 $${current.list.input}/$${current.list.output}，−${discountPercent(current, rates)}%；` +
						`${livePrice ? "线上实时价" : "内置价表"}）${changeText}`,
					"info",
				);
				return;
			}

			const lines = OPENGATEWAY_MODELS.map((model) => {
				const { tier, rates } = currentRates(model, now);
				return `${model.label}：${TIER_LABELS[tier]} $${rates.input}/$${rates.output}（−${discountPercent(model, rates)}%）`;
			});
			ctx.ui.notify(
				`OpenGateway Ultrafast 当前价（KST 时段，>256K 输入整请求 ×${LONG_CONTEXT_FACTOR}）：\n${lines.join("\n")}`,
				"info",
			);
		},
	});
}
