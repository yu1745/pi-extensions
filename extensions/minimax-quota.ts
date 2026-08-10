// minimax-quota.ts — MiniMax Coding Plan quota monitor for the pi footer.
//
// Only activates for `minimax-cn`.
// Endpoint:
//   GET https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains
//   Authorization: Bearer <MiniMax Coding Plan API key>
//
// The endpoint returns remaining percentages for the current interval and the
// weekly window. The `*_usage_count` fields are misleadingly named by the API;
// the `*_remaining_percent` fields are used directly.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TARGET_PROVIDER = "minimax-cn";
const QUOTA_URL = "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains";
const REQUEST_TIMEOUT_MS = 5000;
const STATUS_KEY = "minimax-quota";

const REFRESH_BANDS = [
	{ minLeft: 70, ttlMs: 300_000 }, // ≥70% → 5 min
	{ minLeft: 30, ttlMs: 120_000 }, // 30–69% → 2 min
	{ minLeft: 0, ttlMs: 60_000 }, // <30% → 1 min
] as const;
const ERROR_RETRY_TTL_MS = 120_000;
const RATE_LIMIT_RETRY_TTL_MS = 180_000;

const LOW_THRESHOLD = 30;
const MID_THRESHOLD = 60;
const PACE_WARN_THRESHOLD = 1.1;
const PACE_DANGER_THRESHOLD = 1.3;

interface WindowInfo {
	leftPercent: number;
	usedPercent: number;
	startAt?: number;
	endAt?: number;
}

interface QuotaState {
	kind: "success";
	interval: WindowInfo;
	weekly?: WindowInfo;
	modelName?: string;
	fetchedAt: number;
}

interface FailureState {
	kind: "auth_error" | "rate_limited" | "unavailable";
	at: number;
}

type CacheEntry =
	| { result: QuotaState; lastAttemptAt: number }
	| { result: FailureState; lastAttemptAt: number };

const cache = new Map<string, CacheEntry>();
let activeFetch: Promise<void> | null = null;

function asNumber(value: unknown): number | null {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) ? n : null;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

function shortHash(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
	return (hash >>> 0).toString(16);
}

function parseWindow(item: any, prefix: "interval" | "weekly"): WindowInfo | null {
	const remainingKey = prefix === "interval"
		? "current_interval_remaining_percent"
		: "current_weekly_remaining_percent";
	const left = asNumber(item?.[remainingKey]);
	if (left === null) return null;
	const leftPercent = clampPercent(left);
	const start = asNumber(prefix === "interval" ? item?.start_time : item?.weekly_start_time) ?? undefined;
	const end = asNumber(prefix === "interval" ? item?.end_time : item?.weekly_end_time) ?? undefined;
	return {
		leftPercent,
		usedPercent: 100 - leftPercent,
		...(start !== undefined ? { startAt: start } : {}),
		...(end !== undefined ? { endAt: end } : {}),
	};
}

function parseQuota(body: any): QuotaState | { kind: "auth_error" | "rate_limited" | "unavailable" } {
	if (!body || typeof body !== "object") return { kind: "unavailable" };
	const code = asNumber(body.base_resp?.status_code);
	const msg = typeof body.base_resp?.status_msg === "string" ? body.base_resp.status_msg : "";
	if (code === 1004 || /auth|login|cookie|token|key/i.test(msg)) return { kind: "auth_error" };
	if (code === 429 || /rate|too frequent|频繁|限流/i.test(msg)) return { kind: "rate_limited" };

	const remains: any[] = Array.isArray(body.model_remains) ? body.model_remains : [];
	if (remains.length === 0) return { kind: "unavailable" };
	// `general` is the coding-plan text quota. Fall back for accounts where the
	// API only returns a model-specific row.
	const item = remains.find((r) => r?.model_name === "general") ?? remains[0];
	const interval = parseWindow(item, "interval");
	const weeklyStatus = asNumber(item?.current_weekly_status);
	const weeklyTotal = asNumber(item?.current_weekly_total_count);
	// MiniMax returns 100% for accounts without a weekly limit. Status 3 and
	// total_count === 0 mean the weekly window is inactive, not full.
	const hasWeeklyLimit = weeklyStatus !== 3 && weeklyTotal !== 0;
	const weekly = hasWeeklyLimit ? parseWindow(item, "weekly") : null;
	if (!interval || (hasWeeklyLimit && !weekly)) return { kind: "unavailable" };
	return {
		kind: "success",
		interval,
		...(weekly ? { weekly } : {}),
		...(typeof item?.model_name === "string" ? { modelName: item.model_name } : {}),
		fetchedAt: Date.now(),
	};
}

