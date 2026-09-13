import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { SixelChartEntryComponent } from "./history/chart-component.js";
import { formatShortDateTime, generateSixelChart } from "./history/sixel.js";
import { getStorageKey, loadHistory, recordQuotaChange } from "./history/store.js";
import { CONFIGS } from "./providers/index.js";
import type { FetchResult, ProviderConfig, SixelChartEntryData } from "./types.js";
import { cacheKey, ERROR_RETRY_TTL_MS, formatReset, RATE_LIMIT_RETRY_TTL_MS, renderFailure } from "./utils.js";

const STATUS_KEY = "quota";

// In-memory cache keyed by "provider:keyHash" so switching keys or providers
// never shows stale data. Pi extensions are long-lived in one process; a
// process restart just means one extra fetch.
const cache = new Map<string, { result: FetchResult; savedAt: number; lastAttemptAt: number }>();

// Epoch counter: bumped on every model switch. Any async result (fetch,
// cache render) started before the bump is dropped — this is what kills the
// ghost-widget race.
let epoch = 0;

// Only one fetch per key+epoch in flight, so bursts of tool_result events
// coalesce onto a single request.
let activeFetch: { key: string; epoch: number } | null = null;

function ttlFor(entry: { result: FetchResult; lastAttemptAt: number }, cfg: ProviderConfig): number {
	if (entry.result.kind === "success") return cfg.ttlFor(entry.result.payload);
	if (entry.result.kind === "rate_limited") return RATE_LIMIT_RETRY_TTL_MS;
	return ERROR_RETRY_TTL_MS;
}

function renderEntry(entry: { result: FetchResult }, cfg: ProviderConfig, ctx: ExtensionContext): string {
	return entry.result.kind === "success"
		? cfg.render(entry.result.payload, ctx)
		: renderFailure(cfg, entry.result, ctx);
}

// ─── core refresh logic ──────────────────────────────────────────────────────

async function refresh(
	ctx: ExtensionContext,
	cfg: ProviderConfig,
	apiKey: string,
	key: string,
	myEpoch: number,
	force = false,
): Promise<void> {
	const now = Date.now();
	const entry = cache.get(key);

	if (!force && entry && now - entry.lastAttemptAt < ttlFor(entry, cfg)) {
		// Cache still fresh — re-render from cache, no network.
		if (myEpoch === epoch) ctx.ui.setStatus(STATUS_KEY, renderEntry(entry, cfg, ctx));
		return;
	}

	const result = await cfg.fetch(apiKey);
	if (myEpoch !== epoch) return; // model switched while we were fetching — drop

	if (result.kind === "success") {
		cache.set(key, { result, savedAt: now, lastAttemptAt: now });
		ctx.ui.setStatus(STATUS_KEY, cfg.render(result.payload, ctx));

		// Record week quota history if supported
		if (cfg.extractWeekQuota && ctx.model?.provider) {
			const weekQuota = cfg.extractWeekQuota(result.payload);
			if (weekQuota) {
				recordQuotaChange(ctx.model.provider, apiKey, weekQuota);
			}
		}
	} else {
		cache.set(key, { result, savedAt: now, lastAttemptAt: now });
		ctx.ui.setStatus(STATUS_KEY, renderFailure(cfg, result, ctx));
	}
}

// Fire-and-forget refresh. Never awaited from model_select/tool_result, so
// switching models can't block on the network. Results are epoch-guarded.
function scheduleRefresh(
	ctx: ExtensionContext,
	cfg: ProviderConfig,
	apiKey: string,
	key: string,
	myEpoch: number,
	force = false,
): void {
	// Coalesce only the exact same fetch (same key + same switch epoch).
	if (activeFetch && activeFetch.key === key && activeFetch.epoch === myEpoch) return;
	activeFetch = { key, epoch: myEpoch };
	void (async () => {
		try {
			await refresh(ctx, cfg, apiKey, key, myEpoch, force);
		} finally {
			if (activeFetch) activeFetch = null;
		}
	})();
}

