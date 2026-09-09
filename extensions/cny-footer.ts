/**
 * CNY Footer Extension
 *
 * Replaces pi's native footer with one that shows the session cost in RMB
 * (USD × 7). Mirrors the native Footer's three-line layout, theming, and
 * right-aligned model name, so it looks identical except for the currency.
 *
 * Line 1 also carries session counters and the last first-token latency:
 *   ~/proj (main) • 3 turns (5 steps) • TTFT 1.24s
 *
 * Line 2 shows the session cost split by component:
 *   ¥0.123 (¥0.01 + ¥0.09 + ¥0.02)   // total = cache + input + output
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RATE = 7; // USD -> CNY

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCny(value: number): string {
	if (!value) return "0";
	const abs = Math.abs(value);
	if (abs < 0.01) return value.toFixed(4);
	if (abs < 1) return value.toFixed(3);
	return value.toFixed(2);
}

function formatCwd(cwd: string, home: string): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** USD cost split by component (for the `总价 = (cache + input + output)` breakdown). */
	costCache: number;
	costInput: number;
	costOutput: number;
}

function newTotals(): Totals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costCache: 0, costInput: 0, costOutput: 0 };
}

function addUsage(
	t: Totals,
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	},
): void {
	t.input += usage.input;
	t.output += usage.output;
	t.cacheRead += usage.cacheRead;
	t.cacheWrite += usage.cacheWrite;
	t.cost += usage.cost.total;
	t.costCache += usage.cost.cacheRead + usage.cost.cacheWrite;
	t.costInput += usage.cost.input;
	t.costOutput += usage.cost.output;
}

/** First-token latency (TTFT) state for the most recent provider response. */
interface TtftState {
	/** Timestamp the provider request was sent (before_provider_request). */
	requestAt: number | null;
	/** True while waiting for the first streamed token of the current response. */
	awaiting: boolean;
	/** Finalized first-token latency (ms) of the last response, if any. */
	lastMs: number | null;
}

/** Stream events that carry the first token of an assistant response. */
const FIRST_TOKEN_EVENTS = new Set([
	"text_start",
	"text_delta",
	"thinking_start",
	"thinking_delta",
	"toolcall_start",
	"toolcall_delta",
]);

function formatLatency(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	return `${s < 10 ? s.toFixed(2) : s.toFixed(1)}s`;
}

