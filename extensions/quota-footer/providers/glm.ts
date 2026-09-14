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
	REQUEST_TIMEOUT_MS,
	WEEK_MS,
} from "../utils.ts";

const GLM_URLS = [
	"https://open.bigmodel.cn/api/monitor/usage/quota/limit",
	"https://api.z.ai/api/monitor/usage/quota/limit",
] as const;
const GLM_LOW_THRESHOLD = 30;
const GLM_MID_THRESHOLD = 60;
const GLM_REFRESH_BANDS = [
	{ minLeftPercent: 80, ttlMs: 120_000 },
	{ minLeftPercent: 30, ttlMs: 300_000 },
	{ minLeftPercent: 0, ttlMs: 120_000 },
] as const;

export interface GLMQuotaPayload {
	level: string;
	leftPercent: number;
	weekLeftPercent?: number;
	mcpLeftPercent?: number;
	nextResetTime?: number;
	primaryCycleStart?: number;
	primaryCycleMs?: number;
	weekNextResetTime?: number;
}

export function glmTtlFor(payload: unknown): number {
	const leftPercent = (payload as GLMQuotaPayload).leftPercent;
	const band = GLM_REFRESH_BANDS.find((b) => leftPercent >= b.minLeftPercent);
	return band ? band.ttlMs : GLM_REFRESH_BANDS[GLM_REFRESH_BANDS.length - 1].ttlMs;
}

// Compute (leftPercent, usedPercent) from a limit object: prefer
// remaining+currentValue; fall back to usage; last resort `percentage`.
export function glmComputePercentages(limit: any): { leftPercent: number; usedPercent: number } | null {
	const remaining = asFiniteNumber(limit?.remaining);
	const currentValue = asFiniteNumber(limit?.currentValue);
	const usage = asFiniteNumber(limit?.usage);
	const totalFromParts = remaining !== null && currentValue !== null ? remaining + currentValue : null;
	const total = totalFromParts !== null && totalFromParts > 0 ? totalFromParts : usage;

	if (total !== null && total > 0) {
		if (remaining !== null && remaining >= 0 && remaining <= total) {
			const leftPercent = clampPercent((remaining / total) * 100);
			if (leftPercent !== null) return { leftPercent, usedPercent: 100 - leftPercent };
		}
		if (currentValue !== null && currentValue >= 0 && currentValue <= total) {
			const usedPercent = clampPercent((currentValue / total) * 100);
			if (usedPercent !== null) return { leftPercent: 100 - usedPercent, usedPercent };
		}
	}

	const usedPercent = clampPercent(limit?.percentage);
	if (usedPercent === null) return null;
	return { leftPercent: 100 - usedPercent, usedPercent };
}

export function parseGLMQuota(body: any): FetchResult {
	if (!body || typeof body !== "object") return { kind: "unavailable", at: Date.now() };
	if (body.success !== true) {
		const code = body.code;
		const msg = typeof body.msg === "string" ? body.msg : "";
		if (code === 1001 || code === 401 || /authorization|auth|token/i.test(msg)) {
			return { kind: "auth_error", at: Date.now() };
		}
		if (/rate\s*limit|too many requests|too frequent|frequency|限流|频率|过于频繁|稍后再试/i.test(msg)) {
			return { kind: "rate_limited", at: Date.now() };
		}
		return { kind: "unavailable", at: Date.now() };
	}

	const data = body.data ?? {};
	const level = typeof data.level === "string" ? data.level : "";
	const limits: any[] = Array.isArray(data.limits) ? data.limits : [];

	const tokenLimits = limits.filter((l) => l?.type === "TOKENS_LIMIT");
	if (tokenLimits.length === 0) return { kind: "unavailable", at: Date.now() };

	// Pick the 5h limit (number === 5) if present; otherwise the one with the
	// nearest reset. The other one is the weekly limit.
	const explicit5h = tokenLimits.find((l) => l?.number === 5) ?? null;
	let primary: any;
	let week: any | null = null;
	if (explicit5h) {
		primary = explicit5h;
		week = tokenLimits.find((l) => l !== explicit5h) ?? null;
	} else {
		const sorted = [...tokenLimits].sort(
			(a, b) => (asFiniteNumber(a?.nextResetTime) ?? Infinity) - (asFiniteNumber(b?.nextResetTime) ?? Infinity),
		);
		primary = sorted[0];
		week = sorted[1] ?? null;
	}

	const primaryPct = glmComputePercentages(primary);
	if (!primaryPct) return { kind: "unavailable", at: Date.now() };
	const nextResetTime = asFiniteNumber(primary?.nextResetTime) ?? undefined;

	const isFiveHour = explicit5h !== null || primary?.number === 5;
	const primaryCycleMs = isFiveHour ? FIVE_HOUR_WINDOW_MS : undefined;
	const primaryCycleStart =
		nextResetTime !== undefined && primaryCycleMs !== undefined ? nextResetTime - primaryCycleMs : undefined;

	const mcpLimit = limits.find((l) => l?.type === "MCP_LIMIT" || l?.type === "TIME_LIMIT");
	const mcpPct = mcpLimit ? glmComputePercentages(mcpLimit) : null;
	const weekPct = week ? glmComputePercentages(week) : null;
	const weekNextResetTime = week ? asFiniteNumber(week?.nextResetTime) ?? undefined : undefined;

	return {
		kind: "success",
		fetchedAt: Date.now(),
		payload: {
			level,
			leftPercent: primaryPct.leftPercent,
			...(weekPct ? { weekLeftPercent: weekPct.leftPercent } : {}),
			...(mcpPct ? { mcpLeftPercent: mcpPct.leftPercent } : {}),
			...(nextResetTime !== undefined ? { nextResetTime } : {}),
			...(primaryCycleStart !== undefined ? { primaryCycleStart } : {}),
			...(primaryCycleMs !== undefined ? { primaryCycleMs } : {}),
			...(weekNextResetTime !== undefined ? { weekNextResetTime } : {}),
		},
	};
}

