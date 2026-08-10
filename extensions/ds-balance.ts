// ds-balance.ts — DeepSeek API account balance monitor for the pi footer.
//
// Only activates when the active provider is `deepseek`. Stays invisible for
// every other provider so the footer is not polluted.
//
// Endpoint (official DeepSeek API docs, "查询余额"):
//   GET {baseUrl}/user/balance
//   Authorization: Bearer <api key>
//   → { is_available, balance_infos: [
//        { currency: "CNY"|"USD", total_balance, granted_balance,
//          topped_up_balance }, ... ] }
//
// Unlike GLM (token quota), DeepSeek's only limiter is the monetary balance, so
// the footer shows the remaining balance with a color band:
//   red below LOW_THRESHOLD, yellow below MID_THRESHOLD, green otherwise.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TARGET_PROVIDER = "deepseek";

// DeepSeek has only one API host for the CN platform used by the `deepseek`
// provider. Keep the list so swapping/adding a regional endpoint later is easy.
const BALANCE_URLS = [
	"https://api.deepseek.com/user/balance",
] as const;

const REQUEST_TIMEOUT_MS = 5000;

// Refresh TTL by remaining balance (CNY). High balance → refresh slowly; low
// → fast (1 min) so the warning color shows up in time before you run out.
const REFRESH_BANDS = [
	{ minLeft: 10, ttlMs: 300_000 }, // ≥ ¥10 → 5 min
	{ minLeft: 0, ttlMs: 60_000 }, // < ¥10 → 1 min
] as const;
const RATE_LIMIT_RETRY_TTL_MS = 180_000;
const UNAVAILABLE_RETRY_TTL_MS = 120_000;

// Balance thresholds in CNY (the currency DeepSeek bills on the CN platform).
// Red below LOW → you may run out mid-session; yellow below MID → keep an eye.
const LOW_THRESHOLD_CNY = 1.0;
const MID_THRESHOLD_CNY = 3.0;

// Currency symbol mapping.
const CURRENCY_SYMBOL: Record<string, string> = {
	CNY: "¥",
	USD: "$",
};

interface BalanceState {
	kind: "success";
	currency: string;
	symbol: string;
	total: number;        // total available balance
	granted: number;      // granted (unexpired bonus) balance
	toppedUp: number;     // topped-up (recharge) balance
	available: boolean;   // is_available flag from the API
	fetchedAt: number;
}

interface FailureState {
	kind: "rate_limited" | "unavailable" | "auth_error";
	at: number;
}

type CacheEntry =
	| { result: BalanceState; lastFailureKind?: string; savedAt: number; lastAttemptAt: number }
	| { result: FailureState; savedAt: number; lastAttemptAt: number };

// In-memory cache. Keyed by api-key hash so switching keys does not show stale data.
const cache = new Map<string, CacheEntry>();
let activeFetch: Promise<void> | null = null;

const STATUS_KEY = "ds-balance";

// ─── helpers ──────────────────────────────────────────────────────────────────

function ttlFor(total: number | undefined): number {
	if (total === undefined) return REFRESH_BANDS[1].ttlMs;
	const band = REFRESH_BANDS.find((b) => total >= b.minLeft);
	return band ? band.ttlMs : REFRESH_BANDS[REFRESH_BANDS.length - 1].ttlMs;
}

async function sha256Short(s: string): Promise<string> {
	const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
	return hex.slice(0, 12);
}

function asFiniteNumber(v: unknown): number | null {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
	return Number.isFinite(n) ? n : null;
}

// Parse the DeepSeek /user/balance response.
function parseBalance(body: any): BalanceState | { kind: "auth_error" | "rate_limited" | "unavailable" } {
	if (!body || typeof body !== "object") return { kind: "unavailable" };

	// DeepSeek may return an error object/message on failure.
	const msg = typeof body.message === "string" ? body.message
		: typeof body.msg === "string" ? body.msg
		: typeof body.error === "string" ? body.error : "";
	if (/Authorization|authentication|auth|token|Bearer/i.test(msg)) {
		return { kind: "auth_error" };
	}
	if (/rate\s*limit|too many|429/i.test(msg)) {
		return { kind: "rate_limited" };
	}

	const infos: any[] = Array.isArray(body.balance_infos) ? body.balance_infos : [];
	if (infos.length === 0) return { kind: "unavailable" };

	// Prefer CNY (the CN platform default), fall back to the first entry.
	const info = infos.find((i) => i?.currency === "CNY") ?? infos[0];
	const currency = typeof info?.currency === "string" ? info.currency : "CNY";

	const total = asFiniteNumber(info?.total_balance);
	if (total === null) return { kind: "unavailable" };

	return {
		kind: "success",
		currency,
		symbol: CURRENCY_SYMBOL[currency] ?? (currency === "USD" ? "$" : "¥"),
		total,
		granted: asFiniteNumber(info?.granted_balance) ?? 0,
		toppedUp: asFiniteNumber(info?.topped_up_balance) ?? 0,
		available: body.is_available !== false,
		fetchedAt: Date.now(),
	};
}