export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | null = null;
	let ttft: TtftState = { requestAt: null, awaiting: false, lastMs: null };

	// Anchor: fires right before the request is handed to the provider.
	pi.on("before_provider_request", () => {
		if (!ttft.awaiting || ttft.requestAt === null) {
			ttft.requestAt = Date.now();
			ttft.awaiting = true;
			requestRender?.();
		}
	});

	// Fallback anchor for custom providers that don't emit before_provider_request.
	pi.on("message_start", (event) => {
		if (event.message.role === "assistant" && !ttft.awaiting) {
			ttft.requestAt = Date.now();
			ttft.awaiting = true;
			requestRender?.();
		}
	});

	// Stop the clock on the first token of any kind (text / thinking / tool call).
	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		if (!ttft.awaiting || ttft.requestAt === null) return;
		const type = event.assistantMessageEvent?.type;
		if (!type || !FIRST_TOKEN_EVENTS.has(type)) return;
		ttft.lastMs = Date.now() - ttft.requestAt;
		ttft.awaiting = false;
		ttft.requestAt = null;
		requestRender?.();
	});

	// Response ended without producing a token (error / abort): drop the pending timer.
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		if (ttft.awaiting) {
			ttft.awaiting = false;
			ttft.requestAt = null;
		}
	});

	pi.on("session_start", (_event, ctx) => {
		ttft = { requestAt: null, awaiting: false, lastMs: null };
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const home = process.env.HOME || process.env.USERPROFILE || "";

			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				invalidate() {},
				dispose: () => {
					requestRender = null;
					unsubscribe();
				},
				render(width: number): string[] {
					const sm = ctx.sessionManager;

					// Aggregate usage across current active branch entries.
					// We separate parent session usage (assistant messages) from
					// subagent usage reported via toolResult (Agent / get_subagent_result).
					const parentTotals = newTotals();
					const subagentTotals = newTotals();
					const totals = newTotals();
					let latestCacheHitRate: number | undefined;
					let turns = 0; // User message / conversational turns
					let steps = 0; // Model execution / assistant steps
					for (const entry of sm.getBranch()) {
						if (entry.type === "message" && entry.message.role === "user") {
							turns++;
						} else if (entry.type === "message" && entry.message.role === "assistant") {
							steps++;
							addUsage(parentTotals, entry.message.usage);
							addUsage(totals, entry.message.usage);
							const promptTokens =
								entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
							latestCacheHitRate =
								promptTokens > 0 ? (entry.message.usage.cacheRead / promptTokens) * 100 : undefined;
						} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
							addUsage(subagentTotals, entry.message.usage);
							addUsage(totals, entry.message.usage);
						} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
							addUsage(parentTotals, entry.usage);
							addUsage(totals, entry.usage);
						}
					}

					// Context usage from extension context (handles compaction correctly).
					const ctxUsage = ctx.getContextUsage();
					const contextWindow = ctxUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = ctxUsage?.percent ?? 0;
					const contextPercent = ctxUsage?.percent !== null && ctxUsage?.percent !== undefined ? contextPercentValue.toFixed(1) : "?";

					// pwd + branch + session name (line 1).
					let pwd = formatCwd(sm.getCwd(), home);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = sm.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;
					if (turns > 0) {
						const turnStr = `${turns} ${turns === 1 ? "turn" : "turns"}`;
						const stepStr = steps > 0 ? ` (${steps} ${steps === 1 ? "step" : "steps"})` : "";
						pwd = `${pwd} • ${turnStr}${stepStr}`;
					}
					// First-token latency of the last (or in-flight) provider response.
					if (ttft.awaiting) {
						pwd = `${pwd} • TTFT …`;
					} else if (ttft.lastMs !== null) {
						pwd = `${pwd} • TTFT ${formatLatency(ttft.lastMs)}`;
					}

					// Build stats parts (line 2 left side).
					const statsParts: string[] = [];
					if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
					if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
					if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
					if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
					if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
						statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}
					if (totals.cost) {
						// Split the session cost into cache / input / output (RMB).
						const cacheCny = totals.costCache * RATE;
						const inputCny = totals.costInput * RATE;
						const outputCny = totals.costOutput * RATE;
						const partsCny = cacheCny + inputCny + outputCny;
						const totalCny = partsCny > 0 ? partsCny : totals.cost * RATE;
						const breakdown = partsCny > 0
							? ` (¥${formatCny(cacheCny)} + ¥${formatCny(inputCny)} + ¥${formatCny(outputCny)})`
							: "";
						if (subagentTotals.cost > 0) {
							const parentCny = parentTotals.cost * RATE;
							const subCny = subagentTotals.cost * RATE;
							statsParts.push(`¥${formatCny(totalCny)}${breakdown} [M:${formatCny(parentCny)} | S:${formatCny(subCny)}]`);
						} else {
							statsParts.push(`¥${formatCny(totalCny)}${breakdown}`);
						}
					}

					// Context percent with threshold-based coloring.
					const auto = " (auto)";
					const ctxDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)}${auto}`
							: `${contextPercent}%/${formatTokens(contextWindow)}${auto}`;
					let ctxColored: string;
					if (contextPercentValue > 90) ctxColored = theme.fg("error", ctxDisplay);
					else if (contextPercentValue > 70) ctxColored = theme.fg("warning", ctxDisplay);
					else ctxColored = ctxDisplay;
					statsParts.push(ctxColored);

					let statsLeft = statsParts.join(" ");

					// Right side: model name (+ provider if multiple providers, + thinking level if reasoning).
					const modelName = ctx.model?.id || "no-model";
					let rightBase = modelName;
					if (ctx.model?.reasoning) {
						const level = ctx.thinkingLevel || "off";
						rightBase = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
					}
					let rightSide = rightBase;
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						const withProvider = `(${ctx.model.provider}) ${rightBase}`;
						if (visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <= width) {
							rightSide = withProvider;
						}
					}

					// Assemble line with padding, truncating if too wide.
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}
					const rightWidth = visibleWidth(rightSide);
					const minPadding = 2;
					let statsLine: string;
					const totalNeeded = statsLeftWidth + minPadding + rightWidth;
					if (totalNeeded <= width) {
						const pad = " ".repeat(width - statsLeftWidth - rightWidth);
						statsLine = statsLeft + pad + rightSide;
					} else {
						const avail = width - statsLeftWidth - minPadding;
						if (avail > 0) {
							const truncR = truncateToWidth(rightSide, avail, "");
							statsLine = statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncR))) + truncR;
						} else {
							statsLine = statsLeft;
						}
					}

					// Apply dim, preserving context-percent color (which ends with SGR reset).
					const dimStatsLeft = theme.fg("dim", statsLeft);
					const dimRemainder = theme.fg("dim", statsLine.slice(statsLeft.length));
					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

					const lines: string[] = [pwdLine, dimStatsLeft + dimRemainder];

					// Line 3: extension statuses (sorted, dim).
					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const sorted = Array.from(statuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text));
						lines.push(truncateToWidth(sorted.join(" "), width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	});
}