// glm-quota.ts — GLM Coding Plan quota monitor for the pi footer.
//
// Only activates when the active provider is `zai-coding-cn`. Stays invisible
// for every other provider so the footer is not polluted.
//
// API protocol reverse-engineered from deluo/glm-quota-line (MIT):
//   GET {baseUrl}/api/monitor/usage/quota/limit
//   Authorization: <glm api key>   (no Bearer prefix — Zhipu uses the raw key)
//   → { success, data: { level, limits: [{ type, number, usage, remaining,
//       currentValue, nextResetTime }, ...] } }
//
// type === "TOKENS_LIMIT"  → 5h / week token quota
// type === "MCP_LIMIT" / "TIME_LIMIT" → tool-call quota

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TARGET_PROVIDER = "zai-coding-cn";

// Zhipu has two endpoints. The Coding Plan (zai-coding-cn) always uses the CN
// one; the international endpoint (api.z.ai) is a different product. Keep both
// so the extension still works if someone adds an intl zai provider later.
const QUOTA_URLS = [
	"https://open.bigmodel.cn/api/monitor/usage/quota/limit",
	"https://api.z.ai/api/monitor/usage/quota/limit",
] as const;

const REQUEST_TIMEOUT_MS = 5000;

// Refresh TTL by remaining quota. High remaining → refresh slowly; low → fast
// so the warning color shows up in time. Mirrors the upstream bands.
const REFRESH_BANDS = [
	{ minLeftPercent: 80, ttlMs: 120_000 }, // 2 min
	{ minLeftPercent: 30, ttlMs: 300_000 }, // 5 min
	{ minLeftPercent: 0, ttlMs: 120_000 }, // 2 min
] as const;
const RATE_LIMIT_RETRY_TTL_MS = 180_000;
const UNAVAILABLE_RETRY_TTL_MS = 120_000;

const LOW_THRESHOLD = 30; // red below this
const MID_THRESHOLD = 60; // yellow below this

// Pace analysis thresholds. pace = actualUsed% / theoreticalUsed%.
// pace > DANGER → burning faster than sustainable, will exhaust before reset.
const PACE_WARN_THRESHOLD = 1.1;
const PACE_DANGER_THRESHOLD = 1.3;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// 5h token limit has a fixed 5-hour window. Used to detect it when the API
// doesn't expose `number: 5`.
const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;

interface QuotaState {
	kind: "success";
	level: string;
	leftPercent: number; // primary (5h)
	usedPercent: number;
	weekLeftPercent?: number;
	mcpLeftPercent?: number;
	nextResetTime?: number;
	// Full cycle boundaries so we can compute elapsed time even when only the
	// reset timestamp is returned.
	primaryCycleStart?: number;
	primaryCycleMs?: number;
	weekNextResetTime?: number;
	fetchedAt: number;
}

interface FailureState {
	kind: "rate_limited" | "unavailable" | "auth_error";
	at: number;
}

type CacheEntry =
	| { result: QuotaState; lastFailureKind?: string; savedAt: number; lastAttemptAt: number }
	| { result: FailureState; savedAt: number; lastAttemptAt: number };

// In-memory cache. Pi extensions are long-lived in a single process; a process
// restart just means one extra fetch. Keyed by api-key hash so switching keys
// (e.g. rotating) does not show stale data from the previous key.
const cache = new Map<string, CacheEntry>();
let activeFetch: Promise<void> | null = null;

const STATUS_KEY = "glm-quota";

// ─── helpers ──────────────────────────────────────────────────────────────────

function ttlFor(leftPercent: number | undefined): number {
	if (leftPercent === undefined) return REFRESH_BANDS[1].ttlMs;
	const band = REFRESH_BANDS.find((b) => leftPercent >= b.minLeftPercent);
	return band ? band.ttlMs : REFRESH_BANDS[REFRESH_BANDS.length - 1].ttlMs;
}

async function sha256Short(s: string): Promise<string> {
	// Node 22 has globalThis.crypto.subtle
	const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
	return hex.slice(0, 12);
}

