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
import { asFiniteNumber, clampPercent, colorFor } from "../utils.ts";

const CB_DEFAULT_BASE = "https://copilot.tencent.com";
const CB_TIMEOUT_MS = 8000;
// Credits are a consumable pool, not a rolling window: a slow trickle is worth
// flagging long before it is actually empty.
const CB_LOW_THRESHOLD = 10;
const CB_MID_THRESHOLD = 25;
// The billing API reports an absolute credit balance and nothing else — no
// percentage, no spend-rate signal, no window that resets on a known schedule.
// There is therefore nothing to tier the poll on, so it runs on a flat
// interval rather than the percentage bands the other providers use.
//
// 60s is also what keeps the "X积分会在Yd内过期" countdown honest: that expiry
// moves as packs burn down, and it is the only time-sensitive number here.
const CB_TTL_MS = 60_000;

export interface CBPackage {
	code: string;
	unit: string;
	total: number;
	remain: number;
	used: number;
	frozen: number;
}

/** The soonest-to-vanish slice of the balance, and when it disappears. */
export interface CBExpiring {
	amount: number;
	at: number;
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
	/** Only the nearest expiring pack — the others are noise in a footer. */
	expiring?: CBExpiring;
}

export function codeBuddyBaseUrl(): string {
	const raw = process.env.CODEBUDDY_API_BASE ?? CB_DEFAULT_BASE;
	return raw.replace(/\/+$/, "");
}

export function codeBuddyTtlFor(_payload: unknown): number {
	return CB_TTL_MS;
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

/**
 * `detail` is the optional /billing/meter/get-user-resource response — a ~16KB
 * payload of per-package rows. The summary endpoint aggregates by package code
 * and carries no dates, so the expiry countdown can only come from here; every
 * failure mode is non-fatal.
 *
 * Credits burn earliest-expiry-first (per the product docs), so the row with the
 * soonest boundary is the one worth warning about — it is the slice that will
 * silently vanish if it is not spent in time. Every other pack is dropped.
 *
 * `ExpiredTime` is authoritative when set; otherwise the pack's billing cycle
 * end is used, since base/bonus credits are issued per month and do not roll
 * over. In practice ExpiredTime is usually empty and CycleEndTime is the real
 * signal, but the former should win if it ever appears.
 */
export function parseCodeBuddyExpiring(detail: any, now = Date.now()): CBExpiring | undefined {
	const rows = detail?.data?.Response?.Data?.Accounts;
	if (!Array.isArray(rows)) return undefined;

	let best: CBExpiring | undefined;
	for (const row of rows) {
		// Nothing to warn about in a pack that is already drained.
		const remain = asFiniteNumber(row?.CapacityRemain) ?? 0;
		if (remain <= 0) continue;

		const at = cbCycleMs(row?.ExpiredTime) ?? cbCycleMs(row?.CycleEndTime);
		if (at === undefined || at <= now) continue;

		if (!best || at < best.at) best = { amount: remain, at };
	}
	return best;
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
	const expiring = parseCodeBuddyExpiring(detail, now);

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
			...(expiring ? { expiring } : {}),
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

// Credits are a pool, not a window: show the absolute balance, the way DS
// shows an absolute ¥ balance rather than a percentage of some arbitrary cap.
// There is no API-provided total worth bar-ing against, so the number stands
// alone.
function formatCredits(value: number): string {
	if (value >= 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value >= 100) return String(Math.round(value));
	if (Number.isInteger(value)) return String(value);
	return value.toFixed(value < 10 ? 1 : 0);
}

const CB_DAY_MS = 24 * 60 * 60 * 1000;
// Past this the countdown stops being a prompt to spend and starts being noise.
const CB_EXPIRY_HORIZON_DAYS = 45;

export function renderCodeBuddy(payload: unknown, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const state = payload as CBPayload;
	const color = colorFor(state.leftPercent, CB_LOW_THRESHOLD, CB_MID_THRESHOLD);

	const parts: string[] = [
		t.fg("dim", "CB") +
			(state.plan ? t.fg("dim", ` ${state.plan}`) : "") +
			" " +
			t.fg(color, `${formatCredits(state.remain)} ${state.unit === "credits" ? "cr" : state.unit}`),
	];

	// Only the soonest pack. Credits burn earliest-expiry-first, so this is the
	// slice that is actually at risk — the rest would just crowd the footer.
	if (state.expiring) {
		const days = Math.ceil((state.expiring.at - Date.now()) / CB_DAY_MS);
		if (days > 0 && days <= CB_EXPIRY_HORIZON_DAYS) {
			// Tighten the colour as the date closes in, not as the pool drains:
			// a 500-credit pack about to evaporate is the urgent case.
			const urgency = days <= 3 ? "error" : days <= 7 ? "warning" : "dim";
			parts.push(t.fg(urgency, `${formatCredits(state.expiring.amount)}积分会在${days}d内过期`));
		}
	}

	return parts.join(t.fg("dim", " | "));
}

export const codeBuddyProviderConfig: ProviderConfig = {
	label: "CB",
	unavailableWord: "credits",
	noKeyLabel: "no login",
	fetch: fetchCodeBuddyQuota,
	render: renderCodeBuddy,
	ttlFor: codeBuddyTtlFor,
};