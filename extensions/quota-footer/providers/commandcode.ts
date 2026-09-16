import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FetchResult, ProviderConfig } from "../types.ts";
import {
	asFiniteNumber,
	bar,
	calcDelta,
	clampPercent,
	colorFor,
	deltaColor,
	FIVE_HOUR_WINDOW_MS,
	formatReset,
	WEEK_MS,
} from "../utils.ts";

const CC_DEFAULT_BASE = "https://api.commandcode.ai";
const CC_TIMEOUT_MS = 8000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Monthly credits die with the billing period; warn once the end is close.
const CC_EXPIRY_WARN_DAYS = 3;
const CC_LOW_THRESHOLD = 20;
const CC_MID_THRESHOLD = 50;
const CC_CREDIT_LOW = 1;
const CC_CREDIT_MID = 3;
const CC_REFRESH_BANDS = [
	{ minLeft: 50, ttlMs: 120_000 },
	{ minLeft: 20, ttlMs: 60_000 },
	{ minLeft: 0, ttlMs: 30_000 },
] as const;

export interface CCWindow {
	used: number;
	cap: number;
	usedPercent: number;
	leftPercent: number;
	cycleMs: number;
	resetAt?: number;
	exceeded: boolean;
}

export interface CCPayload {
	plan?: string;
	status?: string;
	remaining?: number;
	/** The monthly allotment inside `remaining`; the part that expires. */
	monthlyRemaining?: number;
	/** End of the current billing period: when `monthlyRemaining` expires. */
	expiresAt?: number;
	fiveHour?: CCWindow;
	weekly?: CCWindow;
}

export function commandCodeBaseUrl(): string {
	const raw = process.env.COMMANDCODE_API_BASE ?? `${CC_DEFAULT_BASE}/provider/v1`;
	return raw.replace(/\/provider\/v1\/?$/, "").replace(/\/+$/, "");
}

export function commandCodeTtlFor(payload: unknown): number {
	const state = payload as CCPayload;
	const left = Math.min(state.fiveHour?.leftPercent ?? 100, state.weekly?.leftPercent ?? 100);
	return CC_REFRESH_BANDS.find((b) => left >= b.minLeft)?.ttlMs ?? 30_000;
}

// The API reports resetAt in ms, but accept seconds (and ISO strings) too.
export function ccResetAtMs(value: unknown): number | undefined {
	let n = asFiniteNumber(value);
	if (n === null && typeof value === "string") {
		const parsed = Date.parse(value);
		n = Number.isFinite(parsed) ? parsed : null;
	}
	if (n === null || n <= 0) return undefined;
	return n >= 1e12 ? n : n * 1000;
}

export function parseCCWindow(raw: any, cycleMs: number): CCWindow | null {
	const used = asFiniteNumber(raw?.used);
	const cap = asFiniteNumber(raw?.cap);
	if (used === null || cap === null || cap <= 0) return null;
	const usedPercent = clampPercent((used / cap) * 100) ?? 0;
	const resetAt = ccResetAtMs(raw?.resetAt);
	return {
		used,
		cap,
		usedPercent,
		leftPercent: 100 - usedPercent,
		cycleMs,
		...(resetAt !== undefined ? { resetAt } : {}),
		exceeded: raw?.exceeded === true,
	};
}

// "individual-go" → "go" — the footer only has room for the tier suffix.
export function shortCCPlan(planId: string): string {
	const parts = planId.split(/[-_\s]+/).filter(Boolean);
	return (parts.length > 0 ? parts[parts.length - 1] : planId).toLowerCase();
}