async function fetchBalanceOnce(apiKey: string, url: string): Promise<BalanceState | { kind: "auth_error" | "rate_limited" | "unavailable" }> {
	try {
		const res = await fetch(url, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const text = await res.text();
		let json: any = null;
		try { json = JSON.parse(text); } catch {}
		if (res.status === 401 || res.status === 403) return { kind: "auth_error" };
		if (res.status === 429) return { kind: "rate_limited" };
		return parseBalance(json);
	} catch {
		return { kind: "unavailable" };
	}
}

async function fetchBalance(apiKey: string): Promise<BalanceState | { kind: "auth_error" | "rate_limited" | "unavailable" }> {
	for (const url of BALANCE_URLS) {
		const r = await fetchBalanceOnce(apiKey, url);
		if (r.kind === "success" || r.kind === "rate_limited" || r.kind === "auth_error") return r;
	}
	return { kind: "unavailable" };
}

// ─── status formatting ────────────────────────────────────────────────────────

// Monetary thresholds are denominated in CNY. For USD, scale roughly to avoid
// treating $1 as critically low — use a 1:1 mapping since DeepSeek USD pricing
// tracks CNY. This keeps thresholds simple across currencies.
function colorFor(total: number, currency: string): "success" | "warning" | "error" {
	if (total < LOW_THRESHOLD_CNY) return "error";
	if (total < MID_THRESHOLD_CNY) return "warning";
	return "success";
}

function fmtAmount(total: number, currency: string): string {
	const digits = total >= 100 ? 0 : total >= 1 ? 2 : 2;
	const suffix = total >= 10000 ? "k" : "";
	const value = suffix ? total / 1000 : total;
	return `${value.toFixed(digits)}${suffix}`;
}

function bar(leftPercent: number, width = 10): string {
	const filled = Math.round((leftPercent / 100) * width);
	return "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, width - filled));
}

function renderStatus(state: BalanceState, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const sym = state.symbol ?? "¥";

	// DeepSeek returns an absolute balance rather than a percentage. Use ¥50 as
	// the full-bar reference so the bar communicates the remaining balance scale.
	const fillPercent = Math.max(0, Math.min(100, (state.total / 50) * 100));
	const balanceColor = colorFor(state.total, state.currency);
	const seg = t.fg("dim", "DS") + " "
		+ t.fg(balanceColor, bar(fillPercent)) + " "
		+ t.fg(balanceColor, `${sym}${fmtAmount(state.total, state.currency)}`);

	const parts: string[] = [seg];

	// Show granted (bonus) balance separately if nonzero — it burns down first.
	if (state.granted > 0) {
		parts.push(t.fg("dim", `g${sym}${fmtAmount(state.granted, state.currency)}`));
	}

	// Mark when the account is flagged unavailable (no balance left to spend).
	if (!state.available && state.total <= 0) {
		parts.push(t.fg("error", "no balance"));
	}

	return parts.join(t.fg("dim", " "));
}

function renderFailure(state: FailureState, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const label = state.kind === "auth_error" ? "auth error"
		: state.kind === "rate_limited" ? "rate limited"
		: "balance unavailable";
	return t.fg("dim", `DS ${label}`);
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
				: ttlFor((entry.result as BalanceState).total);
		if (entry.lastAttemptAt !== undefined && now - entry.lastAttemptAt < ttl) {
			if (entry.result.kind === "success") {
				ctx.ui.setStatus(STATUS_KEY, renderStatus(entry.result, ctx));
			} else {
				ctx.ui.setStatus(STATUS_KEY, renderFailure(entry.result, ctx));
			}
			return;
		}
	}

	const parsed = await fetchBalance(apiKey);
	if (parsed.kind === "success") {
		parsed.fetchedAt = now;
		cache.set(keyHash, { result: parsed, savedAt: now, lastAttemptAt: now });
		ctx.ui.setStatus(STATUS_KEY, renderStatus(parsed, ctx));
	} else {
		const failure: FailureState = { kind: parsed.kind, at: now };
		cache.set(keyHash, { result: failure, savedAt: now, lastAttemptAt: now });
		ctx.ui.setStatus(STATUS_KEY, renderFailure(failure, ctx));
	}
}

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
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
	if (!apiKey) {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "DS no api key"));
		return;
	}

	const keyHash = await sha256Short(apiKey);
	await scheduleRefresh(ctx, apiKey, keyHash);
}

// ─── extension entry ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		await syncActivation(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		await syncActivation(ctx);
	});

	// After each tool call completes: nudge a refresh so the balance reflects
	// spend. The TTL cache inside refresh() prevents flooding the API.
	pi.on("tool_result", async (_event, ctx) => {
		const provider = ctx.model?.provider;
		if (provider !== TARGET_PROVIDER) return;
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
		if (!apiKey) return;
		const keyHash = await sha256Short(apiKey);
		await scheduleRefresh(ctx, apiKey, keyHash);
	});

	pi.registerCommand("ds-balance", {
		description: "Force-refresh DeepSeek account balance in the footer",
		handler: async (_args, ctx) => {
			const provider = ctx.model?.provider;
			if (provider !== TARGET_PROVIDER) {
				ctx.ui.notify("DeepSeek balance is only available for the deepseek provider", "warning");
				return;
			}
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
			if (!apiKey) {
				ctx.ui.notify("No API key configured for deepseek", "warning");
				return;
			}
			const keyHash = await sha256Short(apiKey);
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "DS refreshing…"));
			await refresh(ctx, apiKey, keyHash, true);
			ctx.ui.notify("DeepSeek balance refreshed", "info");
		},
	});
}
