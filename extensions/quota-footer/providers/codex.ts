import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	credentialsFromToken,
	fetchCodexUsage,
	parseCodexWindow as parseSharedCodexWindow,
} from "../../shared/codex-api.ts";
import type { FetchResult, ProviderConfig } from "../types.ts";
import { bar, calcDelta, clampPercent, colorFor, deltaColor, formatReset, REQUEST_TIMEOUT_MS } from "../utils.ts";

const CODEX_LOW_THRESHOLD = 30;
const CODEX_MID_THRESHOLD = 60;
const CODEX_REFRESH_TTL_MS = 5 * 60_000;

export interface CodexWindow {
	leftPercent: number;
	usedPercent: number;
	resetAt?: number;
	windowSeconds?: number;
}

export interface CodexPayload {
	primary: CodexWindow;
	secondary?: CodexWindow;
	planType?: string;
	allowed?: boolean;
	limitReached?: boolean;
}

export function codexTtlFor(_payload: unknown): number {
	return CODEX_REFRESH_TTL_MS;
}

export function parseCodexWindow(value: any): CodexWindow | null {
	const parsed = parseSharedCodexWindow(value);
	if (!parsed) return null;
	const usedPercent = clampPercent(parsed.usedPercent) ?? 0;
	return {
		usedPercent,
		leftPercent: 100 - usedPercent,
		...(parsed.resetAtMs !== undefined ? { resetAt: parsed.resetAtMs / 1000 } : {}),
		...(parsed.windowSeconds !== undefined ? { windowSeconds: parsed.windowSeconds } : {}),
	};
}

export function parseCodexUsage(body: any): FetchResult {
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

export async function fetchCodex(accessToken: string): Promise<FetchResult> {
	const credentials = credentialsFromToken(accessToken);
	if (!credentials) return { kind: "auth_error", at: Date.now() };
	try {
		const response = await fetchCodexUsage(credentials, {
			timeoutMs: REQUEST_TIMEOUT_MS,
			userAgent: "codex-cli",
		});
		if (response.status === 401 || response.status === 403) return { kind: "auth_error", at: Date.now() };
		if (response.status === 429) return { kind: "rate_limited", at: Date.now() };
		return parseCodexUsage(response.body);
	} catch {
		return { kind: "unavailable", at: Date.now() };
	}
}

export function codexWindowLabel(window: CodexWindow, primary: boolean): string {
	if (window.windowSeconds !== undefined) {
		if (window.windowSeconds <= 6 * 60 * 60) return primary ? "5h" : "6h";
		if (window.windowSeconds <= 24 * 60 * 60) return "day";
		return "week";
	}
	return primary ? "5h" : "week";
}

export function codexDelta(window: CodexWindow): { text: string; severity: "good" | "warn" | "danger" } | null {
	if (!window.resetAt || !window.windowSeconds || window.windowSeconds <= 0) return null;
	const now = Date.now() / 1000;
	const cycleStart = window.resetAt - window.windowSeconds;
	return calcDelta(window.usedPercent, window.windowSeconds * 1000, (now - cycleStart) * 1000);
}

export function renderCodexWindow(window: CodexWindow, primary: boolean, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const label = codexWindowLabel(window, primary);
	const quotaColor = colorFor(window.leftPercent, CODEX_LOW_THRESHOLD, CODEX_MID_THRESHOLD);
	const base = t.fg(quotaColor, `${label} ${bar(window.leftPercent)} ${window.leftPercent}%`);
	const delta = codexDelta(window);
	const deltaPart = delta ? t.fg(deltaColor(delta.severity), ` ${delta.text}`) : "";
	const reset = window.resetAt !== undefined ? formatReset(window.resetAt * 1000 - Date.now()) : "";
	const resetPart = reset ? t.fg("dim", ` ${reset}`) : "";
	return base + deltaPart + resetPart;
}

export function renderCodex(payload: unknown, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const state = payload as CodexPayload;
	const parts = [t.fg("dim", "Codex"), renderCodexWindow(state.primary, true, ctx)];
	if (state.secondary) parts.push(renderCodexWindow(state.secondary, false, ctx));
	if (state.planType) {
		const plan = state.planType.charAt(0).toUpperCase() + state.planType.slice(1).toLowerCase();
		parts.push(t.fg("dim", plan));
	}
	if (state.limitReached) parts.push(t.fg("error", "limited"));
	return parts.join(t.fg("dim", " | "));
}

export const codexProviderConfig: ProviderConfig = {
	label: "Codex",
	unavailableWord: "quota",
	noKeyLabel: "no login",
	fetch: fetchCodex,
	render: renderCodex,
	ttlFor: codexTtlFor,
	extractWeekQuota: (payload: unknown) => {
		const state = payload as CodexPayload;
		// Look for window >= 24h (typically secondary or primary)
		const candidates = [state.secondary, state.primary].filter((w): w is CodexWindow => Boolean(w));
		const weekWin = candidates.find((w) => (w.windowSeconds ?? 0) > 24 * 3600);
		if (!weekWin) return null;
		return {
			leftPercent: weekWin.leftPercent,
			...(weekWin.resetAt ? { resetAt: weekWin.resetAt * 1000 } : {}),
		};
	},
};
