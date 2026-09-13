import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type FailureKind = "auth_error" | "rate_limited" | "unavailable";

export interface FailureState {
	kind: FailureKind;
	at: number;
}

export interface SuccessState {
	kind: "success";
	fetchedAt: number;
	payload: unknown;
}

export type FetchResult = SuccessState | FailureState;

export interface ProviderConfig {
	label: string; // footer label, e.g. "DS"
	unavailableWord: string; // "balance" | "quota" — error wording
	noKeyLabel: string; // "no api key" | "no login"
	fetch(apiKey: string): Promise<FetchResult>;
	render(payload: unknown, ctx: ExtensionContext): string;
	ttlFor(payload: unknown): number;
	extractWeekQuota?(payload: unknown): { leftPercent: number; resetAt?: number } | null;
}

export interface QuotaHistoryPoint {
	timestamp: number;
	leftPercent: number;
	resetAt?: number;
}

export interface QuotaHistoryStore {
	[providerKey: string]: QuotaHistoryPoint[];
}

export interface SixelChartEntryData {
	providerLabel: string;
	points: QuotaHistoryPoint[];
}