// ─── activation guard ────────────────────────────────────────────────────────

async function syncActivation(ctx: ExtensionContext): Promise<void> {
	// Bump the epoch and clear the widget synchronously — the old provider's
	// widget must vanish immediately, and any in-flight fetch for it becomes
	// stale the moment it resolves.
	const myEpoch = ++epoch;
	ctx.ui.setStatus(STATUS_KEY, undefined);

	const provider = ctx.model?.provider;
	const cfg = provider ? CONFIGS[provider] : undefined;
	if (!cfg || !provider) return; // no monitor for this provider → stay invisible

	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
	if (!apiKey) {
		if (myEpoch === epoch) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `${cfg.label} ${cfg.noKeyLabel}`));
		}
		return;
	}

	const key = cacheKey(provider, apiKey);

	// Show the cached value immediately (even if stale — better than a blank
	// footer while the fetch runs), then refresh in the background.
	const entry = cache.get(key);
	if (entry && myEpoch === epoch) {
		ctx.ui.setStatus(STATUS_KEY, renderEntry(entry, cfg, ctx));
	}

	scheduleRefresh(ctx, cfg, apiKey, key, myEpoch);
}

// ─── extension entry ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	// Register custom entry renderer for Sixel charts in chat stream (like codex-timer's "worked-for")
	pi.registerEntryRenderer<SixelChartEntryData>("quota-sixel-chart", (entry, _opts, theme) => {
		const data = entry.data;
		if (!data || !data.points || data.points.length === 0) {
			return new Text(theme.fg("dim", "暂无历史额度数据"), 0, 0);
		}

		const latestP = data.points[data.points.length - 1];
		const firstP = data.points[0];
		const deltaPct = latestP.leftPercent - firstP.leftPercent;
		const deltaStr =
			deltaPct <= 0 ? `已消耗 ${Math.abs(deltaPct)}%` : `增加 +${deltaPct}% (可能已重置)`;

		let resetStr = "";
		if (latestP.resetAt) {
			resetStr = ` | 距离重置: ${formatReset(latestP.resetAt - Date.now())}`;
		}

		const minTime = data.points[0].timestamp;
		const lastTime = data.points[data.points.length - 1].timestamp;
		const maxTime = lastTime === minTime ? minTime + 60_000 : lastTime;
		const startLabel = formatShortDateTime(minTime);
		const endLabel = formatShortDateTime(maxTime);

		const header =
			`${theme.bold(`📊 ${data.providerLabel} Week 额度高分辨率趋势图 (Sixel 硬件渲染)`)}\n` +
			`   当前剩余: ${theme.fg("accent", `${latestP.leftPercent}%`)} | ${deltaStr}${resetStr} | 记录数: ${data.points.length}`;

		const footer = `   ${theme.fg("dim", `[100% ──── 0%]   时间范围: ${startLabel}  至  ${endLabel}`)}`;

		// Leave room for the percentage axis and two-line date/time ticks.
		const chartHeight = 420;
		const sixel = generateSixelChart(data.points, 1120, chartHeight);

		return new SixelChartEntryComponent(sixel, header, footer, chartHeight);
	});

	pi.on("session_start", async (_event, ctx) => {
		await syncActivation(ctx);
	});

	// On model switch: re-check activation. If the new provider is still
	// supported we restore from cache and refresh; otherwise the widget stays
	// hidden. Either way the previous widget is cleared first.
	pi.on("model_select", async (_event, ctx) => {
		await syncActivation(ctx);
	});

	// After each tool call completes: nudge a refresh so the widget reflects
	// spend. The TTL cache inside refresh() prevents flooding the API.
	pi.on("tool_result", async (_event, ctx) => {
		const provider = ctx.model?.provider;
		const cfg = provider ? CONFIGS[provider] : undefined;
		if (!cfg || !provider) return;
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
		if (!apiKey) return;
		scheduleRefresh(ctx, cfg, apiKey, cacheKey(provider, apiKey), epoch);
	});

	const forceRefresh = async (_args: unknown, ctx: ExtensionContext) => {
		const provider = ctx.model?.provider;
		const cfg = provider ? CONFIGS[provider] : undefined;
		if (!cfg || !provider) {
			ctx.ui.notify("No quota monitor for the current provider", "warning");
			return;
		}
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
		if (!apiKey) {
			ctx.ui.notify(`No API key configured for ${provider}`, "warning");
			return;
		}
		const key = cacheKey(provider, apiKey);
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `${cfg.label} refreshing…`));
		await refresh(ctx, cfg, apiKey, key, epoch, true);
		ctx.ui.notify(`${cfg.label} quota refreshed`, "info");
	};

	const insertSixelChartEntry = async (ctx: ExtensionContext) => {
		const provider = ctx.model?.provider;
		const cfg = provider ? CONFIGS[provider] : undefined;
		if (!cfg || !provider) {
			ctx.ui.notify("当前模型服务商不支持额度追踪", "warning");
			return;
		}
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
		if (!apiKey) {
			ctx.ui.notify(`未配置 ${provider} 的 API 凭据`, "warning");
			return;
		}

		// Ensure we have current data
		const key = cacheKey(provider, apiKey);
		let entry = cache.get(key);
		if (!entry || entry.result.kind !== "success") {
			await refresh(ctx, cfg, apiKey, key, epoch, true);
			entry = cache.get(key);
		}

		let currentWeekQuota: { leftPercent: number; resetAt?: number } | null = null;
		if (cfg.extractWeekQuota && entry?.result.kind === "success") {
			currentWeekQuota = cfg.extractWeekQuota(entry.result.payload);
			if (currentWeekQuota) {
				recordQuotaChange(provider, apiKey, currentWeekQuota);
			}
		}

		const storageKey = getStorageKey(provider, apiKey);
		const store = loadHistory();
		const historyList = store[storageKey] || [];

		const displayPoints = [...historyList];
		if (displayPoints.length === 0 && currentWeekQuota) {
			displayPoints.push({
				timestamp: Date.now(),
				leftPercent: currentWeekQuota.leftPercent,
				...(currentWeekQuota.resetAt ? { resetAt: currentWeekQuota.resetAt } : {}),
			});
		}

		if (displayPoints.length === 0) {
			ctx.ui.notify(`${cfg.label} 当前无周额度数据可供绘制`, "warning");
			return;
		}

		// Append a custom entry to the chat transcript!
		// Just like codex-timer's "worked-for", this does NOT participate in LLM context
		// and renders directly inside the chat flow!
		pi.appendEntry<SixelChartEntryData>("quota-sixel-chart", {
			providerLabel: cfg.label,
			points: displayPoints,
		});
	};

	pi.registerCommand("quota", {
		description: "Force-refresh the current provider's usage/balance in the footer (or /quota chart)",
		handler: async (args, ctx) => {
			const raw = String(args || "").trim().toLowerCase();
			if (raw.startsWith("chart") || raw.startsWith("history") || raw.startsWith("graph")) {
				await insertSixelChartEntry(ctx);
				return;
			}
			await forceRefresh(args, ctx);
		},
	});

	pi.registerCommand("quota-chart", {
		description: "在聊天流中插入周额度随时间下降的 Sixel 高分辨率平滑折线图",
		handler: async (_args, ctx) => {
			await insertSixelChartEntry(ctx);
		},
	});

	// Backwards-compatible aliases for the old per-provider commands.
	for (const name of ["ds-balance", "glm-quota", "minimax-quota", "openai-codex-quota", "antigravity-quota"]) {
		pi.registerCommand(name, {
			description: `Force-refresh quota in the footer (alias of /quota)`,
			handler: forceRefresh,
		});
	}
}
