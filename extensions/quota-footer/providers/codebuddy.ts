// CodeBuddy (腾讯) credits monitor — 积分余额.
//
// The CLI has no quota endpoint of its own: `codebuddy` reports credits
// *spent* per turn (`usage.credit`) and enforces the cap server-side via HTTP
// 429 + business codes (14001 UsageLimitExceeded, 14016 NotActivated, ...).
// The remaining balance is only ever exposed by the web console, which reads
// it from POST /billing/meter/get-user-resource-summary.
//
// That endpoint needs nothing but the OAuth access token, which is exactly
// what the quota footer already hands us as `apiKey` — no X-User-Id /
// X-Domain side-channel required.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FetchResult, ProviderConfig } from "../types.ts";
import { asFiniteNumber, bar, clampPercent, colorFor, formatReset } from "../utils.ts";

const CB_DEFAULT_BASE = "https://copilot.tencent.com";
const CB_TIMEOUT_MS = 8000;
// Credits are a consumable pool, not a rolling window: a slow trickle is worth
// flagging long before it is actually empty.
const CB_LOW_THRESHOLD = 10;
const CB_MID_THRESHOLD = 25;
const CB_REFRESH_BANDS = [
	{ minLeftPercent: 50, ttlMs: 300_000 },
	{ minLeftPercent: 20, ttlMs: 120_000 },
	{ minLeftPercent: 0, ttlMs: 60_000 },
] as const;
// A cycle boundary can also be crossed by wall-clock alone, so never cache
// longer than this regardless of how healthy the balance looks.
const CB_MAX_TTL_MS = 600_000;

export interface CBPackage {
	code: string;
	unit: string;
	total: number;
	remain: number;
	used: number;
	frozen: number;
}

export interface CBPayload {
	plan?: string;
	paid: boolean;
	unit: string;
	total: number;
	remain: number;
	used: number;
	frozen: number;
	leftPercent: number;
	packages: CBPackage[];
	/** End of the current billing cycle — the earliest one still ahead of us. */
	resetAt?: number;
}

export function codeBuddyBaseUrl(): string {
	const raw = process.env.CODEBUDDY_API_BASE ?? CB_DEFAULT_BASE;
	return raw.replace(/\/+$/, "");
}

export function codeBuddyTtlFor(payload: unknown): number {
	const left = (payload as CBPayload).leftPercent;
	const band = CB_REFRESH_BANDS.find((b) => left >= b.minLeftPercent);
	const ttl = band ? band.ttlMs : CB_REFRESH_BANDS[CB_REFRESH_BANDS.length - 1].ttlMs;
	return Math.min(ttl, CB_MAX_TTL_MS);
}

