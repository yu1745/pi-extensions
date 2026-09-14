import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FetchResult, ProviderConfig } from "../types.ts";
import { asFiniteNumber, bar, colorFor, REQUEST_TIMEOUT_MS } from "../utils.ts";

const DS_URLS = ["https://api.deepseek.com/user/balance"] as const;
const DS_LOW_THRESHOLD_CNY = 1.0;
const DS_MID_THRESHOLD_CNY = 3.0;
const DS_CURRENCY_SYMBOL: Record<string, string> = { CNY: "¥", USD: "$" };
const DS_REFRESH_BANDS = [
	{ minLeft: 10, ttlMs: 300_000 }, // ≥ ¥10 → 5 min
	{ minLeft: 0, ttlMs: 60_000 }, // < ¥10 → 1 min
] as const;

export interface DSBalancePayload {
	currency: string;
	symbol: string;
	total: number;
	granted: number;
	toppedUp: number;
	available: boolean;
}

export function dsTtlFor(payload: unknown): number {
	const total = (payload as DSBalancePayload).total;
	const band = DS_REFRESH_BANDS.find((b) => total >= b.minLeft);
	return band ? band.ttlMs : DS_REFRESH_BANDS[DS_REFRESH_BANDS.length - 1].ttlMs;
}

export function parseDSBalance(body: any): FetchResult {
	if (!body || typeof body !== "object") return { kind: "unavailable", at: Date.now() };

	const msg =
		typeof body.message === "string"
			? body.message
			: typeof body.msg === "string"
				? body.msg
				: typeof body.error === "string"
					? body.error
					: "";
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

export async function fetchDS(apiKey: string): Promise<FetchResult> {
	for (const url of DS_URLS) {
		try {
			const res = await fetch(url, {
				method: "GET",
				headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const text = await res.text();
			let json: any = null;
			try {
				json = JSON.parse(text);
			} catch {}
			if (res.status === 401 || res.status === 403) return { kind: "auth_error", at: Date.now() };
			if (res.status === 429) return { kind: "rate_limited", at: Date.now() };
			return parseDSBalance(json);
		} catch {
			// try the next URL; if none left → unavailable
		}
	}
	return { kind: "unavailable", at: Date.now() };
}

export function renderDS(payload: unknown, ctx: ExtensionContext): string {
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
		t.fg("dim", "DS") +
			" " +
			t.fg(balanceColor, bar(fillPercent)) +
			" " +
			t.fg(balanceColor, `${sym}${fmtAmount(state.total)}`),
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

export const deepseekProviderConfig: ProviderConfig = {
	label: "DS",
	unavailableWord: "balance",
	noKeyLabel: "no api key",
	fetch: fetchDS,
	render: renderDS,
	ttlFor: dsTtlFor,
};
