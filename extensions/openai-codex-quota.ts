// openai-codex-quota.ts — OpenAI Codex subscription quota monitor for pi footer.
//
// Only activates for the `openai-codex` provider. The endpoint and response
// shape follow the Codex CLI backend client:
//   GET https://chatgpt.com/backend-api/wham/usage
//   Authorization: Bearer <OAuth access token>
//   ChatGPT-Account-Id: <account id>
//   User-Agent: codex-cli
//
// Response fields used:
//   rate_limit.primary_window / secondary_window
//   { used_percent, reset_at, limit_window_seconds }

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TARGET_PROVIDER = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 5000;
const STATUS_KEY = "openai-codex-quota";

const REFRESH_TTL_MS = 5 * 60_000;
const RATE_LIMIT_RETRY_TTL_MS = 3 * 60_000;
const ERROR_RETRY_TTL_MS = 2 * 60_000;

const LOW_THRESHOLD = 30;
const MID_THRESHOLD = 60;
const PACE_WARN_THRESHOLD = 1.1;
const PACE_DANGER_THRESHOLD = 1.3;

interface WindowInfo {
	leftPercent: number;
	usedPercent: number;
	resetAt?: number;
	windowSeconds?: number;
}

interface QuotaState {
	kind: "success";
	primary: WindowInfo;
	secondary?: WindowInfo;
	planType?: string;
	allowed?: boolean;
	limitReached?: boolean;
	fetchedAt: number;
}

interface FailureState {
	kind: "rate_limited" | "auth_error" | "unavailable";
	at: number;
}

type CacheEntry =
	| { result: QuotaState; lastAttemptAt: number }
	| { result: FailureState; lastAttemptAt: number };

const cache = new Map<string, CacheEntry>();
let activeFetch: Promise<void> | null = null;

function asFiniteNumber(value: unknown): number | null {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) ? n : null;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

function shortHash(value: string): string {
	// The full token is never used as a status/cache key.
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
	return (hash >>> 0).toString(16);
}

function decodeJwtPayload(token: string): any | null {
	try {
		const part = token.split(".")[1];
		if (!part) return null;
		return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
	} catch {
		return null;
	}
}