// "2026-10-31 23:59:59" is Asia/Shanghai wall time with no offset attached.
// Date.parse() would read it in the *process* timezone (UTC+2 on this box, a
// 6h error), so pin the zone explicitly.
export function cbCycleMs(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
	if (!match) return undefined;
	const [, y, mo, d, h, mi, s] = match;
	const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`);
	return Number.isFinite(ms) ? ms : undefined;
}

export function parseCodeBuddyPackage(raw: any): CBPackage | null {
	const total = asFiniteNumber(raw?.CycleTotalCapacity);
	const rawRemain = asFiniteNumber(raw?.CycleRemainCapacity);
	const used = asFiniteNumber(raw?.CycleUsedCapacity);
	const frozen = asFiniteNumber(raw?.CycleFrozenCapacity) ?? 0;
	if (total === null && rawRemain === null) return null;
	// A package can be frozen (reserved but not yet deducted). Count it as
	// spent — but only inside that same package's capacity, and only when the
	// numbers stay consistent, otherwise a malformed row would go negative.
	const hold = total !== null && total > 0 && frozen > 0 && (rawRemain ?? 0) + frozen <= total ? frozen : 0;
	return {
		code: typeof raw?.PackageCode === "string" ? raw.PackageCode : "",
		unit: typeof raw?.CapacityUnit === "string" && raw.CapacityUnit ? raw.CapacityUnit : "credits",
		total: total ?? 0,
		remain: Math.max(0, (rawRemain ?? 0) - hold),
		used: used ?? 0,
		frozen: hold,
	};
}

// Promotional / top-up packs carry their own sub-product code and roll over on
// their own schedule. Their boundary is not the reset the footer should show.
const CB_BONUS_PACK = /bonus|addon|pack|campaign|growth/i;

/**
 * `detail` is the optional /billing/meter/get-user-resource response — a ~16KB
 * payload of per-package rows that contributes only the cycle boundary, so
 * every failure mode here is non-fatal.
 *
 * A free account has `SubscriptionPackageCode: ""`, and its balance is spread
 * over one subscription pool plus a pile of promo packs that each expire on
 * their own clock. Picking the *nearest* boundary (the obvious reading) then
 * reports a promo rollover instead of the monthly refill the user cares about,
 * so prefer the subscription pool explicitly.
 */
export function parseCodeBuddyResetAt(detail: any, subscriptionCode?: unknown, now = Date.now()): number | undefined {
	const rows = detail?.data?.Response?.Data?.Accounts;
	if (!Array.isArray(rows)) return undefined;

	const code = typeof subscriptionCode === "string" ? subscriptionCode : "";
	const cycleEnd = (row: any) => cbCycleMs(row?.CycleEndTime);
	// Status 0 is active; spent/expired packs are history.
	const active = rows.filter((r: any) => r?.Status === undefined || r.Status === 0);

	const pick = (pool: any[]): number | undefined => {
		let best: number | undefined;
		for (const row of pool) {
			const at = cycleEnd(row);
			if (at !== undefined && at > now && (best === undefined || at < best)) best = at;
		}
		return best;
	};

	// 1. Exact match on the package code the summary calls the subscription.
	if (code) {
		const exact = pick(active.filter((r: any) => r?.PackageCode === code));
		if (exact !== undefined) return exact;
	}
	// 2. The main pool: any active row that is not a promo pack.
	const subscription = pick(active.filter((r: any) => typeof r?.SubProductCode !== "string" || !CB_BONUS_PACK.test(r.SubProductCode)));
	if (subscription !== undefined) return subscription;
	// 3. Largest active pool — a fallback for account shapes we have not seen.
	const largest = [...active].sort((a: any, b: any) => (asFiniteNumber(b?.CapacitySize) ?? 0) - (asFiniteNumber(a?.CapacitySize) ?? 0))[0];
	if (largest) {
		const at = cycleEnd(largest);
		if (at !== undefined && at > now) return at;
	}
	// 4. Anything still in the future beats showing no reset at all.
	return pick(rows);
}

export function parseCodeBuddyQuota(summary: any, detail?: any, now = Date.now()): FetchResult {
	if (!summary || typeof summary !== "object") return { kind: "unavailable", at: now };

	if (summary.code !== 0) {
		const msg = typeof summary.msg === "string" ? summary.msg : "";
		if (summary.code === 401 || summary.code === 403 || /token|auth|登录|未授权|unauthor/i.test(msg)) {
			return { kind: "auth_error", at: now };
		}
		if (summary.code === 429 || /rate\s*limit|too many|频繁|限流/i.test(msg)) {
			return { kind: "rate_limited", at: now };
		}
		return { kind: "unavailable", at: now };
	}

	const data = summary.data;
	if (!data || typeof data !== "object") return { kind: "unavailable", at: now };

	const rawPackages = Array.isArray(data.Packages) ? data.Packages : [];
	const packages = (rawPackages as any[]).map(parseCodeBuddyPackage).filter((p): p is CBPackage => p !== null);
	if (packages.length === 0) return { kind: "unavailable", at: now };

	let total = 0;
	let remain = 0;
	let used = 0;
	let frozen = 0;
	let unit = "credits";
	for (const p of packages) {
		total += p.total;
		remain += p.remain;
		used += p.used;
		frozen += p.frozen;
		if (p.unit) unit = p.unit;
	}

	if (total <= 0) return { kind: "unavailable", at: now };
	const leftPercent = clampPercent((remain / total) * 100);
	if (leftPercent === null) return { kind: "unavailable", at: now };

	const plan =
		typeof data.SubscriptionPackageName === "string" && data.SubscriptionPackageName.trim()
			? data.SubscriptionPackageName.trim()
			: undefined;
	const resetAt = parseCodeBuddyResetAt(detail, data.SubscriptionPackageCode, now);

	return {
		kind: "success",
		fetchedAt: now,
		payload: {
			...(plan ? { plan } : {}),
			paid: data.IsPaidUser === true,
			unit,
			total,
			remain,
			used,
			frozen,
			leftPercent,
			packages,
			...(resetAt !== undefined ? { resetAt } : {}),
		},
	};
}

async function postJson(path: string, apiKey: string): Promise<{ status: number; json: any }> {
	const res = await fetch(`${codeBuddyBaseUrl()}${path}`, {
		method: "POST",
		headers: {
			Accept: "application/json, text/plain, */*",
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: "{}",
		signal: AbortSignal.timeout(CB_TIMEOUT_MS),
	});
	const text = await res.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {}
	return { status: res.status, json };
}

export async function fetchCodeBuddyQuota(apiKey: string): Promise<FetchResult> {
	let summary: { status: number; json: any };
	try {
		summary = await postJson("/billing/meter/get-user-resource-summary", apiKey);
	} catch {
		return { kind: "unavailable", at: Date.now() };
	}

	// The detail call only adds the cycle boundary. Run it alongside the
	// summary, but never let it fail the whole refresh.
	const detail = await postJson("/billing/meter/get-user-resource", apiKey).catch(() => null);

	const parsed = parseCodeBuddyQuota(summary.json, detail?.json);
	if (parsed.kind === "success") return parsed;

	// Nothing usable — classify from the HTTP status as a fallback, since a 401
	// can come back with a body the parser cannot read.
	if (summary.status === 401 || summary.status === 403) return { kind: "auth_error", at: Date.now() };
	if (summary.status === 429) return { kind: "rate_limited", at: Date.now() };
	return { kind: "unavailable", at: Date.now() };
}

// Credits are a pool, not a window: show the absolute balance too, otherwise a
// 90% bar on a 12-credit account reads as "plenty left".
function formatCredits(value: number): string {
	if (value >= 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value >= 100) return String(Math.round(value));
	if (Number.isInteger(value)) return String(value);
	return value.toFixed(value < 10 ? 1 : 0);
}

export function renderCodeBuddy(payload: unknown, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const state = payload as CBPayload;
	const color = colorFor(state.leftPercent, CB_LOW_THRESHOLD, CB_MID_THRESHOLD);

	const label = t.fg("dim", "CB") + (state.plan ? t.fg("dim", ` ${state.plan}`) : "");
	const barSeg = t.fg(color, `${bar(state.leftPercent, 10)} ${state.leftPercent}%`);
	const amountSeg = t.fg(
		color,
		`${formatCredits(state.remain)}/${formatCredits(state.total)} ${state.unit === "credits" ? "cr" : state.unit}`,
	);

	const parts = [label, barSeg, amountSeg];
	if (state.resetAt !== undefined) {
		const reset = formatReset(state.resetAt - Date.now());
		if (reset) parts.push(t.fg("dim", `reset ${reset}`));
	}
	// A free account that is about to expire is worth surfacing even mid-pool.
	if (!state.paid && state.leftPercent > CB_MID_THRESHOLD) parts.push(t.fg("dim", "free"));

	return parts.join(t.fg("dim", " | "));
}

export const codeBuddyProviderConfig: ProviderConfig = {
	label: "CB",
	unavailableWord: "credits",
	noKeyLabel: "no login",
	fetch: fetchCodeBuddyQuota,
	render: renderCodeBuddy,
	ttlFor: codeBuddyTtlFor,
	extractWeekQuota: (payload: unknown) => {
		const state = payload as CBPayload;
		// The billing cycle is monthly, not weekly — history keyed on the same
		// reset boundary still charts the real spend-down, so reuse the hook.
		if (state.resetAt === undefined) return null;
		return { leftPercent: state.leftPercent, resetAt: state.resetAt };
	},
};