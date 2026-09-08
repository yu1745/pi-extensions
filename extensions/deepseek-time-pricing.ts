// deepseek-time-pricing.ts — DeepSeek peak / off-peak (分时) pricing for pi.
//
// pi's model cost supports only flat rates or input-token thresholds
// (`cost.tiers[].inputTokensAbove`); it has no notion of time of day. This
// extension recomputes `usage.cost` for each assistant message at `message_end`
// from the message's own timestamp, so the footer, `/session`, and RPC cost
// totals follow DeepSeek's peak / off-peak prices.
//
// Beijing time (Asia/Shanghai):
//   peak      Mon–Fri 09:00–12:00 and 14:00–18:00
//   off-peak  everything else (half the peak price)
//
// Prices: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// Source unit is CNY per 1M tokens; pi stores USD, converted via USD_PER_CNY.
// The default (1/7) matches cny-footer's RATE=7, so its ¥ footer shows the
// official CNY price exactly. Override with DEEPSEEK_USD_PER_CNY.
//
// Command: /deepseek-pricing — current tier, rates, and next switch time.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface Rates {
	/** CNY per 1M tokens */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface PricingRule {
	label: string;
	/** Tested against `message.responseModel ?? message.model` */
	match: RegExp;
	peak: Rates;
	offPeak: Rates;
}

interface UsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: UsageCost;
}

interface PricedMessageLike {
	role?: string;
	provider?: string;
	model?: string;
	responseModel?: string;
	timestamp?: number;
	usage?: UsageLike;
}

/** Only messages from these providers are repriced. */
const PROVIDERS = ["deepseek"];

const USD_PER_CNY = (() => {
	const parsed = Number(process.env.DEEPSEEK_USD_PER_CNY);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1 / 7;
})();

const PRICING: PricingRule[] = [
	{
		// deepseek-v4-flash, deepseek-v4-flash-vision-exp,
		// deepseek-v4.1-flash-expires-on-0910, …
		label: "deepseek-v4-flash",
		match: /^deepseek-v4(?:\.\d+)?-flash/i,
		peak: { input: 3, output: 9, cacheRead: 0.1, cacheWrite: 0 },
		offPeak: { input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 0 },
	},
	{
		label: "deepseek-v4-pro",
		match: /^deepseek-v4(?:\.\d+)?-pro/i,
		peak: { input: 9, output: 27, cacheRead: 0.3, cacheWrite: 0 },
		offPeak: { input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 0 },
	},
];

/** Peak windows as minutes since midnight (half-open). */
const PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
	[9 * 60, 12 * 60],
	[14 * 60, 18 * 60],
];

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_CN: Record<string, string> = {
	Sun: "周日",
	Mon: "周一",
	Tue: "周二",
	Wed: "周三",
	Thu: "周四",
	Fri: "周五",
	Sat: "周六",
};

