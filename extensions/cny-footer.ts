/**
 * CNY Footer Extension
 *
 * Replaces pi's native footer with one that shows the session cost in RMB
 * (USD × 7). Mirrors the native Footer's three-line layout, theming, and
 * right-aligned model name, so it looks identical except for the currency.
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
}

function newTotals(): Totals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(t: Totals, usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } }): void {
	t.input += usage.input;
	t.output += usage.output;
	t.cacheRead += usage.cacheRead;
	t.cacheWrite += usage.cacheWrite;
	t.cost += usage.cost.total;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const home = process.env.HOME || process.env.USERPROFILE || "";

			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				invalidate() {},
				dispose: unsubscribe,
				render(width: number): string[] {
					const sm = ctx.sessionManager;

					// Aggregate usage across ALL entries (mirrors native FooterComponent).
					const totals = newTotals();
					let latestCacheHitRate: number | undefined;
					let turns = 0;
					for (const entry of sm.getEntries()) {
						if (entry.type === "message" && entry.message.role === "user") {
							turns++;
						} else if (entry.type === "message" && entry.message.role === "assistant") {
							addUsage(totals, entry.message.usage);
							const promptTokens =
								entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
							latestCacheHitRate =
								promptTokens > 0 ? (entry.message.usage.cacheRead / promptTokens) * 100 : undefined;
						} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
							addUsage(totals, entry.message.usage);
						} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
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
						pwd = `${pwd} • ${turns} ${turns === 1 ? "turn" : "turns"}`;
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
						const cny = totals.cost * RATE;
						statsParts.push(`¥${cny.toFixed(3)}`);
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