// opengateway/pricing.ts — OpenGateway Ultrafast 的峰谷（分时）价目表与计价。
//
// OpenGateway 的 Ultrafast 模型按 KST（UTC+9）每周循环的时段计费：同一模型 ID
// 在不同时段给出不同的固定价，折扣随“工作日/夜间/周末”变化。pi 的成本模型只有
// 平价与“输入 token 阈值”档位（cost.tiers），没有时间维度，所以这里维护一份
// 时段表，并在 message_end 按消息自身的时间戳重算 usage.cost。
//
// 价目来源：https://opengateway.ai/api/model-prices
//   entries["sionic-ai/<modelName>"].pricing.timeline 给出按时段连续的报价，
//   其中 axisPrices / AxisKey(threshold=256000) 表示「总输入 token 超过 256K 时
//   整请求按高价档计费」。本文件把该阈值实现为 LONG_CONTEXT_FACTOR。
//
// 内置表（2026-11-05 抓取，KST 工作日窗口，未命中即低谷价）：
//
//   deepseek/deepseek-v4.1-flash-ultrafast   list $0.30 / $1.20 / $0.0060
//     10:00–13:00 高峰 0.21 / 0.84 / 0.0042   (−30%)
//     13:00–15:00 平峰 0.15 / 0.60 / 0.0030   (−50%)
//     15:00–19:00 高峰 0.21 / 0.84 / 0.0042   (−30%)
//     19:00–24:00 平峰 0.15 / 0.60 / 0.0030   (−50%)
//     其余（00:00–10:00 与周末）低谷 0.09 / 0.36 / 0.0018   (−70%)
//
//   z-ai/glm-5.3-flash-ultrafast            list $0.15 / $0.50 / $0.030
//     工作日 10:00–24:00 平峰 0.075 / 0.25 / 0.015   (−50%)
//     其余（00:00–10:00 与周末）低谷 0.015 / 0.05 / 0.003   (−90%)
//
// 这套时段是促销性质的、会变（例如假期整体下调）。所以线上抓到的 timeline 优先：
// 只要某条消息的时间戳落在已抓取的时段内，就用实价，内置表只作为离线/超期回退。

export interface Rates {
	/** USD per 1M tokens */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** 时段档位。`offpeak` 是兜底档，每个模型必须有。 */
export type TierId = "offpeak" | "standard" | "peak";

/** 工作日内的一个时段窗口（KST 分钟，半开区间）。 */
export interface Window {
	tier: TierId;
	start: number;
	end: number;
}

export interface ModelPrice {
	/** pi 模型 ID，同时也是 OpenGateway 的 `{owner}/{model}`。 */
	id: string;
	/** 状态行里用的短名。 */
	label: string;
	/** 挂牌价（USD/1M），用于算折扣，也是 pi 目录里的默认价。 */
	list: Rates;
	/** 各档位费率；未列出的档位回退到 `offpeak`。 */
	tiers: Partial<Record<TierId, Rates>> & { offpeak: Rates };
	/** KST 工作日窗口；周末与未命中的时刻都用 `offpeak`。 */
	windows: Window[];
}

/** 总输入 token（input + cacheRead + cacheWrite）超过该值时整请求按 ×2 计费。 */
export const LONG_CONTEXT_THRESHOLD = 256_000;
export const LONG_CONTEXT_FACTOR = 2;

const h = (hour: number) => hour * 60;

export const DEEPSEEK_ULTRAFAST: ModelPrice = {
	id: "deepseek/deepseek-v4.1-flash-ultrafast",
	label: "deepseek-flash-ultrafast",
	list: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	tiers: {
		offpeak: { input: 0.09, output: 0.36, cacheRead: 0.0018, cacheWrite: 0 },
		standard: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
		peak: { input: 0.21, output: 0.84, cacheRead: 0.0042, cacheWrite: 0 },
	},
	windows: [
		{ tier: "peak", start: h(10), end: h(13) },
		{ tier: "standard", start: h(13), end: h(15) },
		{ tier: "peak", start: h(15), end: h(19) },
		{ tier: "standard", start: h(19), end: h(24) },
	],
};

export const GLM_ULTRAFAST: ModelPrice = {
	id: "z-ai/glm-5.3-flash-ultrafast",
	label: "glm-5.3-flash-ultrafast",
	list: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
	tiers: {
		offpeak: { input: 0.015, output: 0.05, cacheRead: 0.003, cacheWrite: 0 },
		standard: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 },
	},
	windows: [{ tier: "standard", start: h(10), end: h(24) }],
};

/** 本扩展注册的全部模型（只有这两个，价目表即模型清单）。 */
export const OPENGATEWAY_MODELS: readonly ModelPrice[] = [DEEPSEEK_ULTRAFAST, GLM_ULTRAFAST];