const BEIJING = new Intl.DateTimeFormat("en-US", {
	timeZone: "Asia/Shanghai",
	weekday: "short",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

function beijingTime(date: Date): { weekday: string; minutes: number } {
	const parts = BEIJING.formatToParts(date);
	const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
	const hour = Number(pick("hour"));
	const minute = Number(pick("minute"));
	return {
		weekday: pick("weekday"),
		minutes: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
	};
}

export function isPeakAt(date: Date): boolean {
	const { weekday, minutes } = beijingTime(date);
	if (!WEEKDAYS.has(weekday)) return false;
	return PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end);
}

/** Next rate switch after `from`, in Beijing time. */
export function nextChange(from: Date): { weekday: string; minutes: number } | undefined {
	const { weekday, minutes } = beijingTime(from);
	const dayIndex = DAY_NAMES.indexOf(weekday);
	if (WEEKDAYS.has(weekday)) {
		const boundaries = PEAK_WINDOWS.flatMap(([start, end]) => [start, end]).sort((a, b) => a - b);
		const next = boundaries.find((boundary) => boundary > minutes);
		if (next !== undefined) return { weekday, minutes: next };
	}
	for (let offset = 1; offset <= 7; offset += 1) {
		const name = DAY_NAMES[(dayIndex + offset) % 7];
		if (WEEKDAYS.has(name)) return { weekday: name, minutes: PEAK_WINDOWS[0][0] };
	}
	return undefined;
}

function formatMinutes(minutes: number): string {
	const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
	const minute = String(minutes % 60).padStart(2, "0");
	return `${hour}:${minute}`;
}

function findRule(provider: unknown, modelId: unknown): PricingRule | undefined {
	if (typeof provider !== "string" || !PROVIDERS.includes(provider)) return undefined;
	if (typeof modelId !== "string") return undefined;
	return PRICING.find((rule) => rule.match.test(modelId));
}

/** Reprice an assistant message with the tier in effect at its timestamp. */
function withTimeBasedCost(message: unknown): Record<string, unknown> | undefined {
	const view = message as PricedMessageLike;
	const rule = findRule(view.provider, view.responseModel ?? view.model);
	const usage = view.usage;
	if (!rule || !usage) return undefined;

	const at =
		typeof view.timestamp === "number" && Number.isFinite(view.timestamp)
			? new Date(view.timestamp)
			: new Date();
	const cny = isPeakAt(at) ? rule.peak : rule.offPeak;

	// pi stores cost in USD per 1M tokens.
	const rate = {
		input: cny.input * USD_PER_CNY,
		output: cny.output * USD_PER_CNY,
		cacheRead: cny.cacheRead * USD_PER_CNY,
		cacheWrite: cny.cacheWrite * USD_PER_CNY,
	};

	const cost = {
		input: ((usage.input ?? 0) * rate.input) / 1e6,
		output: ((usage.output ?? 0) * rate.output) / 1e6,
		cacheRead: ((usage.cacheRead ?? 0) * rate.cacheRead) / 1e6,
		cacheWrite: ((usage.cacheWrite ?? 0) * rate.cacheWrite) / 1e6,
		total: 0,
	};
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;

	return { ...(message as Record<string, unknown>), usage: { ...usage, cost } };
}

const STATUS_KEY = "deepseek-pricing";

function statusText(rule: PricingRule, peak: boolean): string {
	const rates = peak ? rule.peak : rule.offPeak;
	return `deepseek ${peak ? "高峰" : "空闲"} ${rates.input}/${rates.output} 元/M`;
}

function updateStatus(ctx: ExtensionContext): void {
	const rule = findRule(ctx.model?.provider, ctx.model?.id);
	if (!rule) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, statusText(rule, isPeakAt(new Date())));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;

		updateStatus(ctx);

		const patched = withTimeBasedCost(message);
		if (!patched) return;
		return { message: patched as unknown as typeof message };
	});

	pi.registerCommand("deepseek-pricing", {
		description: "Show DeepSeek peak/off-peak tier, rates, and next switch time",
		handler: async (_args, ctx) => {
			const now = new Date();
			const peak = isPeakAt(now);
			const rule = findRule(ctx.model?.provider, ctx.model?.id);
			const change = nextChange(now);
			const changeText = change
				? `，${WEEKDAY_CN[change.weekday] ?? change.weekday} ${formatMinutes(change.minutes)}（北京时间）起切换`
				: "";

			if (!rule) {
				ctx.ui.notify(
					`当前模型没有 DeepSeek 分时定价规则。受管模型：${PRICING.map((item) => item.label).join("、")}`,
					"info",
				);
				return;
			}

			const rates = peak ? rule.peak : rule.offPeak;
			ctx.ui.notify(
				`${rule.label} 当前${peak ? "高峰" : "空闲"}价：输入 ${rates.input} / 输出 ${rates.output} / ` +
					`缓存命中 ${rates.cacheRead} 元每百万 token${changeText}`,
				"info",
			);
		},
	});
}