function asFiniteNumber(v: unknown): number | null {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
	return Number.isFinite(n) ? n : null;
}

function clampPercent(n: number | null): number | null {
	if (n === null || !Number.isFinite(n)) return null;
	return Math.max(0, Math.min(100, Math.round(n)));
}

// Compute (leftPercent, usedPercent) from a limit object the same way the
// upstream parser does: prefer remaining+currentValue; fall back to usage;
// last resort the legacy `percentage` field.
function computePercentages(limit: any): { leftPercent: number; usedPercent: number } | null {
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

interface PrimaryInfo { leftPercent: number; nextResetTime?: number; cycleStart?: number; cycleMs?: number; }
interface ParsedQuota {
	kind: "success";
	level: string;
	primary: PrimaryInfo;
	week?: { leftPercent: number; nextResetTime?: number };
	mcp?: { leftPercent: number };
}

function parseQuota(body: any): ParsedQuota | { kind: "auth_error" | "rate_limited" | "unavailable" } {
	if (!body || typeof body !== "object") return { kind: "unavailable" };
	if (body.success !== true) {
		const code = body.code;
		const msg = typeof body.msg === "string" ? body.msg : "";
		if (code === 1001 || code === 401 || /authorization|auth|token/i.test(msg)) {
			return { kind: "auth_error" };
		}
		if (/rate\s*limit|too many requests|too frequent|frequency|限流|频率|过于频繁|稍后再试/i.test(msg)) {
			return { kind: "rate_limited" };
		}
		return { kind: "unavailable" };
	}

	const data = body.data ?? {};
	const level = typeof data.level === "string" ? data.level : "";
	const limits: any[] = Array.isArray(data.limits) ? data.limits : [];

	const tokenLimits = limits.filter((l) => l?.type === "TOKENS_LIMIT");
	if (tokenLimits.length === 0) return { kind: "unavailable" };

	// Pick 5h limit (number === 5) if present; otherwise the one with the
	// nearest reset. Week limit = the other one.
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

	const primaryPct = computePercentages(primary);
	if (!primaryPct) return { kind: "unavailable" };
	const nextResetTime = asFiniteNumber(primary?.nextResetTime) ?? undefined;

	// If this is the explicit 5h limit, we know the cycle length exactly.
	// Otherwise leave cycleMs undefined — renderStatus will fall back to a
	// window derived from the reset time heuristic.
	const isFiveHour = explicit5h !== null || primary?.number === 5;
	const primaryCycleMs = isFiveHour ? FIVE_HOUR_WINDOW_MS : undefined;
	const primaryCycleStart = (nextResetTime !== undefined && primaryCycleMs !== undefined)
		? nextResetTime - primaryCycleMs
		: undefined;

	const mcpLimit = limits.find((l) => l?.type === "MCP_LIMIT" || l?.type === "TIME_LIMIT");
	const mcpPct = mcpLimit ? computePercentages(mcpLimit) : null;
	const weekPct = week ? computePercentages(week) : null;
	const weekNextResetTime = week ? (asFiniteNumber(week?.nextResetTime) ?? undefined) : undefined;

	return {
		kind: "success",
		level,
		primary: {
			leftPercent: primaryPct.leftPercent,
			...(nextResetTime !== undefined ? { nextResetTime } : {}),
			...(primaryCycleStart !== undefined ? { cycleStart: primaryCycleStart } : {}),
			...(primaryCycleMs !== undefined ? { cycleMs: primaryCycleMs } : {}),
		},
		...(weekPct ? { week: { leftPercent: weekPct.leftPercent, ...(weekNextResetTime !== undefined ? { nextResetTime: weekNextResetTime } : {}) } } : {}),
		...(mcpPct ? { mcp: { leftPercent: mcpPct.leftPercent } } : {}),
	};
}

async function fetchQuotaOnce(apiKey: string, url: string): Promise<ParsedQuota | { kind: "auth_error" | "rate_limited" | "unavailable" }> {
	try {
		const res = await fetch(url, {
			method: "GET",
			headers: {
				Accept: "application/json, text/plain, */*",
				Authorization: apiKey,
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const text = await res.text();
		let json: any = null;
		try { json = JSON.parse(text); } catch {}
		if (res.status === 429) return { kind: "rate_limited" };
		return parseQuota(json);
	} catch {
		return { kind: "unavailable" };
	}
}

async function fetchQuota(apiKey: string): Promise<ParsedQuota | { kind: "auth_error" | "rate_limited" | "unavailable" }> {
	// Try the CN endpoint first (zai-coding-cn is the CN Coding Plan).
	for (const url of QUOTA_URLS) {
		const r = await fetchQuotaOnce(apiKey, url);
		// On auth_error, stop immediately — both endpoints share the key.
		// On unavailable, try the other endpoint before giving up.
		if (r.kind === "success" || r.kind === "rate_limited" || r.kind === "auth_error") return r;
	}
	return { kind: "unavailable" };
}

// ─── status formatting ────────────────────────────────────────────────────────

function bar(leftPercent: number, width = 10): string {
	const filled = Math.round((leftPercent / 100) * width);
	return "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, width - filled));
}

// ─── pace analysis ───────────────────────────────────────────────────────
// "Am I burning faster than a sustainable pace?"
// pace = actualUsedPercent / theoreticalUsedPercent
//   - theoreticalUsedPercent = fraction of the cycle that has already elapsed
//   - pace > 1 means you are ahead of schedule (will run out before reset)
//   - pace < 1 means you are under budget (sustainable)
//
// For the 5h token window the cycle length is a fixed 5 hours and we derive
// cycleStart = nextResetTime - 5h. For the weekly window the cycle is the
// natural 7-day week; theoretical usage reaches 100% at reset time.
interface PaceResult {
	pace: number;          // used% / theoretical%. 1.0 = exactly on pace
	theoreticalUsed: number; // % that should be used by now at a steady rate
	severity: "good" | "warn" | "danger" | "neutral";
}

function paceForFixedCycle(usedPercent: number, nextResetTime: number | undefined, cycleMs: number, now = Date.now()): PaceResult | null {
	if (!nextResetTime || !Number.isFinite(nextResetTime) || nextResetTime <= now) return null;
	const cycleStart = nextResetTime - cycleMs;
	if (cycleStart >= now) return null; // cycle hasn't started?
	const elapsed = now - cycleStart;
	const theoreticalUsed = (elapsed / cycleMs) * 100;
	if (theoreticalUsed <= 0) return null;
	const pace = usedPercent / theoreticalUsed;
	return { pace, theoreticalUsed, severity: paceSeverity(pace) };
}

function paceForWeek(usedPercent: number, nextResetTime: number | undefined, now = Date.now()): PaceResult | null {
	if (!nextResetTime || !Number.isFinite(nextResetTime) || nextResetTime <= now) return null;
	const periodStart = nextResetTime - WEEK_MS;
	if (now <= periodStart) return null;
	// Weekly quota is granted per natural 7-day week and weekend usage
	// counts against it, so use continuous elapsed time as the baseline.
	const elapsed = now - periodStart;
	const theoreticalUsed = (elapsed / WEEK_MS) * 100;
	if (theoreticalUsed <= 0) return null;
	const pace = usedPercent / theoreticalUsed;
	return { pace, theoreticalUsed, severity: paceSeverity(pace) };
}

function paceSeverity(pace: number): "good" | "warn" | "danger" {
	if (pace > PACE_DANGER_THRESHOLD) return "danger";
	if (pace > PACE_WARN_THRESHOLD) return "warn";
	return "good";
}

function paceSeverityColor(sev: "good" | "warn" | "danger" | "neutral"): "success" | "warning" | "error" | "dim" {
	if (sev === "danger") return "error";
	if (sev === "warn") return "warning";
	if (sev === "good") return "success";
	return "dim";
}

// Format pace as a compact "speed" indicator: e.g. "1.4×" (over budget) or
// "0.8×" (under budget). Also annotate whether ahead/behind.
function formatPace(p: PaceResult): string {
	const x = (Math.round(p.pace * 10) / 10).toFixed(1);
	return `${x}×`;
}

// pi theme uses semantic tokens: success / warning / error.
function colorFor(leftPercent: number): "success" | "warning" | "error" {
	if (leftPercent < LOW_THRESHOLD) return "error";
	if (leftPercent < MID_THRESHOLD) return "warning";
	return "success";
}

function formatReset(nextResetTime?: number): string {
	if (!nextResetTime || !Number.isFinite(nextResetTime)) return "";
	const ms = nextResetTime - Date.now();
	if (ms <= 0) return "";
	const mins = Math.round(ms / 60000);
	if (mins < 60) return `${mins}m`;
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	return `${h}h${m.toString().padStart(2, "0")}m`;
}

function renderStatus(state: QuotaState, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const lvl = state.level ? ` ${state.level}` : "";
	const primaryColor = colorFor(state.leftPercent);

	// Primary (5h) bar + pace annotation.
	let primarySeg = t.fg("dim", "GLM") + t.fg(primaryColor, `${lvl} ${bar(state.leftPercent)} ${state.leftPercent}%`);
	const primaryPace = (state.primaryCycleMs !== undefined)
		? paceForFixedCycle(100 - state.leftPercent, state.nextResetTime, state.primaryCycleMs)
		: null;
	if (primaryPace) {
		primarySeg += " " + t.fg(paceSeverityColor(primaryPace.severity), formatPace(primaryPace));
	}

	const parts: string[] = [primarySeg];

	if (state.weekLeftPercent !== undefined) {
		let weekSeg = t.fg(colorFor(state.weekLeftPercent), `W${bar(state.weekLeftPercent, 6)} ${state.weekLeftPercent}%`);
		const weekPace = paceForWeek(100 - state.weekLeftPercent, state.weekNextResetTime);
		if (weekPace) {
			weekSeg += " " + t.fg(paceSeverityColor(weekPace.severity), formatPace(weekPace));
		}
		parts.push(weekSeg);
	}

	if (state.mcpLeftPercent !== undefined) {
		parts.push(t.fg(colorFor(state.mcpLeftPercent), `MCP ${state.mcpLeftPercent}%`));
	}
	const reset = formatReset(state.nextResetTime);
	if (reset) parts.push(t.fg("dim", `reset ${reset}`));
	return parts.join(t.fg("dim", " | "));
}

function renderFailure(state: FailureState, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const label = state.kind === "auth_error" ? "auth error"
		: state.kind === "rate_limited" ? "quota limited"
		: "quota unavailable";
	return t.fg("dim", `GLM ${label}`);
}

// ─── core refresh logic ───────────────────────────────────────────────────────

async function refresh(ctx: ExtensionContext, apiKey: string, keyHash: string, force = false): Promise<void> {
	const now = Date.now();
	const entry = cache.get(keyHash);

	if (!force && entry) {
		const ttl = entry.result.kind === "rate_limited"
			? RATE_LIMIT_RETRY_TTL_MS
			: entry.result.kind === "unavailable" || entry.result.kind === "auth_error"
				? UNAVAILABLE_RETRY_TTL_MS
				: ttlFor((entry.result as QuotaState).leftPercent);
		if (entry.lastAttemptAt !== undefined && now - entry.lastAttemptAt < ttl) {
			// Cache still fresh — just re-render with current entry.
			if (entry.result.kind === "success") {
				ctx.ui.setStatus(STATUS_KEY, renderStatus(entry.result, ctx));
			} else {
				ctx.ui.setStatus(STATUS_KEY, renderFailure(entry.result, ctx));
			}
			return;
		}
	}

	const parsed = await fetchQuota(apiKey);
	if (parsed.kind === "success") {
		const state: QuotaState = {
			kind: "success",
			level: parsed.level,
			leftPercent: parsed.primary.leftPercent,
			usedPercent: 100 - parsed.primary.leftPercent,
			...(parsed.week ? { weekLeftPercent: parsed.week.leftPercent } : {}),
			...(parsed.mcp ? { mcpLeftPercent: parsed.mcp.leftPercent } : {}),
			...(parsed.primary.nextResetTime !== undefined ? { nextResetTime: parsed.primary.nextResetTime } : {}),
			...(parsed.primary.cycleStart !== undefined ? { primaryCycleStart: parsed.primary.cycleStart } : {}),
			...(parsed.primary.cycleMs !== undefined ? { primaryCycleMs: parsed.primary.cycleMs } : {}),
			...(parsed.week?.nextResetTime !== undefined ? { weekNextResetTime: parsed.week.nextResetTime } : {}),
			fetchedAt: now,
		};
		cache.set(keyHash, { result: state, savedAt: now, lastAttemptAt: now });
		ctx.ui.setStatus(STATUS_KEY, renderStatus(state, ctx));
	} else {
		const failure: FailureState = { kind: parsed.kind, at: now };
		cache.set(keyHash, { result: failure, savedAt: now, lastAttemptAt: now });
		ctx.ui.setStatus(STATUS_KEY, renderFailure(failure, ctx));
	}
}

// Debounce/coalesce: only one fetch in flight at a time per process.
async function scheduleRefresh(ctx: ExtensionContext, apiKey: string, keyHash: string, force = false): Promise<void> {
	if (activeFetch) return activeFetch;
	activeFetch = (async () => {
		try {
			await refresh(ctx, apiKey, keyHash, force);
		} finally {
			activeFetch = null;
		}
	})();
	return activeFetch;
}

// ─── activation guard ─────────────────────────────────────────────────────────

async function syncActivation(ctx: ExtensionContext): Promise<void> {
	const provider = ctx.model?.provider;
	if (provider !== TARGET_PROVIDER) {
		// Not GLM Coding Plan — stay invisible.
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
	if (!apiKey) {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "GLM no api key"));
		return;
	}

	const keyHash = await sha256Short(apiKey);
	await scheduleRefresh(ctx, apiKey, keyHash);
}

// ─── extension entry ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	// On session start: initial activation check + first fetch.
	pi.on("session_start", async (_event, ctx) => {
		await syncActivation(ctx);
	});

	// On model switch: re-check activation. If the new model is still GLM we
	// just re-render from cache (key unchanged); if it left GLM we hide.
	pi.on("model_select", async (_event, ctx) => {
		await syncActivation(ctx);
	});

	// After each tool call completes: refresh quota so the bar reflects usage.
	// The TTL cache inside refresh() prevents flooding the API.
	pi.on("tool_result", async (_event, ctx) => {
		const provider = ctx.model?.provider;
		if (provider !== TARGET_PROVIDER) return;
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
		if (!apiKey) return;
		const keyHash = await sha256Short(apiKey);
		// force=false so the TTL cache still applies — tool_result just nudges.
		await scheduleRefresh(ctx, apiKey, keyHash);
	});

	// Manual refresh command for when the user wants to bypass the TTL.
	pi.registerCommand("glm-quota", {
		description: "Force-refresh GLM Coding Plan quota in the footer",
		handler: async (_args, ctx) => {
			const provider = ctx.model?.provider;
			if (provider !== TARGET_PROVIDER) {
				ctx.ui.notify("GLM quota is only available for the zai-coding-cn provider", "warning");
				return;
			}
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
			if (!apiKey) {
				ctx.ui.notify("No API key configured for zai-coding-cn", "warning");
				return;
			}
			const keyHash = await sha256Short(apiKey);
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "GLM refreshing…"));
			await refresh(ctx, apiKey, keyHash, true);
			ctx.ui.notify("GLM quota refreshed", "info");
		},
	});
}