export const TIER_LABELS: Record<TierId, string> = {
	offpeak: "低谷",
	standard: "平峰",
	peak: "高峰",
};

/** 已解析的线上时段：[start, end) 内的费率为 `rates`。 */
export interface LivePiece {
	start: number;
	end: number;
	rates: Rates;
}

const KST = new Intl.DateTimeFormat("en-US", {
	timeZone: "Asia/Seoul",
	weekday: "short",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** KST 星期（0 = 周日）与当日分钟数。 */
export function kstTime(date: Date): { weekday: number; minutes: number } {
	const parts = KST.formatToParts(date);
	const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
	const hour = Number(pick("hour"));
	const minute = Number(pick("minute"));
	return {
		weekday: WEEKDAY_INDEX[pick("weekday")] ?? 0,
		minutes: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
	};
}

export function weekdayLabel(weekday: number): string {
	return WEEKDAY_CN[weekday] ?? "";
}

export function formatMinutes(minutes: number): string {
	const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
	const minute = String(minutes % 60).padStart(2, "0");
	return `${hour}:${minute}`;
}

/** 按 KST 时间查内置表的档位；周末与未命中窗口一律低谷。 */
export function tierAt(model: ModelPrice, at: Date): TierId {
	const { weekday, minutes } = kstTime(at);
	// 0 = 周日，6 = 周六：OpenGateway 的促销窗口只落在工作日。
	if (weekday === 0 || weekday === 6) return "offpeak";
	const window = model.windows.find((item) => minutes >= item.start && minutes < item.end);
	return window?.tier ?? "offpeak";
}

export function ratesForTier(model: ModelPrice, tier: TierId): Rates {
	return model.tiers[tier] ?? model.tiers.offpeak;
}

/** 内置表的费率，附档位。 */
export function bakedRates(model: ModelPrice, at: Date): { tier: TierId; rates: Rates } {
	const tier = tierAt(model, at);
	return { tier, rates: ratesForTier(model, tier) };
}

/** 线上时段中命中 `at` 的费率；未覆盖返回 undefined。 */
export function liveRates(pieces: readonly LivePiece[] | undefined, at: Date): Rates | undefined {
	if (!pieces) return undefined;
	const t = at.getTime();
	return pieces.find((piece) => t >= piece.start && t < piece.end)?.rates;
}

/** 折扣百分比（相对挂牌价），用于状态行与命令输出。 */
export function discountPercent(model: ModelPrice, rates: Rates): number {
	if (model.list.input <= 0) return 0;
	return Math.round((1 - rates.input / model.list.input) * 100);
}

/** 总输入是否超过长上下文档位，超过则整请求 ×2。 */
export function longContextFactor(usage: { input?: number; cacheRead?: number; cacheWrite?: number }): number {
	const total = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	return total > LONG_CONTEXT_THRESHOLD ? LONG_CONTEXT_FACTOR : 1;
}

export function modelFor(modelId: unknown): ModelPrice | undefined {
	if (typeof modelId !== "string") return undefined;
	return OPENGATEWAY_MODELS.find((model) => model.id === modelId || modelId.endsWith(`/${model.id}`));
}

/** 下一次档位切换（内置表），最多向前看 8 天。 */
export function nextChange(model: ModelPrice, from: Date): { at: Date; tier: TierId } | undefined {
	const boundaries = new Set<number>([0]);
	for (const window of model.windows) {
		boundaries.add(window.start);
		boundaries.add(window.end % 1440);
	}
	const sorted = [...boundaries].sort((a, b) => a - b);
	const startTier = tierAt(model, from);
	const startMs = from.getTime();

	for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
		for (const minutes of sorted) {
			const candidate = nextOccurrence(from, dayOffset, minutes);
			if (candidate.getTime() <= startMs) continue;
			const tier = tierAt(model, candidate);
			if (tier !== startTier) return { at: candidate, tier };
		}
	}
	return undefined;
}

/** 以 `from` 的 KST 日期为基准，偏移 `dayOffset` 天、时分 `minutes` 的绝对时间。 */
function nextOccurrence(from: Date, dayOffset: number, minutes: number): Date {
	const { minutes: currentMinutes } = kstTime(from);
	const deltaMinutes = dayOffset * 1440 + minutes - currentMinutes;
	// 对齐到分钟起始，避免把秒/毫秒带进边界比较。
	return new Date(from.getTime() - (from.getTime() % 60_000) + deltaMinutes * 60_000);
}

/** 从 /api/model-prices 的响应里取出某个模型的连续时段。 */
export function livePiecesFromPayload(payload: unknown, model: ModelPrice): LivePiece[] | undefined {
	const entries = (payload as { entries?: Record<string, unknown> } | undefined)?.entries;
	if (!entries || typeof entries !== "object") return undefined;
	const owner = model.id.slice(0, model.id.indexOf("/"));
	const name = model.id.slice(model.id.indexOf("/") + 1);

	for (const [key, raw] of Object.entries(entries)) {
		const entry = raw as {
			modelOwner?: unknown;
			modelName?: unknown;
			pricing?: { timeline?: unknown; current?: { effectivePrice?: unknown } };
		};
		const entryOwner = typeof entry.modelOwner === "string" ? entry.modelOwner : key.split("/")[0];
		const entryName = typeof entry.modelName === "string" ? entry.modelName : key.split("/")[1];
		if (entryOwner !== owner || entryName !== name) continue;

		const timeline = Array.isArray(entry.pricing?.timeline) ? entry.pricing.timeline : [];
		const pieces: LivePiece[] = [];
		for (const raw of timeline) {
			const segment = raw as { at?: unknown; until?: unknown; effectivePrice?: unknown };
			const rates = ratesFromEffectivePrice(segment.effectivePrice);
			if (!rates) continue;
			const start = typeof segment.at === "string" ? Date.parse(segment.at) : Number.NEGATIVE_INFINITY;
			const end = typeof segment.until === "string" ? Date.parse(segment.until) : Number.POSITIVE_INFINITY;
			if (!Number.isFinite(start) && start !== Number.NEGATIVE_INFINITY) continue;
			if (!Number.isFinite(end) && end !== Number.POSITIVE_INFINITY) continue;
			if (end !== Number.POSITIVE_INFINITY && start !== Number.NEGATIVE_INFINITY && end <= start) continue;
			pieces.push({ start, end, rates });
		}
		if (pieces.length > 0) return pieces.sort((a, b) => a.start - b.start);

		// 没有 timeline 的模型只有当前价：当作全程有效，pi 侧仍以时间戳为准。
		const current = ratesFromEffectivePrice(entry.pricing?.current?.effectivePrice);
		if (current) return [{ start: Number.NEGATIVE_INFINITY, end: Number.POSITIVE_INFINITY, rates: current }];
	}
	return undefined;
}

function ratesFromEffectivePrice(value: unknown): Rates | undefined {
	const price = value as
		| {
			inputCostPerToken?: unknown;
			outputCostPerToken?: unknown;
			cacheReadInputTokenCost?: unknown;
			cacheCreationInputTokenCost?: unknown;
		}
		| undefined;
	if (!price || typeof price !== "object") return undefined;
	const perMillion = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) ? round(raw * 1e6) : undefined);
	const input = perMillion(price.inputCostPerToken);
	const output = perMillion(price.outputCostPerToken);
	if (input === undefined || output === undefined) return undefined;
	return {
		input,
		output,
		cacheRead: perMillion(price.cacheReadInputTokenCost) ?? 0,
		cacheWrite: perMillion(price.cacheCreationInputTokenCost) ?? 0,
	};
}

