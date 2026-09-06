/**
 * subagents-cost extension:
 *
 * Provides the `/subagents-cost` (and `/subagent-cost`, `/scost`) command.
 * Opens an interactive overlay panel displaying the aggregated cost breakdown of each subagent
 * in the current session (description, model, tokens, tool uses, duration, and CNY cost).
 *
 * Features:
 * - Aggregates multiple billing entries (initial run, intermediate steers, final retrieval) by agent ID.
 * - Default sort: Cost descending (highest cost first).
 * - Press Tab to toggle between Cost Descending and Spawn Chronological order.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";

const RATE = 7.0; // USD -> CNY

function formatTokens(count: number): string {
	if (!count) return "0";
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(2)}M`;
}

function formatDurationSec(sec: number): string {
	if (sec <= 0) return "-";
	if (sec < 1) return `${(sec * 1000).toFixed(0)}ms`;
	if (sec < 60) return `${sec.toFixed(1)}s`;
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}m${s}s`;
}

function parseDurationToSec(durStr: string | undefined): number {
	if (!durStr || durStr === "-") return 0;
	const s = durStr.trim().toLowerCase();
	if (s.endsWith("ms")) return Number.parseFloat(s.slice(0, -2)) / 1000;
	if (s.endsWith("s")) return Number.parseFloat(s.slice(0, -1));
	if (s.endsWith("m")) return Number.parseFloat(s.slice(0, -1)) * 60;
	if (s.endsWith("h")) return Number.parseFloat(s.slice(0, -1)) * 3600;
	return 0;
}

interface SubagentCostItem {
	id: string;
	spawnIndex: number;
	type: string;
	model: string;
	description: string;
	turnCount: number;
	toolUses: number;
	tokens: number;
	costCny: number;
	durationSec: number;
	steerCount: number;
	status: string;
}

function extractText(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => (typeof c === "string" ? c : c?.text || ""))
			.join("\n");
	}
	return "";
}

function cleanModelName(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	return raw.includes("/") ? raw.split("/")[1] : raw;
}

function resolveAgentOutputTurns(agentId: string, sessionId: string, cwd: string): number | undefined {
	if (!agentId || agentId === "unknown") return undefined;
	const safeCwd = cwd.replace(/^\/+|\/+$/g, "").replace(/\//g, "-");
	const uid = process.getuid ? process.getuid() : 1000;
	const taskFile = `/tmp/pi-subagents-${uid}/${safeCwd}/${sessionId}/tasks/${agentId}.output`;

	try {
		if (existsSync(taskFile)) {
			const content = readFileSync(taskFile, "utf-8");
			const matches = content.match(/"type"\s*:\s*"assistant"/g);
			return matches ? matches.length : undefined;
		}
	} catch {
		// Ignore read errors
	}
	return undefined;
}

function collectSubagents(ctx: ExtensionContext): { items: SubagentCostItem[]; totalCny: number } {
	const branch = ctx.sessionManager.getBranch();

	// Map of toolCallId -> requested model
	const callModelMap = new Map<string, string>();

	// Pass 1: Build a catalog of agent IDs -> { description, type, model }
	const agentCatalog = new Map<string, { description: string; type: string; model?: string }>();

	for (const entry of branch) {
		if (entry.type !== "message") continue;

		for (const content of entry.message.content || []) {
			if (content && typeof content === "object" && content.type === "toolCall") {
				const args = content.arguments || {};
				if (content.name === "Agent" && args.model) {
					callModelMap.set(content.id, cleanModelName(args.model));
				}
			}
		}

		if (entry.message.role === "toolResult") {
			const text = extractText(entry.message.content);
			const details = entry.message.details || {};
			const callId = entry.message.toolCallId;
			const requestedModel = callId ? callModelMap.get(callId) : undefined;

			// "Agent started in background.\nAgent ID: <id>"
			const bgMatch = text.match(/Agent started in background\.\s*Agent ID:\s*([a-f0-9-]+)/i);
			if (bgMatch) {
				const id = bgMatch[1].trim();
				const descMatch = text.match(/Description:\s*([^\n\r]+)/i);
				const typeMatch = text.match(/Type:\s*([^\n\r]+)/i);
				agentCatalog.set(id, {
					description: descMatch ? descMatch[1].trim() : "Background Agent",
					type: typeMatch ? typeMatch[1].trim() : "Agent",
					model: requestedModel,
				});
			}

			// "Agent: <id>\nType: ...\nDescription: ..."
			const compMatch = text.match(/^Agent:\s*([a-f0-9-]+)/im);
			if (compMatch) {
				const id = compMatch[1].trim();
				const descMatch = text.match(/^Description:\s*([^\n\r]+)/im);
				const typeMatch = text.match(/^Type:\s*([^|\n\r]+)/im);
				const existing = agentCatalog.get(id);
				if (descMatch) {
					agentCatalog.set(id, {
						description: descMatch[1].trim(),
						type: typeMatch ? typeMatch[1].trim() : "Agent",
						model: existing?.model || requestedModel,
					});
				}
			}

			// Direct details
			if (details.agentId && details.description) {
				agentCatalog.set(details.agentId, {
					description: details.description,
					type: details.subagentType || details.displayName || "Agent",
					model: cleanModelName(details.modelName) || requestedModel,
				});
			}
		}
	}

	// Pass 2: Aggregate by agent ID
	const aggregated = new Map<string, SubagentCostItem>();
	let nextSpawnIndex = 1;
	let totalCny = 0;

	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			const details = entry.message.details || {};
			const usage = entry.message.usage || {};
			const costUsd = usage.cost?.total ?? 0;
			const cny = costUsd * RATE;
			totalCny += cny;

			let agentId = details.agentId;
			let isSteer = false;

			const fullText = extractText(entry.message.content);

			const steerMatch =
				fullText.match(/Steering message (?:sent to|queued for) agent\s*([a-f0-9-]+)/i) ||
				fullText.match(/Agent\s*"([a-f0-9-]+)"\s*is not running/i);
			if (steerMatch) {
				agentId = steerMatch[1].trim();
				isSteer = true;
			}

			const compMatch = fullText.match(/^Agent:\s*([a-f0-9-]+)/m);
			if (compMatch) {
				agentId = compMatch[1].trim();
			}

			if (!agentId) {
				agentId = entry.message.toolCallId || "unknown";
			}

			// Parse tools & duration
			let toolUses = details.toolUses ?? 0;
			const toolsMatch = fullText.match(/Tool uses:\s*(\d+)/i);
			if (toolsMatch && toolUses === 0) {
				toolUses = Number.parseInt(toolsMatch[1], 10);
			}

			let durSec = 0;
			const durMatch = fullText.match(/Duration:\s*([0-9.]+(?:ms|s|m|h))/i);
			if (durMatch) {
				durSec = parseDurationToSec(durMatch[1]);
			} else if (details.durationFormatted) {
				durSec = parseDurationToSec(details.durationFormatted);
			} else if (details.durationMs) {
				durSec = details.durationMs / 1000;
			}

			// Turn count
			let turns = details.turnCount;
			if ((!turns || turns <= 1) && agentId !== "unknown") {
				const realTurns = resolveAgentOutputTurns(agentId, ctx.sessionManager.getSessionId(), ctx.cwd);
				if (realTurns !== undefined) {
					turns = realTurns;
				}
			}

			// Lookup or create aggregated item
			if (!aggregated.has(agentId)) {
				const known = agentCatalog.get(agentId);
				const desc = details.description || known?.description || "Subagent execution";
				const subType = details.subagentType || known?.type || (isSteer ? "steer" : "Agent");
				const model = cleanModelName(details.modelName) || known?.model || "default";

				aggregated.set(agentId, {
					id: agentId,
					spawnIndex: nextSpawnIndex++,
					type: subType,
					model,
					description: desc,
					turnCount: turns ?? 1,
					toolUses,
					tokens: usage.totalTokens ?? 0,
					costCny: cny,
					durationSec: durSec,
					steerCount: isSteer ? 1 : 0,
					status: details.status || "completed",
				});
			} else {
				const item = aggregated.get(agentId)!;
				item.costCny += cny;
				item.tokens += usage.totalTokens ?? 0;
				item.toolUses = Math.max(item.toolUses, toolUses);
				item.durationSec = Math.max(item.durationSec, durSec);
				if (turns && turns > item.turnCount) {
					item.turnCount = turns;
				}
				if (isSteer) {
					item.steerCount++;
				}
				// Refresh model or description if current has more detailed info
				const known = agentCatalog.get(agentId);
				if (item.model === "default" && known?.model) {
					item.model = known.model;
				}
				if ((item.description === "Subagent execution" || item.description.endsWith("(中途调整)")) && known?.description) {
					item.description = known.description;
				}
			}
		}
	}

	return { items: Array.from(aggregated.values()), totalCny };
}

type SortMode = "cost" | "time";

export default function (pi: ExtensionAPI) {
	const showSubagentsCost = async (_args: string | undefined, ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			const { items, totalCny } = collectSubagents(ctx);
			console.log(`Subagents total cost: ¥${totalCny.toFixed(3)} across ${items.length} subagents.`);
			return;
		}

		const { items: originalItems, totalCny } = collectSubagents(ctx);
		if (originalItems.length === 0) {
			ctx.ui.notify("当前会话中暂无子代理消耗记录", "info");
			return;
		}

		let currentSort: SortMode = "cost";

		const buildSelectItems = (sortMode: SortMode): SelectItem[] => {
			const sorted = [...originalItems];
			if (sortMode === "cost") {
				sorted.sort((a, b) => b.costCny - a.costCny);
			} else {
				sorted.sort((a, b) => a.spawnIndex - b.spawnIndex);
			}

			return sorted.map((item, i) => {
				const costStr = `¥${item.costCny.toFixed(3)}`;
				const rankPrefix = sortMode === "cost" ? `#${i + 1}` : `[${item.spawnIndex}]`;
				const steerTag = item.steerCount > 0 ? ` · ${item.steerCount} steer${item.steerCount > 1 ? "s" : ""}` : "";
				const label = `${rankPrefix} [${item.type}] ${item.description}`;
				const desc = `${costStr} · ${formatTokens(item.tokens)} tokens · ${item.toolUses} tools · ↻ ${item.turnCount} · ${formatDurationSec(item.durationSec)} · ${item.model}${steerTag}`;
				return {
					value: item.id,
					label,
					description: desc,
				};
			});
		};

		await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();

			// Top Border
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			// Title Header
			const titleText = new Text("", 1, 0);
			const hintText = new Text("", 1, 0);

			const selectList = new SelectList(buildSelectItems(currentSort), Math.min(originalItems.length, 12), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});

			const updateHeaders = () => {
				const sortLabel = currentSort === "cost" ? "花费由高到低 (Cost ↓)" : "启动时间顺序 (Time ↑)";
				const title = `Subagents Cost · Total: ¥${totalCny.toFixed(3)} (${originalItems.length} agents) · [${sortLabel}]`;
				titleText.setText(theme.fg("accent", theme.bold(title)));
				hintText.setText(theme.fg("dim", "Tab 切换排序 (花费/时间) • Enter/Esc 关闭"));
			};

			updateHeaders();

			selectList.onSelect = () => done(null);
			selectList.onCancel = () => done(null);

			container.addChild(titleText);
			container.addChild(hintText);
			container.addChild(selectList);

			// Bottom Border
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					if (matchesKey(data, Key.tab)) {
						currentSort = currentSort === "cost" ? "time" : "cost";
						updateHeaders();
						const newItems = buildSelectItems(currentSort);
						selectList.items = newItems;
						selectList.filteredItems = newItems;
						selectList.setSelectedIndex(0);
						container.invalidate();
						tui.requestRender();
						return;
					}
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});
	};

	pi.registerCommand("subagents-cost", {
		description: "Display individual cost and usage breakdown for all subagents in current session (Tab to sort)",
		handler: showSubagentsCost,
	});

	pi.registerCommand("subagent-cost", {
		description: "Alias for /subagents-cost",
		handler: showSubagentsCost,
	});

	pi.registerCommand("scost", {
		description: "Alias for /subagents-cost",
		handler: showSubagentsCost,
	});
}
