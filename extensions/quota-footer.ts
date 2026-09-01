// quota-footer.ts — unified provider usage/balance monitor for the pi footer.
//
// Merges the former per-provider extensions (ds-balance, glm-quota,
// minimax-quota, openai-codex-quota) into a single footer widget.
//
// Why one file instead of four?
// The split architecture ran four independent async loops, each with its own
// `model_select` handler that awaited the shared in-flight fetch (up to 5 s
// timeout). Two failure modes followed:
//   1. Stall — switching models while a fetch was in flight blocked the switch
//      handler until that fetch resolved.
//   2. Ghost widgets — a fetch started for the old provider could resolve
//      AFTER the switch and re-set its own status key, resurrecting a widget
//      that should have disappeared.
// A single extension fixes both: one status key, a synchronous clear on every
// switch, and an epoch counter that drops the results of any fetch started
// before the switch happened.
//
// Providers (dispatched with a switch on `ctx.model.provider`):
//   deepseek      → account balance (GET /user/balance)
//   zai-coding-cn → GLM Coding Plan quota (GET /api/monitor/usage/quota/limit)
//   minimax-cn    → MiniMax Coding Plan quota (GET /coding_plan/remains)
//   openai-codex  → Codex subscription quota (GET /backend-api/wham/usage)
//   antigravity   → Antigravity/Google AI quotas (fetchAvailableModels / retrieveUserQuotaSummary)
//
// Command: /quota  (old /ds-balance, /glm-quota, /minimax-quota,
// /openai-codex-quota stay registered as aliases).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "quota";
const REQUEST_TIMEOUT_MS = 5000;
const RATE_LIMIT_RETRY_TTL_MS = 180_000;
const ERROR_RETRY_TTL_MS = 120_000;

// ─── shared plumbing ─────────────────────────────────────────────────────────

type FailureKind = "auth_error" | "rate_limited" | "unavailable";

interface FailureState {
	kind: FailureKind;
	at: number;
}

interface SuccessState {
	kind: "success";
	fetchedAt: number;
	payload: unknown;
}

type FetchResult = SuccessState | FailureState;

interface ProviderConfig {
	label: string;            // footer label, e.g. "DS"
	unavailableWord: string;  // "balance" | "quota" — error wording
	noKeyLabel: string;       // "no api key" | "no login"
	fetch(apiKey: string): Promise<FetchResult>;
	render(payload: unknown, ctx: ExtensionContext): string;
	ttlFor(payload: unknown): number;
}

// In-memory cache keyed by "provider:keyHash" so switching keys or providers
// never shows stale data. Pi extensions are long-lived in one process; a
// process restart just means one extra fetch.
const cache = new Map<string, { result: FetchResult; savedAt: number; lastAttemptAt: number }>();

// Epoch counter: bumped on every model switch. Any async result (fetch,
// cache render) started before the bump is dropped — this is what kills the
// ghost-widget race.
let epoch = 0;

// Only one fetch per key+epoch in flight, so bursts of tool_result events
// coalesce onto a single request.
let activeFetch: { key: string; epoch: number } | null = null;

function shortHash(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
	return (hash >>> 0).toString(16);
}

function cacheKey(provider: string, apiKey: string): string {
	return `${provider}:${shortHash(apiKey)}`;
}

function asFiniteNumber(v: unknown): number | null {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
	return Number.isFinite(n) ? n : null;
}

function clampPercent(n: number | null): number | null {
	if (n === null || !Number.isFinite(n)) return null;
	return Math.max(0, Math.min(100, Math.round(n)));
}

function bar(leftPercent: number, width = 10): string {
	const filled = Math.round((leftPercent / 100) * width);
	return "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, width - filled));
}

function colorFor(leftPercent: number, low: number, mid: number): "success" | "warning" | "error" {
	if (leftPercent < low) return "error";
	if (leftPercent < mid) return "warning";
	return "success";
}

function formatReset(msLeft: number): string {
	if (msLeft <= 0) return "";
	const mins = Math.ceil(msLeft / 60_000);
	if (mins >= 24 * 60) {
		const days = Math.floor(mins / (24 * 60));
		const hours = Math.floor((mins % (24 * 60)) / 60);
		return `${days}d${hours}h`;
	}
	if (mins >= 60) return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
	return `${mins}m`;
}

function paceColor(severity: "good" | "warn" | "danger"): "success" | "warning" | "error" {
	if (severity === "danger") return "error";
	if (severity === "warn") return "warning";
	return "success";
}

function renderFailure(cfg: ProviderConfig, state: FailureState, ctx: ExtensionContext): string {
	const label = state.kind === "auth_error" ? "auth error"
		: state.kind === "rate_limited" ? "rate limited"
		: `${cfg.unavailableWord} unavailable`;
	return ctx.ui.theme.fg("dim", `${cfg.label} ${label}`);
}

function ttlFor(entry: { result: FetchResult; lastAttemptAt: number }, cfg: ProviderConfig): number {
	if (entry.result.kind === "success") return cfg.ttlFor(entry.result.payload);
	if (entry.result.kind === "rate_limited") return RATE_LIMIT_RETRY_TTL_MS;
	return ERROR_RETRY_TTL_MS;
}

// ─── DeepSeek — account balance (provider: deepseek) ─────────────────────────
// GET {baseUrl}/user/balance, Authorization: Bearer <api key>
// → { is_available, balance_infos: [{ currency, total_balance, granted_balance,
//     topped_up_balance }, ...] }

const DS_URLS = ["https://api.deepseek.com/user/balance"] as const;
const DS_LOW_THRESHOLD_CNY = 1.0;
const DS_MID_THRESHOLD_CNY = 3.0;
const DS_CURRENCY_SYMBOL: Record<string, string> = { CNY: "¥", USD: "$" };
const DS_REFRESH_BANDS = [
	{ minLeft: 10, ttlMs: 300_000 }, // ≥ ¥10 → 5 min
	{ minLeft: 0, ttlMs: 60_000 }, // < ¥10 → 1 min
] as const;