/** 抹掉浮点噪声（1.8e-9 * 1e6 = 0.0018）。 */
function round(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

function costOf(usage: UsageLike, rates: Rates, factor: number): NonNullable<UsageLike["cost"]> {
	const rate = {
		input: rates.input * factor,
		output: rates.output * factor,
		cacheRead: rates.cacheRead * factor,
		cacheWrite: rates.cacheWrite * factor,
	};
	const cost = {
		input: ((usage.input ?? 0) * rate.input) / 1e6,
		output: ((usage.output ?? 0) * rate.output) / 1e6,
		cacheRead: ((usage.cacheRead ?? 0) * rate.cacheRead) / 1e6,
		cacheWrite: ((usage.cacheWrite ?? 0) * rate.cacheWrite) / 1e6,
		total: 0,
	};
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	return cost;
}

export interface PricedMessageLike {
	role?: string;
	provider?: string;
	model?: string;
	responseModel?: string;
	timestamp?: number;
	usage?: UsageLike;
}

/**
 * 按消息时间戳重算 `usage.cost`。
 * 线上时段优先；否则用内置表（周末/夜间低谷）。
 */
export function reprice(message: unknown, live: ReadonlyMap<string, LivePiece[]>): unknown | undefined {
	const view = message as PricedMessageLike;
	if (view.role !== "assistant") return undefined;
	if (view.provider !== "opengateway") return undefined;
	const model = modelFor(view.responseModel ?? view.model);
	const usage = view.usage;
	if (!model || !usage) return undefined;

	const at =
		typeof view.timestamp === "number" && Number.isFinite(view.timestamp) ? new Date(view.timestamp) : new Date();
	const rates = liveRates(live.get(model.id), at) ?? bakedRates(model, at).rates;
	const cost = costOf(usage, rates, longContextFactor(usage));
	return { ...(message as Record<string, unknown>), usage: { ...usage, cost } };
}