export function parseCommandCodeQuota(body: any, subscription: any): FetchResult {
	if (!body || typeof body !== "object") return { kind: "unavailable", at: Date.now() };

	const credits = body.credits;
	const windowLimits = body.windowLimits;
	const fiveHour = parseCCWindow(windowLimits?.fiveHour, FIVE_HOUR_WINDOW_MS);
	const weekly = parseCCWindow(windowLimits?.weekly, WEEK_MS);

	let remaining: number | undefined;
	let monthlyRemaining: number | undefined;
	if (credits && typeof credits === "object") {
		const monthly = asFiniteNumber(credits.monthlyCredits);
		const purchased = asFiniteNumber(credits.purchasedCredits);
		const free = asFiniteNumber(credits.freeCredits);
		if (monthly !== null || purchased !== null || free !== null) {
			remaining = (monthly ?? 0) + (purchased ?? 0) + (free ?? 0);
		}
		// Only the monthly slice dies at period end; purchased credits carry over.
		if (monthly !== null) monthlyRemaining = monthly;
	}

	if (!fiveHour && !weekly && remaining === undefined) {
		return { kind: "unavailable", at: Date.now() };
	}

	const planId = typeof subscription?.planId === "string" ? subscription.planId : undefined;
	// currentPeriodStart/currentPeriodEnd split the monthly allotment; the end is
	// the moment any unspent monthly credits disappear.
	const expiresAt = ccResetAtMs(subscription?.currentPeriodEnd);
	return {
		kind: "success",
		fetchedAt: Date.now(),
		payload: {
			...(planId ? { plan: shortCCPlan(planId) } : {}),
			...(typeof subscription?.status === "string" ? { status: subscription.status } : {}),
			...(remaining !== undefined ? { remaining } : {}),
			...(monthlyRemaining !== undefined ? { monthlyRemaining } : {}),
			...(expiresAt !== undefined ? { expiresAt } : {}),
			...(fiveHour ? { fiveHour } : {}),
			...(weekly ? { weekly } : {}),
		},
	};
}

export async function fetchCommandCodeQuota(apiKey: string): Promise<FetchResult> {
	const base = commandCodeBaseUrl();
	const headers = { Accept: "application/json", Authorization: `Bearer ${apiKey}` };

	const get = async (path: string): Promise<{ status: number; json: any }> => {
		const res = await fetch(`${base}${path}`, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(CC_TIMEOUT_MS),
		});
		const text = await res.text();
		let json: any = null;
		try {
			json = JSON.parse(text);
		} catch {}
		return { status: res.status, json };
	};

	try {
		const [whoami, initialCredits, initialSubscription] = await Promise.all([
			get("/alpha/whoami").catch(() => null),
			get("/alpha/billing/credits").catch(() => null),
			get("/alpha/billing/subscriptions").catch(() => null),
		]);

		if (!whoami && !initialCredits && !initialSubscription) {
			return { kind: "unavailable", at: Date.now() };
		}

		let credits = initialCredits;
		let subscription = initialSubscription;

		// Org-scoped accounts need ?orgId=; retry once when every unscoped call was rejected.
		const orgId = typeof whoami?.json?.org?.id === "string" ? whoami.json.org.id : undefined;
		const rejected = (res: { status: number } | null) => res === null || res.status >= 400;
		if (orgId && rejected(credits) && rejected(subscription)) {
			const query = `?orgId=${encodeURIComponent(orgId)}`;
			[credits, subscription] = await Promise.all([
				get(`/alpha/billing/credits${query}`).catch(() => null),
				get(`/alpha/billing/subscriptions${query}`).catch(() => null),
			]);
		}

		const parsed = parseCommandCodeQuota(credits?.json, subscription?.json?.data);
		if (parsed.kind === "success") return parsed;

		// Nothing usable — classify from the HTTP statuses.
		const status = credits?.status ?? subscription?.status ?? whoami?.status ?? 0;
		if (status === 401 || status === 403) return { kind: "auth_error", at: Date.now() };
		if (status === 429) return { kind: "rate_limited", at: Date.now() };
		return { kind: "unavailable", at: Date.now() };
	} catch {
		return { kind: "unavailable", at: Date.now() };
	}
}

