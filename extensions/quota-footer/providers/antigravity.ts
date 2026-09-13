import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FetchResult, ProviderConfig } from "../types.js";
import { asFiniteNumber, bar, calcDelta, clampPercent, colorFor, deltaColor, formatReset, REQUEST_TIMEOUT_MS, WEEK_MS } from "../utils.js";

const ANTIGRAVITY_ENDPOINTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
] as const;
const ANTIGRAVITY_LOW_THRESHOLD = 30;
const ANTIGRAVITY_MID_THRESHOLD = 60;
const ANTIGRAVITY_REFRESH_TTL_MS = 5 * 60_000;

export interface AntigravityBucket {
	label: string;
	leftPercent: number;
	resetTime?: string;
	cycleMs?: number;
}

export interface AntigravityPayload {
	buckets: AntigravityBucket[];
	plan?: string;
}

export function antigravityTtlFor(_payload: unknown): number {
	return ANTIGRAVITY_REFRESH_TTL_MS;
}

export function parseAntigravityCreds(apiKey: string): { token: string; projectId: string } | null {
	try {
		const parsed = JSON.parse(apiKey);
		if (parsed && typeof parsed.token === "string" && parsed.token.length > 0) {
			return { token: parsed.token, projectId: parsed.projectId || "antigravity-default" };
		}
	} catch {}
	if (apiKey && apiKey.length > 0) {
		return { token: apiKey, projectId: "antigravity-default" };
	}
	return null;
}

export function antigravityHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		Accept: "application/json",
		"User-Agent": "antigravity/hub/2.8.0 (aidev_client; os_type=linux; arch=x64; cl=963137146)",
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({
			ideType: "ANTIGRAVITY",
			platform: process.platform === "darwin" ? "MACOS" : process.platform === "win32" ? "WINDOWS" : "LINUX",
			pluginType: "GEMINI",
		}),
	};
}

export function parseAntigravityWindowMs(rawWindow?: string, label?: string): number | undefined {
	if (rawWindow) {
		const parsedSec = Number(rawWindow.replace(/s$/i, ""));
		if (Number.isFinite(parsedSec) && parsedSec > 0) return parsedSec * 1000;
	}
	const text = `${rawWindow || ""} ${label || ""}`.toLowerCase();
	if (/\bweek/i.test(text)) return WEEK_MS;
	if (/\b5h\b|five\s*hour/i.test(text)) return 5 * 60 * 60 * 1000;
	if (/\bday\b|24\s*h/i.test(text)) return 24 * 60 * 60 * 1000;
	return undefined;
}

export function simplifyAntigravityLabel(groupName?: string, bucketName?: string): string {
	const raw = `${groupName || ""} ${bucketName || ""}`.trim();
	if (/week/i.test(raw)) {
		return "weekly";
	}
	if (/five\s*hour|5\s*h/i.test(raw)) {
		return "5h";
	}
	if (/day|24\s*h/i.test(raw)) {
		return "day";
	}
	if (bucketName) {
		return (
			bucketName
				.replace(/\s*(Limit|Remaining|Quota)\s*/gi, "")
				.trim()
				.toLowerCase() || bucketName
		);
	}
	return "quota";
}

