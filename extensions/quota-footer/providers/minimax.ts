import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FetchResult, ProviderConfig } from "../types.ts";
import { asFiniteNumber, bar, calcDelta, clampPercent, colorFor, deltaColor, formatReset, REQUEST_TIMEOUT_MS } from "../utils.ts";

const MM_URL = "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains";
const MM_LOW_THRESHOLD = 30;
const MM_MID_THRESHOLD = 60;
const MM_REFRESH_BANDS = [
	{ minLeft: 70, ttlMs: 300_000 },
	{ minLeft: 30, ttlMs: 120_000 },
	{ minLeft: 0, ttlMs: 60_000 },
] as const;

export interface MMWindow {
	leftPercent: number;
	usedPercent: number;
	startAt?: number;
	endAt?: number;
}

export interface MMPayload {
	interval: MMWindow;
	weekly?: MMWindow;
	modelName?: string;
}

export function mmTtlFor(payload: unknown): number {
	const leftPercent = (payload as MMPayload).interval.leftPercent;
	return MM_REFRESH_BANDS.find((b) => leftPercent >= b.minLeft)?.ttlMs ?? 60_000;
}

export function parseMMWindow(item: any, prefix: "interval" | "weekly"): MMWindow | null {
	const remainingKey =
		prefix === "interval" ? "current_interval_remaining_percent" : "current_weekly_remaining_percent";
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

export function parseMMQuota(body: any): FetchResult {
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

export async function fetchMM(apiKey: string): Promise<FetchResult> {
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
		try {
			body = JSON.parse(text);
		} catch {}
		if (response.status === 401 || response.status === 403) return { kind: "auth_error", at: Date.now() };
		if (response.status === 429) return { kind: "rate_limited", at: Date.now() };
		return parseMMQuota(body);
	} catch {
		return { kind: "unavailable", at: Date.now() };
	}
}

export function mmDelta(window: MMWindow): { text: string; severity: "good" | "warn" | "danger" } | null {
	if (!window.startAt || !window.endAt || window.endAt <= window.startAt) return null;
	const now = Date.now();
	return calcDelta(window.usedPercent, window.endAt - window.startAt, now - window.startAt);
}

export function renderMMWindow(label: string, window: MMWindow, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const quotaColor = colorFor(window.leftPercent, MM_LOW_THRESHOLD, MM_MID_THRESHOLD);
	const base = t.fg(quotaColor, `${label} ${bar(window.leftPercent)} ${window.leftPercent}%`);
	const delta = mmDelta(window);
	const deltaPart = delta ? t.fg(deltaColor(delta.severity), ` ${delta.text}`) : "";
	const reset = window.endAt !== undefined ? formatReset(window.endAt - Date.now()) : "";
	const resetPart = reset ? t.fg("dim", ` ${reset}`) : "";
	return base + deltaPart + resetPart;
}

export function renderMM(payload: unknown, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const state = payload as MMPayload;
	return [
		t.fg("dim", "MiniMax"),
		renderMMWindow("5h", state.interval, ctx),
		...(state.weekly ? [renderMMWindow("week", state.weekly, ctx)] : []),
	].join(t.fg("dim", " | "));
}

export const minimaxProviderConfig: ProviderConfig = {
	label: "MiniMax",
	unavailableWord: "quota",
	noKeyLabel: "no api key",
	fetch: fetchMM,
	render: renderMM,
	ttlFor: mmTtlFor,
	extractWeekQuota: (payload: unknown) => {
		const state = payload as MMPayload;
		if (!state.weekly) return null;
		return {
			leftPercent: state.weekly.leftPercent,
			...(state.weekly.endAt ? { resetAt: state.weekly.endAt } : {}),
		};
	},
};