// delta = theoreticalUsedTime - elapsed; > 0 means burning faster than the window allows.
export function ccDelta(
	window: CCWindow,
	now = Date.now(),
): { text: string; severity: "good" | "warn" | "danger" } | null {
	if (window.resetAt === undefined || window.cycleMs <= 0) return null;
	const cycleStart = window.resetAt - window.cycleMs;
	const elapsed = now - cycleStart;
	if (elapsed <= 0 || elapsed >= window.cycleMs) return null;
	// One percent of the window is the finest signal the API reports; while a
	// single percent still spans more time than has elapsed, the delta would be
	// pure rounding noise (a fresh weekly window would read "+2h" after 4 min).
	if (window.cycleMs / 100 > elapsed) return null;
	return calcDelta(window.usedPercent, window.cycleMs, elapsed);
}

export function renderCCWindow(
	label: string,
	window: CCWindow,
	ctx: ExtensionContext,
	width: number,
	showReset: boolean,
): string {
	const t = ctx.ui.theme;
	const quotaColor = colorFor(window.leftPercent, CC_LOW_THRESHOLD, CC_MID_THRESHOLD);
	let seg = t.fg(quotaColor, `${label} ${bar(window.leftPercent, width)} ${window.leftPercent}%`);
	const delta = ccDelta(window);
	if (delta) seg += " " + t.fg(deltaColor(delta.severity), delta.text);
	if (showReset && window.resetAt !== undefined) {
		const reset = formatReset(window.resetAt - Date.now());
		if (reset) seg += t.fg("dim", ` ${reset}`);
	}
	if (window.exceeded) seg += " " + t.fg("error", "exceeded");
	return seg;
}

// "expires in 23d" — rounded up, because a partial day still counts as demand
// on the remaining balance. Returns null once the period is already over.
export function ccExpiry(
	expiresAt: number | undefined,
	now = Date.now(),
): { text: string; days: number } | null {
	if (expiresAt === undefined) return null;
	const msLeft = expiresAt - now;
	if (msLeft <= 0) return null;
	const days = Math.ceil(msLeft / DAY_MS);
	return { text: `expires in ${days}d`, days };
}

export function renderCommandCode(payload: unknown, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const state = payload as CCPayload;
	const parts: string[] = [t.fg("dim", "CC") + (state.plan ? t.fg("dim", ` ${state.plan}`) : "")];

	if (state.fiveHour) parts.push(renderCCWindow("5h", state.fiveHour, ctx, 10, true));
	if (state.weekly) parts.push(renderCCWindow("W", state.weekly, ctx, 6, false));
	if (state.remaining !== undefined) {
		parts.push(t.fg(colorFor(state.remaining, CC_CREDIT_LOW, CC_CREDIT_MID), `$${state.remaining.toFixed(2)}`));
	}
	// Monthly credits vanish at period end; flag how long they are still spendable.
	if ((state.monthlyRemaining ?? 0) > 0) {
		const expiry = ccExpiry(state.expiresAt);
		if (expiry) {
			parts.push(t.fg(expiry.days <= CC_EXPIRY_WARN_DAYS ? "warning" : "dim", expiry.text));
		}
	}
	if (state.status && state.status !== "active") parts.push(t.fg("error", state.status));

	return parts.join(t.fg("dim", " | "));
}

export const commandCodeProviderConfig: ProviderConfig = {
	label: "CC",
	unavailableWord: "quota",
	noKeyLabel: "no login",
	fetch: fetchCommandCodeQuota,
	render: renderCommandCode,
	ttlFor: commandCodeTtlFor,
	extractWeekQuota: (payload: unknown) => {
		const state = payload as CCPayload;
		if (!state.weekly) return null;
		return {
			leftPercent: state.weekly.leftPercent,
			...(state.weekly.resetAt ? { resetAt: state.weekly.resetAt } : {}),
		};
	},
};