function getAccountId(accessToken: string): string | null {
	const payload = decodeJwtPayload(accessToken);
	const auth = payload?.["https://api.openai.com/auth"];
	const accountId = auth?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function parseWindow(value: any): WindowInfo | null {
	if (!value || typeof value !== "object") return null;
	const used = asFiniteNumber(value.used_percent);
	if (used === null) return null;
	const usedPercent = clampPercent(used);
	const resetAt = asFiniteNumber(value.reset_at) ?? undefined;
	const windowSeconds = asFiniteNumber(value.limit_window_seconds) ?? undefined;
	return {
		usedPercent,
		leftPercent: 100 - usedPercent,
		...(resetAt !== undefined ? { resetAt } : {}),
		...(windowSeconds !== undefined ? { windowSeconds } : {}),
	};
}

function parseUsage(body: any): QuotaState | { kind: "auth_error" | "rate_limited" | "unavailable" } {
	if (!body || typeof body !== "object") return { kind: "unavailable" };
	const primary = parseWindow(body.rate_limit?.primary_window);
	if (!primary) return { kind: "unavailable" };
	const secondary = parseWindow(body.rate_limit?.secondary_window);
	return {
		kind: "success",
		primary,
		...(secondary ? { secondary } : {}),
		...(typeof body.plan_type === "string" ? { planType: body.plan_type } : {}),
		...(typeof body.rate_limit?.allowed === "boolean" ? { allowed: body.rate_limit.allowed } : {}),
		...(typeof body.rate_limit?.limit_reached === "boolean" ? { limitReached: body.rate_limit.limit_reached } : {}),
		fetchedAt: Date.now(),
	};
}

async function fetchQuota(accessToken: string): Promise<QuotaState | { kind: "auth_error" | "rate_limited" | "unavailable" }> {
	const accountId = getAccountId(accessToken);
	if (!accountId) return { kind: "auth_error" };
	try {
		const response = await fetch(USAGE_URL, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${accessToken}`,
				"ChatGPT-Account-Id": accountId,
				"User-Agent": "codex-cli",
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const text = await response.text();
		let body: any = null;
		try { body = JSON.parse(text); } catch {}
		if (response.status === 401 || response.status === 403) return { kind: "auth_error" };
		if (response.status === 429) return { kind: "rate_limited" };
		return parseUsage(body);
	} catch {
		return { kind: "unavailable" };
	}
}

function colorFor(leftPercent: number): "success" | "warning" | "error" {
	if (leftPercent < LOW_THRESHOLD) return "error";
	if (leftPercent < MID_THRESHOLD) return "warning";
	return "success";
}

function formatWindowLabel(window: WindowInfo, primary: boolean): string {
	if (window.windowSeconds !== undefined) {
		if (window.windowSeconds <= 6 * 60 * 60) return primary ? "5h" : "6h";
		if (window.windowSeconds <= 24 * 60 * 60) return "day";
		return "week";
	}
	return primary ? "5h" : "week";
}

function formatReset(resetAt?: number): string {
	if (!resetAt) return "";
	const ms = resetAt * 1000 - Date.now();
	if (ms <= 0) return "";
	const mins = Math.ceil(ms / 60_000);
	if (mins < 60) return `${mins}m`;
	if (mins >= 24 * 60) {
		const days = Math.floor(mins / (24 * 60));
		const remainingHours = Math.floor((mins % (24 * 60)) / 60);
		return `${days}d${remainingHours}h`;
	}
	const hours = Math.floor(mins / 60);
	const remainingMinutes = mins % 60;
	return `${hours}h${remainingMinutes.toString().padStart(2, "0")}m`;
}

interface PaceInfo {
	value: number;
	severity: "good" | "warn" | "danger";
}

function paceForWindow(window: WindowInfo): PaceInfo | null {
	if (!window.resetAt || !window.windowSeconds || window.windowSeconds <= 0) return null;
	const now = Date.now() / 1000;
	const cycleStart = window.resetAt - window.windowSeconds;
	const theoreticalUsed = ((now - cycleStart) / window.windowSeconds) * 100;
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

function renderWindow(window: WindowInfo, primary: boolean, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const label = formatWindowLabel(window, primary);
	const reset = formatReset(window.resetAt);
	const pace = paceForWindow(window);
	const quotaColor = colorFor(window.leftPercent);
	const bar = "█".repeat(Math.round(window.leftPercent / 10)) + "░".repeat(10 - Math.round(window.leftPercent / 10));
	const base = t.fg(quotaColor, `${label} ${bar} ${window.leftPercent}%`);
	const pacePart = pace ? t.fg(paceColor(pace.severity), ` ${pace.value.toFixed(1)}×`) : "";
	const resetPart = reset ? t.fg("dim", ` ${reset}`) : "";
	return base + pacePart + resetPart;
}

function renderStatus(state: QuotaState, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const parts = [
		t.fg("dim", "Codex"),
		renderWindow(state.primary, true, ctx),
	];
	if (state.secondary) parts.push(renderWindow(state.secondary, false, ctx));
	if (state.planType) {
		const plan = state.planType.charAt(0).toUpperCase() + state.planType.slice(1).toLowerCase();
		parts.push(t.fg("dim", plan));
	}
	if (state.limitReached) parts.push(t.fg("error", "limited"));
	return parts.join(t.fg("dim", " | "));
}

function renderFailure(state: FailureState, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const label = state.kind === "auth_error" ? "auth error"
		: state.kind === "rate_limited" ? "quota limited"
		: "quota unavailable";
	return t.fg("dim", `Codex ${label}`);
}

async function refresh(ctx: ExtensionContext, accessToken: string, key: string, force = false): Promise<void> {
	const now = Date.now();
	const entry = cache.get(key);
	if (!force && entry && now - entry.lastAttemptAt < (
		entry.result.kind === "success" ? REFRESH_TTL_MS
			: entry.result.kind === "rate_limited" ? RATE_LIMIT_RETRY_TTL_MS : ERROR_RETRY_TTL_MS
	)) {
		ctx.ui.setStatus(STATUS_KEY, entry.result.kind === "success"
			? renderStatus(entry.result, ctx) : renderFailure(entry.result, ctx));
		return;
	}

	const result = await fetchQuota(accessToken);
	if (result.kind === "success") {
		cache.set(key, { result, lastAttemptAt: now });
		ctx.ui.setStatus(STATUS_KEY, renderStatus(result, ctx));
	} else {
		const failure: FailureState = { kind: result.kind, at: now };
		cache.set(key, { result: failure, lastAttemptAt: now });
		ctx.ui.setStatus(STATUS_KEY, renderFailure(failure, ctx));
	}
}

async function scheduleRefresh(ctx: ExtensionContext, token: string, key: string, force = false): Promise<void> {
	if (activeFetch) return activeFetch;
	activeFetch = (async () => {
		try { await refresh(ctx, token, key, force); }
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
	const accessToken = await ctx.modelRegistry.getApiKeyForProvider(provider);
	if (!accessToken) {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "Codex no login"));
		return;
	}
	await scheduleRefresh(ctx, accessToken, shortHash(accessToken));
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => { await syncActivation(ctx); });
	pi.on("model_select", async (_event, ctx) => { await syncActivation(ctx); });

	pi.on("tool_result", async (_event, ctx) => {
		if (ctx.model?.provider !== TARGET_PROVIDER) return;
		const accessToken = await ctx.modelRegistry.getApiKeyForProvider(TARGET_PROVIDER);
		if (!accessToken) return;
		await scheduleRefresh(ctx, accessToken, shortHash(accessToken));
	});

	pi.registerCommand("openai-codex-quota", {
		description: "Force-refresh OpenAI Codex subscription quota in the footer",
		handler: async (_args, ctx) => {
			if (ctx.model?.provider !== TARGET_PROVIDER) {
				ctx.ui.notify("Codex quota is only available for the openai-codex provider", "warning");
				return;
			}
			const accessToken = await ctx.modelRegistry.getApiKeyForProvider(TARGET_PROVIDER);
			if (!accessToken) {
				ctx.ui.notify("No OpenAI Codex login found", "warning");
				return;
			}
			const key = shortHash(accessToken);
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "Codex refreshing…"));
			await refresh(ctx, accessToken, key, true);
			ctx.ui.notify("OpenAI Codex quota refreshed", "info");
		},
	});
}
