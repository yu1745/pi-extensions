import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FailureState, ProviderConfig } from "./types.ts";

export const REQUEST_TIMEOUT_MS = 5000;
export const RATE_LIMIT_RETRY_TTL_MS = 180_000;
export const ERROR_RETRY_TTL_MS = 120_000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;

export function shortHash(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
	return (hash >>> 0).toString(16);
}

export function cacheKey(provider: string, apiKey: string): string {
	return `${provider}:${shortHash(apiKey)}`;
}

export function asFiniteNumber(v: unknown): number | null {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
	return Number.isFinite(n) ? n : null;
}

export function clampPercent(n: number | null): number | null {
	if (n === null || !Number.isFinite(n)) return null;
	return Math.max(0, Math.min(100, Math.round(n)));
}

export function bar(leftPercent: number, width = 10): string {
	const filled = Math.round((leftPercent / 100) * width);
	return "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, width - filled));
}

export function colorFor(leftPercent: number, low: number, mid: number): "success" | "warning" | "error" {
	if (leftPercent < low) return "error";
	if (leftPercent < mid) return "warning";
	return "success";
}

export function formatReset(msLeft: number): string {
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

export function deltaColor(severity: "good" | "warn" | "danger"): "success" | "warning" | "error" {
	if (severity === "danger") return "error";
	if (severity === "warn") return "warning";
	return "success";
}

export function formatDeltaTime(deltaMs: number): string {
	const sign = deltaMs >= 0 ? "+" : "-";
	const absMs = Math.abs(deltaMs);
	const hours = absMs / (60 * 60 * 1000);
	if (hours >= 24) {
		const days = hours / 24;
		return `${sign}${(Math.round(days * 10) / 10).toFixed(1)}d`;
	}
	const roundedHours = Math.round(hours);
	if (roundedHours === 0) return "±0h";
	return `${sign}${roundedHours}h`;
}

export function calcDelta(
	usedPercent: number,
	cycleMs: number,
	elapsedMs: number,
): { text: string; severity: "good" | "warn" | "danger" } | null {
	if (cycleMs <= 0 || elapsedMs <= 0 || elapsedMs >= cycleMs) return null;
	const remainingMs = cycleMs - elapsedMs;
	const theoreticalUsedMs = (usedPercent / 100) * cycleMs;
	const deltaMs = theoreticalUsedMs - elapsedMs; // > 0: ahead/burning faster, < 0: behind/conserving
	const text = formatDeltaTime(deltaMs);

	let severity: "good" | "warn" | "danger" = "good";
	if (deltaMs > 0) {
		// If burning ahead by more than half of remaining time or by more than 20% of the entire cycle
		if (deltaMs > remainingMs * 0.5 || deltaMs > cycleMs * 0.2) {
			severity = "danger";
		} else {
			severity = "warn";
		}
	}
	return { text, severity };
}

export function renderFailure(cfg: ProviderConfig, state: FailureState, ctx: ExtensionContext): string {
	const label =
		state.kind === "auth_error"
			? "auth error"
			: state.kind === "rate_limited"
				? "rate limited"
				: `${cfg.unavailableWord} unavailable`;
	return ctx.ui.theme.fg("dim", `${cfg.label} ${label}`);
}