export async function fetchAntigravity(apiKey: string): Promise<FetchResult> {
	const creds = parseAntigravityCreds(apiKey);
	if (!creds) return { kind: "auth_error", at: Date.now() };

	let lastStatus = 0;
	let quotaSummary: any = null;
	let modelsData: any = null;

	const headers = antigravityHeaders(creds.token);

	// Try retrieveUserQuotaSummary first (preferred for paid tiers)
	for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
		try {
			const res = await fetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
				method: "POST",
				headers,
				body: JSON.stringify({}),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			lastStatus = res.status;
			if (res.ok) {
				quotaSummary = await res.json();
				break;
			}
		} catch {}
	}

	// Also fetch available models to extract quotaInfo per bucket / fallback
	for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
		try {
			const res = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
				method: "POST",
				headers,
				body: JSON.stringify({ project: creds.projectId }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			lastStatus = res.status;
			if (res.ok) {
				modelsData = await res.json();
				break;
			}
		} catch {}
	}

	if (lastStatus === 401 || lastStatus === 403) {
		// If quota summary is 403 (e.g. free-tier), but modelsData succeeded, proceed with modelsData
		if (!modelsData) return { kind: "auth_error", at: Date.now() };
	}
	if (lastStatus === 429 && !modelsData && !quotaSummary) {
		return { kind: "rate_limited", at: Date.now() };
	}
	if (!quotaSummary && !modelsData) {
		return { kind: "unavailable", at: Date.now() };
	}

	const buckets: AntigravityBucket[] = [];

	// Parse from quotaSummary groups if available
	if (quotaSummary?.groups && Array.isArray(quotaSummary.groups)) {
		for (const group of quotaSummary.groups) {
			const groupName = typeof group.displayName === "string" ? group.displayName : "";
			const groupPrefix = /gemini/i.test(groupName)
				? "Gemini"
				: /claude|gpt/i.test(groupName)
					? "Claude"
					: groupName;

			const groupBuckets: AntigravityBucket[] = [];
			for (const b of group.buckets || []) {
				const rem = asFiniteNumber(b.remainingFraction);
				if (rem !== null) {
					const leftPercent = Math.round(clampPercent(rem * 100) ?? 0);
					const bucketName = typeof b.displayName === "string" ? b.displayName : undefined;
					const winLabel = simplifyAntigravityLabel(groupName, bucketName || groupName);
					const rawWindow = typeof b.window === "string" ? b.window : undefined;
					const cycleMs = parseAntigravityWindowMs(rawWindow, `${groupName} ${bucketName || ""}`);
					groupBuckets.push({
						label: winLabel,
						leftPercent,
						resetTime: typeof b.resetTime === "string" ? b.resetTime : undefined,
						...(cycleMs !== undefined ? { cycleMs } : {}),
					});
				}
			}
			// Sort so 5h / shorter windows appear before weekly / longer windows
			groupBuckets.sort((a, b) => {
				const aIs5h = /\b5h\b/i.test(a.label);
				const bIs5h = /\b5h\b/i.test(b.label);
				if (aIs5h && !bIs5h) return -1;
				if (!aIs5h && bIs5h) return 1;
				return 0;
			});

			// Prefix only the first bucket (typically 5h) with the group name (e.g. "Gemini 5h", then "weekly")
			if (groupBuckets.length > 0 && groupPrefix) {
				groupBuckets[0].label = `${groupPrefix} ${groupBuckets[0].label}`;
			}
			buckets.push(...groupBuckets);
		}
	}

	// Fallback to modelsData quotaInfo if no buckets from summary
	if (buckets.length === 0 && modelsData?.models && typeof modelsData.models === "object") {
		// Group / pick representative models (Claude/GPT pool vs Gemini pool)
		const modelEntries = Object.entries(modelsData.models) as [string, any][];
		const claudeOrGpt = modelEntries.find(
			([id, m]) => /claude|gpt/i.test(id) && m?.quotaInfo?.remainingFraction !== undefined,
		);
		const gemini = modelEntries.find(
			([id, m]) => /gemini.*pro|gemini.*flash/i.test(id) && m?.quotaInfo?.remainingFraction !== undefined,
		);

		if (gemini && gemini[1]?.quotaInfo) {
			const rem = asFiniteNumber(gemini[1].quotaInfo.remainingFraction);
			if (rem !== null) {
				buckets.push({
					label: "Gemini",
					leftPercent: Math.round(clampPercent(rem * 100) ?? 0),
					resetTime: gemini[1].quotaInfo.resetTime,
				});
			}
		}
		if (claudeOrGpt && claudeOrGpt[1]?.quotaInfo) {
			const rem = asFiniteNumber(claudeOrGpt[1].quotaInfo.remainingFraction);
			if (rem !== null) {
				buckets.push({
					label: "Claude/GPT",
					leftPercent: Math.round(clampPercent(rem * 100) ?? 0),
					resetTime: claudeOrGpt[1].quotaInfo.resetTime,
				});
			}
		}
	}

	if (buckets.length === 0) {
		return { kind: "unavailable", at: Date.now() };
	}

	return {
		kind: "success",
		fetchedAt: Date.now(),
		payload: { buckets },
	};
}

export function renderAntigravityBucket(b: AntigravityBucket, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const quotaColor = colorFor(b.leftPercent, ANTIGRAVITY_LOW_THRESHOLD, ANTIGRAVITY_MID_THRESHOLD);
	const base = t.fg(quotaColor, `${b.label} ${bar(b.leftPercent)} ${b.leftPercent}%`);

	let deltaPart = "";
	let resetPart = "";
	if (b.resetTime) {
		const ts = Date.parse(b.resetTime);
		if (Number.isFinite(ts)) {
			if (b.cycleMs && b.cycleMs > 0) {
				const delta = calcDelta(100 - b.leftPercent, b.cycleMs, Date.now() - (ts - b.cycleMs));
				if (delta) deltaPart = t.fg(deltaColor(delta.severity), ` ${delta.text}`);
			}
			const reset = formatReset(ts - Date.now());
			if (reset) resetPart = t.fg("dim", ` ${reset}`);
		}
	}
	return base + deltaPart + resetPart;
}

export function renderAntigravity(payload: unknown, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const state = payload as AntigravityPayload;
	const parts = [t.fg("dim", "Antigravity"), ...state.buckets.map((b) => renderAntigravityBucket(b, ctx))];
	return parts.join(t.fg("dim", " | "));
}

export const antigravityProviderConfig: ProviderConfig = {
	label: "Antigravity",
	unavailableWord: "quota",
	noKeyLabel: "no login",
	fetch: fetchAntigravity,
	render: renderAntigravity,
	ttlFor: antigravityTtlFor,
	extractWeekQuota: (payload: unknown) => {
		const state = payload as AntigravityPayload;
		const weekBucket = state.buckets?.find((b) => /\b(week|weekly)\b/i.test(b.label));
		if (!weekBucket) return null;
		let resetAt: number | undefined;
		if (weekBucket.resetTime) {
			const parsed = Date.parse(weekBucket.resetTime);
			if (!Number.isNaN(parsed)) resetAt = parsed;
		}
		return {
			leftPercent: weekBucket.leftPercent,
			...(resetAt ? { resetAt } : {}),
		};
	},
};