interface DSBalancePayload {
	currency: string;
	symbol: string;
	total: number;
	granted: number;
	toppedUp: number;
	available: boolean;
}

function dsTtlFor(payload: unknown): number {
	const total = (payload as DSBalancePayload).total;
	const band = DS_REFRESH_BANDS.find((b) => total >= b.minLeft);
	return band ? band.ttlMs : DS_REFRESH_BANDS[DS_REFRESH_BANDS.length - 1].ttlMs;
}

function parseDSBalance(body: any): FetchResult {
	if (!body || typeof body !== "object") return { kind: "unavailable", at: Date.now() };

	const msg = typeof body.message === "string" ? body.message
		: typeof body.msg === "string" ? body.msg
		: typeof body.error === "string" ? body.error : "";
	if (/Authorization|authentication|auth|token|Bearer/i.test(msg)) {
		return { kind: "auth_error", at: Date.now() };
	}
	if (/rate\s*limit|too many|429/i.test(msg)) {
		return { kind: "rate_limited", at: Date.now() };
	}

	const infos: any[] = Array.isArray(body.balance_infos) ? body.balance_infos : [];
	if (infos.length === 0) return { kind: "unavailable", at: Date.now() };

	// Prefer CNY (the CN platform default), fall back to the first entry.
	const info = infos.find((i) => i?.currency === "CNY") ?? infos[0];
	const currency = typeof info?.currency === "string" ? info.currency : "CNY";

	const total = asFiniteNumber(info?.total_balance);
	if (total === null) return { kind: "unavailable", at: Date.now() };

	return {
		kind: "success",
		fetchedAt: Date.now(),
		payload: {
			currency,
			symbol: DS_CURRENCY_SYMBOL[currency] ?? (currency === "USD" ? "$" : "¥"),
			total,
			granted: asFiniteNumber(info?.granted_balance) ?? 0,
			toppedUp: asFiniteNumber(info?.topped_up_balance) ?? 0,
			available: body.is_available !== false,
		},
	};
}