export async function fetchGLM(apiKey: string): Promise<FetchResult> {
	for (const url of GLM_URLS) {
		try {
			const res = await fetch(url, {
				method: "GET",
				headers: { Accept: "application/json, text/plain, */*", Authorization: apiKey },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const text = await res.text();
			let json: any = null;
			try {
				json = JSON.parse(text);
			} catch {}
			if (res.status === 429) return { kind: "rate_limited", at: Date.now() };
			return parseGLMQuota(json);
		} catch {
			// try the next URL; if none left → unavailable
		}
	}
	return { kind: "unavailable", at: Date.now() };
}

// delta = theoreticalUsedTime - elapsed. > 0 means burning faster than sustainable (ahead),
// < 0 means conserving (behind).
export function glmDelta(
	usedPercent: number,
	nextResetTime: number | undefined,
	cycleMs: number,
	now = Date.now(),
): { text: string; severity: "good" | "warn" | "danger" } | null {
	if (!nextResetTime || !Number.isFinite(nextResetTime) || nextResetTime <= now) return null;
	const cycleStart = nextResetTime - cycleMs;
	if (cycleStart >= now) return null;
	return calcDelta(usedPercent, cycleMs, now - cycleStart);
}

export function glmWeekDelta(
	usedPercent: number,
	nextResetTime: number | undefined,
	now = Date.now(),
): { text: string; severity: "good" | "warn" | "danger" } | null {
	if (!nextResetTime || !Number.isFinite(nextResetTime) || nextResetTime <= now) return null;
	return glmDelta(usedPercent, nextResetTime, WEEK_MS, now);
}

export function renderGLM(payload: unknown, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const state = payload as GLMQuotaPayload;
	const lvl = state.level ? ` ${state.level}` : "";
	const primaryColor = colorFor(state.leftPercent, GLM_LOW_THRESHOLD, GLM_MID_THRESHOLD);

	let primarySeg = t.fg("dim", "GLM") + t.fg(primaryColor, `${lvl} ${bar(state.leftPercent)} ${state.leftPercent}%`);
	if (state.primaryCycleMs !== undefined) {
		const delta = glmDelta(100 - state.leftPercent, state.nextResetTime, state.primaryCycleMs);
		if (delta) primarySeg += " " + t.fg(deltaColor(delta.severity), delta.text);
	}

	const parts: string[] = [primarySeg];

	if (state.weekLeftPercent !== undefined) {
		let weekSeg = t.fg(
			colorFor(state.weekLeftPercent, GLM_LOW_THRESHOLD, GLM_MID_THRESHOLD),
			`W${bar(state.weekLeftPercent, 6)} ${state.weekLeftPercent}%`,
		);
		const weekDelta = glmWeekDelta(100 - state.weekLeftPercent, state.weekNextResetTime);
		if (weekDelta) weekSeg += " " + t.fg(deltaColor(weekDelta.severity), weekDelta.text);
		parts.push(weekSeg);
	}

	if (state.mcpLeftPercent !== undefined) {
		parts.push(
			t.fg(colorFor(state.mcpLeftPercent, GLM_LOW_THRESHOLD, GLM_MID_THRESHOLD), `MCP ${state.mcpLeftPercent}%`),
		);
	}

	if (state.nextResetTime !== undefined) {
		const reset = formatReset(state.nextResetTime - Date.now());
		if (reset) parts.push(t.fg("dim", `reset ${reset}`));
	}
	return parts.join(t.fg("dim", " | "));
}

export const glmProviderConfig: ProviderConfig = {
	label: "GLM",
	unavailableWord: "quota",
	noKeyLabel: "no api key",
	fetch: fetchGLM,
	render: renderGLM,
	ttlFor: glmTtlFor,
	extractWeekQuota: (payload: unknown) => {
		const state = payload as GLMQuotaPayload;
		if (state.weekLeftPercent === undefined) return null;
		return {
			leftPercent: state.weekLeftPercent,
			...(state.weekNextResetTime ? { resetAt: state.weekNextResetTime } : {}),
		};
	},
};