async function fetchQuota(apiKey: string): Promise<QuotaState | { kind: "auth_error" | "rate_limited" | "unavailable" }> {
	try {
		const response = await fetch(QUOTA_URL, {
			method: "GET",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const text = await response.text();
		let body: any = null;
		try { body = JSON.parse(text); } catch {}
		if (response.status === 401 || response.status === 403) return { kind: "auth_error" };
		if (response.status === 429) return { kind: "rate_limited" };
		return parseQuota(body);
	} catch {
		return { kind: "unavailable" };
	}
}

function colorFor(left: number): "success" | "warning" | "error" {
	if (left < LOW_THRESHOLD) return "error";
	if (left < MID_THRESHOLD) return "warning";
	return "success";
}

interface PaceInfo { value: number; severity: "good" | "warn" | "danger"; }

function paceFor(window: WindowInfo): PaceInfo | null {
	if (!window.startAt || !window.endAt || window.endAt <= window.startAt) return null;
	const now = Date.now();
	const elapsed = now - window.startAt;
	const duration = window.endAt - window.startAt;
	const theoreticalUsed = (elapsed / duration) * 100;
	if (theoreticalUsed <= 0 || theoreticalUsed >= 100) return null;
	const value = window.usedPercent / theoreticalUsed;
	const severity = value > PACE_DANGER_THRESHOLD ? "danger"
		: value > PACE_WARN_THRESHOLD ? "warn" : "good";
	return { value, severity };
}

function paceColor(severity: PaceInfo["severity"]): "success" | "warning" | "error" {
	if (severity === "danger") return "error";
	if (severity === "warn") return "warning";
	return "success";
}

function formatRemaining(endAt?: number): string {
	if (!endAt) return "";
	const mins = Math.ceil((endAt - Date.now()) / 60_000);
	if (mins <= 0) return "";
	if (mins >= 24 * 60) {
		const days = Math.floor(mins / (24 * 60));
		const hours = Math.floor((mins % (24 * 60)) / 60);
		return `${days}d${hours}h`;
	}
	if (mins >= 60) return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
	return `${mins}m`;
}

function renderWindow(label: string, window: WindowInfo, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const quotaColor = colorFor(window.leftPercent);
	const filled = Math.round(window.leftPercent / 10);
	const bar = "█".repeat(filled) + "░".repeat(10 - filled);
	const base = t.fg(quotaColor, `${label} ${bar} ${window.leftPercent}%`);
	const pace = paceFor(window);
	const pacePart = pace ? t.fg(paceColor(pace.severity), ` ${pace.value.toFixed(1)}×`) : "";
	const reset = formatRemaining(window.endAt);
	const resetPart = reset ? t.fg("dim", ` ${reset}`) : "";
	return base + pacePart + resetPart;
}

function renderStatus(state: QuotaState, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	return [
		t.fg("dim", "MiniMax"),
		renderWindow("5h", state.interval, ctx),
		...(state.weekly ? [renderWindow("week", state.weekly, ctx)] : []),
	].join(t.fg("dim", " | "));
}

function renderFailure(state: FailureState, ctx: ExtensionContext): string {
	const label = state.kind === "auth_error" ? "auth error"
		: state.kind === "rate_limited" ? "quota limited" : "quota unavailable";
	return ctx.ui.theme.fg("dim", `MiniMax ${label}`);
}

function ttlFor(state: QuotaState): number {
	return REFRESH_BANDS.find((b) => state.interval.leftPercent >= b.minLeft)?.ttlMs ?? 60_000;
}

async function refresh(ctx: ExtensionContext, apiKey: string, key: string, force = false): Promise<void> {
	const now = Date.now();
	const entry = cache.get(key);
	if (!force && entry) {
		const ttl = entry.result.kind === "success" ? ttlFor(entry.result)
			: entry.result.kind === "rate_limited" ? RATE_LIMIT_RETRY_TTL_MS : ERROR_RETRY_TTL_MS;
		if (now - entry.lastAttemptAt < ttl) {
			ctx.ui.setStatus(STATUS_KEY, entry.result.kind === "success"
				? renderStatus(entry.result, ctx) : renderFailure(entry.result, ctx));
			return;
		}
	}
	const result = await fetchQuota(apiKey);
	if (result.kind === "success") {
		cache.set(key, { result, lastAttemptAt: now });
		ctx.ui.setStatus(STATUS_KEY, renderStatus(result, ctx));
	} else {
		const failure: FailureState = { kind: result.kind, at: now };
		cache.set(key, { result: failure, lastAttemptAt: now });
		ctx.ui.setStatus(STATUS_KEY, renderFailure(failure, ctx));
	}
}

async function scheduleRefresh(ctx: ExtensionContext, apiKey: string, key: string, force = false): Promise<void> {
	if (activeFetch) return activeFetch;
	activeFetch = (async () => {
		try { await refresh(ctx, apiKey, key, force); }
		finally { activeFetch = null; }
	})();
	return activeFetch;
}

async function syncActivation(ctx: ExtensionContext): Promise<void> {
	const provider = ctx.model?.provider;
	if (provider !== TARGET_PROVIDER) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
	if (!apiKey) {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "MiniMax no api key"));
		return;
	}
	await scheduleRefresh(ctx, apiKey, shortHash(apiKey));
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => { await syncActivation(ctx); });
	pi.on("model_select", async (_event, ctx) => { await syncActivation(ctx); });

	pi.on("tool_result", async (_event, ctx) => {
		if (ctx.model?.provider !== TARGET_PROVIDER) return;
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(TARGET_PROVIDER);
		if (!apiKey) return;
		await scheduleRefresh(ctx, apiKey, shortHash(apiKey));
	});

	pi.registerCommand("minimax-quota", {
		description: "Force-refresh MiniMax Coding Plan quota in the footer",
		handler: async (_args, ctx) => {
			if (ctx.model?.provider !== TARGET_PROVIDER) {
				ctx.ui.notify("MiniMax quota is only available for the minimax-cn provider", "warning");
				return;
			}
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(TARGET_PROVIDER);
			if (!apiKey) {
				ctx.ui.notify("No API key configured for minimax-cn", "warning");
				return;
			}
			const key = shortHash(apiKey);
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "MiniMax refreshing…"));
			await refresh(ctx, apiKey, key, true);
			ctx.ui.notify("MiniMax quota refreshed", "info");
		},
	});
}