async function fetchDS(apiKey: string): Promise<FetchResult> {
	for (const url of DS_URLS) {
		try {
			const res = await fetch(url, {
				method: "GET",
				headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const text = await res.text();
			let json: any = null;
			try { json = JSON.parse(text); } catch {}
			if (res.status === 401 || res.status === 403) return { kind: "auth_error", at: Date.now() };
			if (res.status === 429) return { kind: "rate_limited", at: Date.now() };
			return parseDSBalance(json);
		} catch {
			// try the next URL; if none left → unavailable
		}
	}
	return { kind: "unavailable", at: Date.now() };
}

function renderDS(payload: unknown, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const state = payload as DSBalancePayload;
	const sym = state.symbol ?? "¥";

	const fmtAmount = (total: number): string => {
		const digits = total >= 100 ? 0 : 2;
		const suffix = total >= 10000 ? "k" : "";
		const value = suffix ? total / 1000 : total;
		return `${value.toFixed(digits)}${suffix}`;
	};

	// Absolute balance; use ¥50 as the full-bar reference.
	const fillPercent = Math.max(0, Math.min(100, (state.total / 50) * 100));
	const balanceColor = colorFor(state.total, DS_LOW_THRESHOLD_CNY, DS_MID_THRESHOLD_CNY);
	const parts: string[] = [
		t.fg("dim", "DS") + " " + t.fg(balanceColor, bar(fillPercent)) + " "
			+ t.fg(balanceColor, `${sym}${fmtAmount(state.total)}`),
	];

	// Show granted (bonus) balance separately if nonzero — it burns down first.
	if (state.granted > 0) {
		parts.push(t.fg("dim", `g${sym}${fmtAmount(state.granted)}`));
	}

	if (!state.available && state.total <= 0) {
		parts.push(t.fg("error", "no balance"));
	}

	return parts.join(t.fg("dim", " "));
}

// ─── GLM — Coding Plan quota (provider: zai-coding-cn) ───────────────────────
// GET {baseUrl}/api/monitor/usage/quota/limit, Authorization: <glm api key>
// → { success, data: { level, limits: [{ type, number, usage, remaining,
//     currentValue, nextResetTime }, ...] } }
// type === "TOKENS_LIMIT" → 5h / week token quota; MCP_LIMIT/TIME_LIMIT → tool calls.

const GLM_URLS = [
	"https://open.bigmodel.cn/api/monitor/usage/quota/limit",
	"https://api.z.ai/api/monitor/usage/quota/limit",
] as const;
const GLM_LOW_THRESHOLD = 30;
const GLM_MID_THRESHOLD = 60;
const GLM_PACE_WARN_THRESHOLD = 1.1;
const GLM_PACE_DANGER_THRESHOLD = 1.3;
const GLM_REFRESH_BANDS = [
	{ minLeftPercent: 80, ttlMs: 120_000 },
	{ minLeftPercent: 30, ttlMs: 300_000 },
	{ minLeftPercent: 0, ttlMs: 120_000 },
] as const;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;

interface GLMQuotaPayload {
	level: string;
	leftPercent: number;
	weekLeftPercent?: number;
	mcpLeftPercent?: number;
	nextResetTime?: number;
	primaryCycleStart?: number;
	primaryCycleMs?: number;
	weekNextResetTime?: number;
}

function glmTtlFor(payload: unknown): number {
	const leftPercent = (payload as GLMQuotaPayload).leftPercent;
	const band = GLM_REFRESH_BANDS.find((b) => leftPercent >= b.minLeftPercent);
	return band ? band.ttlMs : GLM_REFRESH_BANDS[GLM_REFRESH_BANDS.length - 1].ttlMs;
}

// Compute (leftPercent, usedPercent) from a limit object: prefer
// remaining+currentValue; fall back to usage; last resort `percentage`.
function glmComputePercentages(limit: any): { leftPercent: number; usedPercent: number } | null {
	const remaining = asFiniteNumber(limit?.remaining);
	const currentValue = asFiniteNumber(limit?.currentValue);
	const usage = asFiniteNumber(limit?.usage);
	const totalFromParts = remaining !== null && currentValue !== null ? remaining + currentValue : null;
	const total = totalFromParts !== null && totalFromParts > 0 ? totalFromParts : usage;

	if (total !== null && total > 0) {
		if (remaining !== null && remaining >= 0 && remaining <= total) {
			const leftPercent = clampPercent((remaining / total) * 100);
			if (leftPercent !== null) return { leftPercent, usedPercent: 100 - leftPercent };
		}
		if (currentValue !== null && currentValue >= 0 && currentValue <= total) {
			const usedPercent = clampPercent((currentValue / total) * 100);
			if (usedPercent !== null) return { leftPercent: 100 - usedPercent, usedPercent };
		}
	}

	const usedPercent = clampPercent(limit?.percentage);
	if (usedPercent === null) return null;
	return { leftPercent: 100 - usedPercent, usedPercent };
}

function parseGLMQuota(body: any): FetchResult {
	if (!body || typeof body !== "object") return { kind: "unavailable", at: Date.now() };
	if (body.success !== true) {
		const code = body.code;
		const msg = typeof body.msg === "string" ? body.msg : "";
		if (code === 1001 || code === 401 || /authorization|auth|token/i.test(msg)) {
			return { kind: "auth_error", at: Date.now() };
		}
		if (/rate\s*limit|too many requests|too frequent|frequency|限流|频率|过于频繁|稍后再试/i.test(msg)) {
			return { kind: "rate_limited", at: Date.now() };
		}
		return { kind: "unavailable", at: Date.now() };
	}

	const data = body.data ?? {};
	const level = typeof data.level === "string" ? data.level : "";
	const limits: any[] = Array.isArray(data.limits) ? data.limits : [];

	const tokenLimits = limits.filter((l) => l?.type === "TOKENS_LIMIT");
	if (tokenLimits.length === 0) return { kind: "unavailable", at: Date.now() };

	// Pick the 5h limit (number === 5) if present; otherwise the one with the
	// nearest reset. The other one is the weekly limit.
	const explicit5h = tokenLimits.find((l) => l?.number === 5) ?? null;
	let primary: any;
	let week: any | null = null;
	if (explicit5h) {
		primary = explicit5h;
		week = tokenLimits.find((l) => l !== explicit5h) ?? null;
	} else {
		const sorted = [...tokenLimits].sort((a, b) => (asFiniteNumber(a?.nextResetTime) ?? Infinity) - (asFiniteNumber(b?.nextResetTime) ?? Infinity));
		primary = sorted[0];
		week = sorted[1] ?? null;
	}

	const primaryPct = glmComputePercentages(primary);
	if (!primaryPct) return { kind: "unavailable", at: Date.now() };
	const nextResetTime = asFiniteNumber(primary?.nextResetTime) ?? undefined;

	const isFiveHour = explicit5h !== null || primary?.number === 5;
	const primaryCycleMs = isFiveHour ? FIVE_HOUR_WINDOW_MS : undefined;
	const primaryCycleStart = (nextResetTime !== undefined && primaryCycleMs !== undefined)
		? nextResetTime - primaryCycleMs
		: undefined;

	const mcpLimit = limits.find((l) => l?.type === "MCP_LIMIT" || l?.type === "TIME_LIMIT");
	const mcpPct = mcpLimit ? glmComputePercentages(mcpLimit) : null;
	const weekPct = week ? glmComputePercentages(week) : null;
	const weekNextResetTime = week ? (asFiniteNumber(week?.nextResetTime) ?? undefined) : undefined;

	return {
		kind: "success",
		fetchedAt: Date.now(),
		payload: {
			level,
			leftPercent: primaryPct.leftPercent,
			...(weekPct ? { weekLeftPercent: weekPct.leftPercent } : {}),
			...(mcpPct ? { mcpLeftPercent: mcpPct.leftPercent } : {}),
			...(nextResetTime !== undefined ? { nextResetTime } : {}),
			...(primaryCycleStart !== undefined ? { primaryCycleStart } : {}),
			...(primaryCycleMs !== undefined ? { primaryCycleMs } : {}),
			...(weekNextResetTime !== undefined ? { weekNextResetTime } : {}),
		},
	};
}

async function fetchGLM(apiKey: string): Promise<FetchResult> {
	for (const url of GLM_URLS) {
		try {
			const res = await fetch(url, {
				method: "GET",
				headers: { Accept: "application/json, text/plain, */*", Authorization: apiKey },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const text = await res.text();
			let json: any = null;
			try { json = JSON.parse(text); } catch {}
			if (res.status === 429) return { kind: "rate_limited", at: Date.now() };
			return parseGLMQuota(json);
		} catch {
			// try the next URL; if none left → unavailable
		}
	}
	return { kind: "unavailable", at: Date.now() };
}

// pace = used% / theoretical% (fraction of the cycle elapsed). > 1 means
// burning faster than sustainable — will run out before the reset.
function glmPace(usedPercent: number, nextResetTime: number | undefined, cycleMs: number, now = Date.now()): { value: number; severity: "good" | "warn" | "danger" } | null {
	if (!nextResetTime || !Number.isFinite(nextResetTime) || nextResetTime <= now) return null;
	const cycleStart = nextResetTime - cycleMs;
	if (cycleStart >= now) return null;
	const theoreticalUsed = ((now - cycleStart) / cycleMs) * 100;
	if (theoreticalUsed <= 0) return null;
	const value = usedPercent / theoreticalUsed;
	const severity = value > GLM_PACE_DANGER_THRESHOLD ? "danger"
		: value > GLM_PACE_WARN_THRESHOLD ? "warn" : "good";
	return { value, severity };
}

function glmWeekPace(usedPercent: number, nextResetTime: number | undefined, now = Date.now()): { value: number; severity: "good" | "warn" | "danger" } | null {
	if (!nextResetTime || !Number.isFinite(nextResetTime) || nextResetTime <= now) return null;
	return glmPace(usedPercent, nextResetTime, WEEK_MS, now);
}

function renderGLM(payload: unknown, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const state = payload as GLMQuotaPayload;
	const lvl = state.level ? ` ${state.level}` : "";
	const primaryColor = colorFor(state.leftPercent, GLM_LOW_THRESHOLD, GLM_MID_THRESHOLD);

	let primarySeg = t.fg("dim", "GLM") + t.fg(primaryColor, `${lvl} ${bar(state.leftPercent)} ${state.leftPercent}%`);
	if (state.primaryCycleMs !== undefined) {
		const pace = glmPace(100 - state.leftPercent, state.nextResetTime, state.primaryCycleMs);
		if (pace) primarySeg += " " + t.fg(paceColor(pace.severity), `${(Math.round(pace.value * 10) / 10).toFixed(1)}×`);
	}

	const parts: string[] = [primarySeg];

	if (state.weekLeftPercent !== undefined) {
		let weekSeg = t.fg(colorFor(state.weekLeftPercent, GLM_LOW_THRESHOLD, GLM_MID_THRESHOLD), `W${bar(state.weekLeftPercent, 6)} ${state.weekLeftPercent}%`);
		const weekPace = glmWeekPace(100 - state.weekLeftPercent, state.weekNextResetTime);
		if (weekPace) weekSeg += " " + t.fg(paceColor(weekPace.severity), `${(Math.round(weekPace.value * 10) / 10).toFixed(1)}×`);
		parts.push(weekSeg);
	}

	if (state.mcpLeftPercent !== undefined) {
		parts.push(t.fg(colorFor(state.mcpLeftPercent, GLM_LOW_THRESHOLD, GLM_MID_THRESHOLD), `MCP ${state.mcpLeftPercent}%`));
	}

	if (state.nextResetTime !== undefined) {
		const reset = formatReset(state.nextResetTime - Date.now());
		if (reset) parts.push(t.fg("dim", `reset ${reset}`));
	}
	return parts.join(t.fg("dim", " | "));
}

// ─── MiniMax — Coding Plan quota (provider: minimax-cn) ──────────────────────
// GET https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains
// Authorization: Bearer <key>. Returns remaining percentages for the current
// interval and the weekly window.

const MM_URL = "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains";
const MM_LOW_THRESHOLD = 30;
const MM_MID_THRESHOLD = 60;
const MM_PACE_WARN_THRESHOLD = 1.1;
const MM_PACE_DANGER_THRESHOLD = 1.3;
const MM_REFRESH_BANDS = [
	{ minLeft: 70, ttlMs: 300_000 },
	{ minLeft: 30, ttlMs: 120_000 },
	{ minLeft: 0, ttlMs: 60_000 },
] as const;

interface MMWindow {
	leftPercent: number;
	usedPercent: number;
	startAt?: number;
	endAt?: number;
}

interface MMPayload {
	interval: MMWindow;
	weekly?: MMWindow;
	modelName?: string;
}

function mmTtlFor(payload: unknown): number {
	const leftPercent = (payload as MMPayload).interval.leftPercent;
	return MM_REFRESH_BANDS.find((b) => leftPercent >= b.minLeft)?.ttlMs ?? 60_000;
}

function parseMMWindow(item: any, prefix: "interval" | "weekly"): MMWindow | null {
	const remainingKey = prefix === "interval"
		? "current_interval_remaining_percent"
		: "current_weekly_remaining_percent";
	const left = asFiniteNumber(item?.[remainingKey]);
	if (left === null) return null;
	const leftPercent = clampPercent(left) ?? 0;
	const start = asFiniteNumber(prefix === "interval" ? item?.start_time : item?.weekly_start_time) ?? undefined;
	const end = asFiniteNumber(prefix === "interval" ? item?.end_time : item?.weekly_end_time) ?? undefined;
	return {
		leftPercent,
		usedPercent: 100 - leftPercent,
		...(start !== undefined ? { startAt: start } : {}),
		...(end !== undefined ? { endAt: end } : {}),
	};
}

function parseMMQuota(body: any): FetchResult {
	if (!body || typeof body !== "object") return { kind: "unavailable", at: Date.now() };
	const code = asFiniteNumber(body.base_resp?.status_code);
	const msg = typeof body.base_resp?.status_msg === "string" ? body.base_resp.status_msg : "";
	if (code === 1004 || /auth|login|cookie|token|key/i.test(msg)) return { kind: "auth_error", at: Date.now() };
	if (code === 429 || /rate|too frequent|频繁|限流/i.test(msg)) return { kind: "rate_limited", at: Date.now() };

	const remains: any[] = Array.isArray(body.model_remains) ? body.model_remains : [];
	if (remains.length === 0) return { kind: "unavailable", at: Date.now() };
	// `general` is the coding-plan text quota; fall back for accounts where the
	// API only returns a model-specific row.
	const item = remains.find((r) => r?.model_name === "general") ?? remains[0];
	const interval = parseMMWindow(item, "interval");
	const weeklyStatus = asFiniteNumber(item?.current_weekly_status);
	const weeklyTotal = asFiniteNumber(item?.current_weekly_total_count);
	// MiniMax returns 100% for accounts without a weekly limit. Status 3 and
	// total_count === 0 mean the weekly window is inactive, not full.
	const hasWeeklyLimit = weeklyStatus !== 3 && weeklyTotal !== 0;
	const weekly = hasWeeklyLimit ? parseMMWindow(item, "weekly") : null;
	if (!interval || (hasWeeklyLimit && !weekly)) return { kind: "unavailable", at: Date.now() };
	return {
		kind: "success",
		fetchedAt: Date.now(),
		payload: {
			interval,
			...(weekly ? { weekly } : {}),
			...(typeof item?.model_name === "string" ? { modelName: item.model_name } : {}),
		},
	};
}

async function fetchMM(apiKey: string): Promise<FetchResult> {
	try {
		const response = await fetch(MM_URL, {
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
		if (response.status === 401 || response.status === 403) return { kind: "auth_error", at: Date.now() };
		if (response.status === 429) return { kind: "rate_limited", at: Date.now() };
		return parseMMQuota(body);
	} catch {
		return { kind: "unavailable", at: Date.now() };
	}
}

function mmPace(window: MMWindow): { value: number; severity: "good" | "warn" | "danger" } | null {
	if (!window.startAt || !window.endAt || window.endAt <= window.startAt) return null;
	const now = Date.now();
	const elapsed = now - window.startAt;
	const duration = window.endAt - window.startAt;
	const theoreticalUsed = (elapsed / duration) * 100;
	if (theoreticalUsed <= 0 || theoreticalUsed >= 100) return null;
	const value = window.usedPercent / theoreticalUsed;
	const severity = value > MM_PACE_DANGER_THRESHOLD ? "danger"
		: value > MM_PACE_WARN_THRESHOLD ? "warn" : "good";
	return { value, severity };
}

function renderMMWindow(label: string, window: MMWindow, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const quotaColor = colorFor(window.leftPercent, MM_LOW_THRESHOLD, MM_MID_THRESHOLD);
	const base = t.fg(quotaColor, `${label} ${bar(window.leftPercent)} ${window.leftPercent}%`);
	const pace = mmPace(window);
	const pacePart = pace ? t.fg(paceColor(pace.severity), ` ${pace.value.toFixed(1)}×`) : "";
	const reset = window.endAt !== undefined ? formatReset(window.endAt - Date.now()) : "";
	const resetPart = reset ? t.fg("dim", ` ${reset}`) : "";
	return base + pacePart + resetPart;
}

function renderMM(payload: unknown, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const state = payload as MMPayload;
	return [
		t.fg("dim", "MiniMax"),
		renderMMWindow("5h", state.interval, ctx),
		...(state.weekly ? [renderMMWindow("week", state.weekly, ctx)] : []),
	].join(t.fg("dim", " | "));
}

// ─── OpenAI Codex — subscription quota (provider: openai-codex) ──────────────
// GET https://chatgpt.com/backend-api/wham/usage
// Authorization: Bearer <OAuth access token>, ChatGPT-Account-Id: <account id>
// → { rate_limit: { primary_window, secondary_window:
//     { used_percent, reset_at, limit_window_seconds } } }

const CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_LOW_THRESHOLD = 30;
const CODEX_MID_THRESHOLD = 60;
const CODEX_PACE_WARN_THRESHOLD = 1.1;
const CODEX_PACE_DANGER_THRESHOLD = 1.3;
const CODEX_REFRESH_TTL_MS = 5 * 60_000;

interface CodexWindow {
	leftPercent: number;
	usedPercent: number;
	resetAt?: number;
	windowSeconds?: number;
}

interface CodexPayload {
	primary: CodexWindow;
	secondary?: CodexWindow;
	planType?: string;
	allowed?: boolean;
	limitReached?: boolean;
}

function codexTtlFor(_payload: unknown): number {
	return CODEX_REFRESH_TTL_MS;
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

function getCodexAccountId(accessToken: string): string | null {
	const payload = decodeJwtPayload(accessToken);
	const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function parseCodexWindow(value: any): CodexWindow | null {
	if (!value || typeof value !== "object") return null;
	const used = asFiniteNumber(value.used_percent);
	if (used === null) return null;
	const usedPercent = clampPercent(used) ?? 0;
	const resetAt = asFiniteNumber(value.reset_at) ?? undefined;
	const windowSeconds = asFiniteNumber(value.limit_window_seconds) ?? undefined;
	return {
		usedPercent,
		leftPercent: 100 - usedPercent,
		...(resetAt !== undefined ? { resetAt } : {}),
		...(windowSeconds !== undefined ? { windowSeconds } : {}),
	};
}

function parseCodexUsage(body: any): FetchResult {
	if (!body || typeof body !== "object") return { kind: "unavailable", at: Date.now() };
	const primary = parseCodexWindow(body.rate_limit?.primary_window);
	if (!primary) return { kind: "unavailable", at: Date.now() };
	const secondary = parseCodexWindow(body.rate_limit?.secondary_window);
	return {
		kind: "success",
		fetchedAt: Date.now(),
		payload: {
			primary,
			...(secondary ? { secondary } : {}),
			...(typeof body.plan_type === "string" ? { planType: body.plan_type } : {}),
			...(typeof body.rate_limit?.allowed === "boolean" ? { allowed: body.rate_limit.allowed } : {}),
			...(typeof body.rate_limit?.limit_reached === "boolean" ? { limitReached: body.rate_limit.limit_reached } : {}),
		},
	};
}

async function fetchCodex(accessToken: string): Promise<FetchResult> {
	const accountId = getCodexAccountId(accessToken);
	if (!accountId) return { kind: "auth_error", at: Date.now() };
	try {
		const response = await fetch(CODEX_URL, {
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
		if (response.status === 401 || response.status === 403) return { kind: "auth_error", at: Date.now() };
		if (response.status === 429) return { kind: "rate_limited", at: Date.now() };
		return parseCodexUsage(body);
	} catch {
		return { kind: "unavailable", at: Date.now() };
	}
}

function codexWindowLabel(window: CodexWindow, primary: boolean): string {
	if (window.windowSeconds !== undefined) {
		if (window.windowSeconds <= 6 * 60 * 60) return primary ? "5h" : "6h";
		if (window.windowSeconds <= 24 * 60 * 60) return "day";
		return "week";
	}
	return primary ? "5h" : "week";
}

function codexPace(window: CodexWindow): { value: number; severity: "good" | "warn" | "danger" } | null {
	if (!window.resetAt || !window.windowSeconds || window.windowSeconds <= 0) return null;
	const now = Date.now() / 1000;
	const cycleStart = window.resetAt - window.windowSeconds;
	const theoreticalUsed = ((now - cycleStart) / window.windowSeconds) * 100;
	if (theoreticalUsed <= 0 || theoreticalUsed >= 100) return null;
	const value = window.usedPercent / theoreticalUsed;
	const severity = value > CODEX_PACE_DANGER_THRESHOLD ? "danger"
		: value > CODEX_PACE_WARN_THRESHOLD ? "warn" : "good";
	return { value, severity };
}

function renderCodexWindow(window: CodexWindow, primary: boolean, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const label = codexWindowLabel(window, primary);
	const quotaColor = colorFor(window.leftPercent, CODEX_LOW_THRESHOLD, CODEX_MID_THRESHOLD);
	const base = t.fg(quotaColor, `${label} ${bar(window.leftPercent)} ${window.leftPercent}%`);
	const pace = codexPace(window);
	const pacePart = pace ? t.fg(paceColor(pace.severity), ` ${pace.value.toFixed(1)}×`) : "";
	const reset = window.resetAt !== undefined ? formatReset(window.resetAt * 1000 - Date.now()) : "";
	const resetPart = reset ? t.fg("dim", ` ${reset}`) : "";
	return base + pacePart + resetPart;
}

function renderCodex(payload: unknown, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const state = payload as CodexPayload;
	const parts = [
		t.fg("dim", "Codex"),
		renderCodexWindow(state.primary, true, ctx),
	];
	if (state.secondary) parts.push(renderCodexWindow(state.secondary, false, ctx));
	if (state.planType) {
		const plan = state.planType.charAt(0).toUpperCase() + state.planType.slice(1).toLowerCase();
		parts.push(t.fg("dim", plan));
	}
	if (state.limitReached) parts.push(t.fg("error", "limited"));
	return parts.join(t.fg("dim", " | "));
}

// ─── Antigravity — Google Cloud Code Assist Quotas (provider: antigravity) ──
// POST https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels
// Authorization: Bearer <OAuth token>, Client-Metadata: { ideType: "ANTIGRAVITY", platform, pluginType: "GEMINI" }
// → { models: { [modelId]: { quotaInfo: { remainingFraction, resetTime } } } }

const ANTIGRAVITY_ENDPOINTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
] as const;
const ANTIGRAVITY_LOW_THRESHOLD = 30;
const ANTIGRAVITY_MID_THRESHOLD = 60;
const ANTIGRAVITY_REFRESH_TTL_MS = 5 * 60_000;

interface AntigravityBucket {
	label: string;
	leftPercent: number;
	resetTime?: string;
}

interface AntigravityPayload {
	buckets: AntigravityBucket[];
	plan?: string;
}

function antigravityTtlFor(_payload: unknown): number {
	return ANTIGRAVITY_REFRESH_TTL_MS;
}

function parseAntigravityCreds(apiKey: string): { token: string; projectId: string } | null {
	try {
		const parsed = JSON.parse(apiKey);
		if (parsed && typeof parsed.token === "string" && parsed.token.length > 0) {
			return { token: parsed.token, projectId: parsed.projectId || "antigravity-default" };
		}
	} catch {}
	if (apiKey && apiKey.length > 0) {
		return { token: apiKey, projectId: "antigravity-default" };
	}
	return null;
}

function antigravityHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		Accept: "application/json",
		"User-Agent": "antigravity/hub/2.8.0 (aidev_client; os_type=linux; arch=x64; cl=963137146)",
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({
			ideType: "ANTIGRAVITY",
			platform: process.platform === "darwin" ? "MACOS" : process.platform === "win32" ? "WINDOWS" : "LINUX",
			pluginType: "GEMINI",
		}),
	};
}

function simplifyAntigravityLabel(groupName?: string, bucketName?: string): string {
	const raw = `${groupName || ""} ${bucketName || ""}`.trim();
	if (/week/i.test(raw)) {
		return "weekly";
	}
	if (/five\s*hour|5\s*h/i.test(raw)) {
		return "5h";
	}
	if (/day|24\s*h/i.test(raw)) {
		return "day";
	}
	if (bucketName) {
		return (
			bucketName
				.replace(/\s*(Limit|Remaining|Quota)\s*/gi, "")
				.trim()
				.toLowerCase() || bucketName
		);
	}
	return "quota";
}

async function fetchAntigravity(apiKey: string): Promise<FetchResult> {
	const creds = parseAntigravityCreds(apiKey);
	if (!creds) return { kind: "auth_error", at: Date.now() };

	let lastStatus = 0;
	let quotaSummary: any = null;
	let modelsData: any = null;

	const headers = antigravityHeaders(creds.token);

	// Try retrieveUserQuotaSummary first (preferred for paid tiers)
	for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
		try {
			const res = await fetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
				method: "POST",
				headers,
				body: JSON.stringify({}),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			lastStatus = res.status;
			if (res.ok) {
				quotaSummary = await res.json();
				break;
			}
		} catch {}
	}

	// Also fetch available models to extract quotaInfo per bucket / fallback
	for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
		try {
			const res = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
				method: "POST",
				headers,
				body: JSON.stringify({ project: creds.projectId }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			lastStatus = res.status;
			if (res.ok) {
				modelsData = await res.json();
				break;
			}
		} catch {}
	}

	if (lastStatus === 401 || lastStatus === 403) {
		// If quota summary is 403 (e.g. free-tier), but modelsData succeeded, proceed with modelsData
		if (!modelsData) return { kind: "auth_error", at: Date.now() };
	}
	if (lastStatus === 429 && !modelsData && !quotaSummary) {
		return { kind: "rate_limited", at: Date.now() };
	}
	if (!quotaSummary && !modelsData) {
		return { kind: "unavailable", at: Date.now() };
	}

	const buckets: AntigravityBucket[] = [];

	// Parse from quotaSummary groups if available
	if (quotaSummary?.groups && Array.isArray(quotaSummary.groups)) {
		for (const group of quotaSummary.groups) {
			const groupName = typeof group.displayName === "string" ? group.displayName : "";
			const groupPrefix = /gemini/i.test(groupName)
				? "Gemini"
				: /claude|gpt/i.test(groupName)
					? "Claude"
					: groupName;

			const groupBuckets: AntigravityBucket[] = [];
			for (const b of group.buckets || []) {
				const rem = asFiniteNumber(b.remainingFraction);
				if (rem !== null) {
					const leftPercent = Math.round(clampPercent(rem * 100) ?? 0);
					const bucketName = typeof b.displayName === "string" ? b.displayName : undefined;
					const winLabel = simplifyAntigravityLabel(groupName, bucketName || groupName);
					groupBuckets.push({
						label: winLabel,
						leftPercent,
						resetTime: typeof b.resetTime === "string" ? b.resetTime : undefined,
					});
				}
			}
			// Sort so 5h / shorter windows appear before weekly / longer windows
			groupBuckets.sort((a, b) => {
				const aIs5h = /\b5h\b/i.test(a.label);
				const bIs5h = /\b5h\b/i.test(b.label);
				if (aIs5h && !bIs5h) return -1;
				if (!aIs5h && bIs5h) return 1;
				return 0;
			});

			// Prefix only the first bucket (typically 5h) with the group name (e.g. "Gemini 5h", then "weekly")
			if (groupBuckets.length > 0 && groupPrefix) {
				groupBuckets[0].label = `${groupPrefix} ${groupBuckets[0].label}`;
			}
			buckets.push(...groupBuckets);
		}
	}

	// Fallback to modelsData quotaInfo if no buckets from summary
	if (buckets.length === 0 && modelsData?.models && typeof modelsData.models === "object") {
		// Group / pick representative models (Claude/GPT pool vs Gemini pool)
		const modelEntries = Object.entries(modelsData.models) as [string, any][];
		const claudeOrGpt = modelEntries.find(([id, m]) => /claude|gpt/i.test(id) && m?.quotaInfo?.remainingFraction !== undefined);
		const gemini = modelEntries.find(([id, m]) => /gemini.*pro|gemini.*flash/i.test(id) && m?.quotaInfo?.remainingFraction !== undefined);

		if (gemini && gemini[1]?.quotaInfo) {
			const rem = asFiniteNumber(gemini[1].quotaInfo.remainingFraction);
			if (rem !== null) {
				buckets.push({
					label: "Gemini",
					leftPercent: Math.round(clampPercent(rem * 100) ?? 0),
					resetTime: gemini[1].quotaInfo.resetTime,
				});
			}
		}
		if (claudeOrGpt && claudeOrGpt[1]?.quotaInfo) {
			const rem = asFiniteNumber(claudeOrGpt[1].quotaInfo.remainingFraction);
			if (rem !== null) {
				buckets.push({
					label: "Claude/GPT",
					leftPercent: Math.round(clampPercent(rem * 100) ?? 0),
					resetTime: claudeOrGpt[1].quotaInfo.resetTime,
				});
			}
		}
	}

	if (buckets.length === 0) {
		return { kind: "unavailable", at: Date.now() };
	}

	return {
		kind: "success",
		fetchedAt: Date.now(),
		payload: { buckets },
	};
}

function renderAntigravityBucket(b: AntigravityBucket, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const quotaColor = colorFor(b.leftPercent, ANTIGRAVITY_LOW_THRESHOLD, ANTIGRAVITY_MID_THRESHOLD);
	const base = t.fg(quotaColor, `${b.label} ${bar(b.leftPercent)} ${b.leftPercent}%`);
	let resetPart = "";
	if (b.resetTime) {
		const ts = Date.parse(b.resetTime);
		if (Number.isFinite(ts)) {
			const reset = formatReset(ts - Date.now());
			if (reset) resetPart = t.fg("dim", ` ${reset}`);
		}
	}
	return base + resetPart;
}

function renderAntigravity(payload: unknown, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const state = payload as AntigravityPayload;
	const parts = [
		t.fg("dim", "Antigravity"),
		...state.buckets.map((b) => renderAntigravityBucket(b, ctx)),
	];
	return parts.join(t.fg("dim", " | "));
}

// ─── provider dispatch ───────────────────────────────────────────────────────

const CONFIGS: Record<string, ProviderConfig> = {
	deepseek: {
		label: "DS",
		unavailableWord: "balance",
		noKeyLabel: "no api key",
		fetch: fetchDS,
		render: renderDS,
		ttlFor: dsTtlFor,
	},
	"zai-coding-cn": {
		label: "GLM",
		unavailableWord: "quota",
		noKeyLabel: "no api key",
		fetch: fetchGLM,
		render: renderGLM,
		ttlFor: glmTtlFor,
	},
	"minimax-cn": {
		label: "MiniMax",
		unavailableWord: "quota",
		noKeyLabel: "no api key",
		fetch: fetchMM,
		render: renderMM,
		ttlFor: mmTtlFor,
	},
	"openai-codex": {
		label: "Codex",
		unavailableWord: "quota",
		noKeyLabel: "no login",
		fetch: fetchCodex,
		render: renderCodex,
		ttlFor: codexTtlFor,
	},
	antigravity: {
		label: "Antigravity",
		unavailableWord: "quota",
		noKeyLabel: "no login",
		fetch: fetchAntigravity,
		render: renderAntigravity,
		ttlFor: antigravityTtlFor,
	},
};

function renderEntry(entry: { result: FetchResult }, cfg: ProviderConfig, ctx: ExtensionContext): string {
	return entry.result.kind === "success"
		? cfg.render(entry.result.payload, ctx)
		: renderFailure(cfg, entry.result, ctx);
}

// ─── core refresh logic ──────────────────────────────────────────────────────

async function refresh(ctx: ExtensionContext, cfg: ProviderConfig, apiKey: string, key: string, myEpoch: number, force = false): Promise<void> {
	const now = Date.now();
	const entry = cache.get(key);

	if (!force && entry && now - entry.lastAttemptAt < ttlFor(entry, cfg)) {
		// Cache still fresh — re-render from cache, no network.
		if (myEpoch === epoch) ctx.ui.setStatus(STATUS_KEY, renderEntry(entry, cfg, ctx));
		return;
	}

	const result = await cfg.fetch(apiKey);
	if (myEpoch !== epoch) return; // model switched while we were fetching — drop

	if (result.kind === "success") {
		cache.set(key, { result, savedAt: now, lastAttemptAt: now });
		ctx.ui.setStatus(STATUS_KEY, cfg.render(result.payload, ctx));
	} else {
		cache.set(key, { result, savedAt: now, lastAttemptAt: now });
		ctx.ui.setStatus(STATUS_KEY, renderFailure(cfg, result, ctx));
	}
}

// Fire-and-forget refresh. Never awaited from model_select/tool_result, so
// switching models can't block on the network. Results are epoch-guarded.
function scheduleRefresh(ctx: ExtensionContext, cfg: ProviderConfig, apiKey: string, key: string, myEpoch: number, force = false): void {
	// Coalesce only the exact same fetch (same key + same switch epoch).
	if (activeFetch && activeFetch.key === key && activeFetch.epoch === myEpoch) return;
	activeFetch = { key, epoch: myEpoch };
	void (async () => {
		try {
			await refresh(ctx, cfg, apiKey, key, myEpoch, force);
		} finally {
			if (activeFetch) activeFetch = null;
		}
	})();
}

// ─── activation guard ────────────────────────────────────────────────────────

async function syncActivation(ctx: ExtensionContext): Promise<void> {
	// Bump the epoch and clear the widget synchronously — the old provider's
	// widget must vanish immediately, and any in-flight fetch for it becomes
	// stale the moment it resolves.
	const myEpoch = ++epoch;
	ctx.ui.setStatus(STATUS_KEY, undefined);

	const provider = ctx.model?.provider;
	const cfg = provider ? CONFIGS[provider] : undefined;
	if (!cfg || !provider) return; // no monitor for this provider → stay invisible

	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
	if (!apiKey) {
		if (myEpoch === epoch) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `${cfg.label} ${cfg.noKeyLabel}`));
		}
		return;
	}

	const key = cacheKey(provider, apiKey);

	// Show the cached value immediately (even if stale — better than a blank
	// footer while the fetch runs), then refresh in the background.
	const entry = cache.get(key);
	if (entry && myEpoch === epoch) {
		ctx.ui.setStatus(STATUS_KEY, renderEntry(entry, cfg, ctx));
	}

	scheduleRefresh(ctx, cfg, apiKey, key, myEpoch);
}

// ─── extension entry ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		await syncActivation(ctx);
	});

	// On model switch: re-check activation. If the new provider is still
	// supported we restore from cache and refresh; otherwise the widget stays
	// hidden. Either way the previous widget is cleared first.
	pi.on("model_select", async (_event, ctx) => {
		await syncActivation(ctx);
	});

	// After each tool call completes: nudge a refresh so the widget reflects
	// spend. The TTL cache inside refresh() prevents flooding the API.
	pi.on("tool_result", async (_event, ctx) => {
		const provider = ctx.model?.provider;
		const cfg = provider ? CONFIGS[provider] : undefined;
		if (!cfg || !provider) return;
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
		if (!apiKey) return;
		scheduleRefresh(ctx, cfg, apiKey, cacheKey(provider, apiKey), epoch);
	});

	const forceRefresh = async (_args: unknown, ctx: ExtensionContext) => {
		const provider = ctx.model?.provider;
		const cfg = provider ? CONFIGS[provider] : undefined;
		if (!cfg || !provider) {
			ctx.ui.notify("No quota monitor for the current provider", "warning");
			return;
		}
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
		if (!apiKey) {
			ctx.ui.notify(`No API key configured for ${provider}`, "warning");
			return;
		}
		const key = cacheKey(provider, apiKey);
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `${cfg.label} refreshing…`));
		await refresh(ctx, cfg, apiKey, key, epoch, true);
		ctx.ui.notify(`${cfg.label} quota refreshed`, "info");
	};

	pi.registerCommand("quota", {
		description: "Force-refresh the current provider's usage/balance in the footer",
		handler: forceRefresh,
	});

	// Backwards-compatible aliases for the old per-provider commands.
	for (const name of ["ds-balance", "glm-quota", "minimax-quota", "openai-codex-quota", "antigravity-quota"]) {
		pi.registerCommand(name, {
			description: `Force-refresh quota in the footer (alias of /quota)`,
			handler: forceRefresh,
		});
	}
}
