/**
 * subagents-cost extension:
 *
 * Provides the `/subagents-cost` (and `/subagent-cost`, `/scost`) command.
 * Opens an interactive overlay panel displaying the cost breakdown of each subagent
 * in the current session (description, model, tokens, tool uses, duration, and CNY cost).
 *
 * Features:
 * - Default sort: Cost descending (highest cost first).
 * - Press Tab to toggle between Cost Descending and Spawn Chronological order.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

const RATE = 7.0; // USD -> CNY

function formatTokens(count: number): string {
	if (!count) return "0";
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(2)}M`;
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
	duration: string;
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

function cleanModelName(raw: string | undefined): string {
	if (!raw) return "default";
	// Strip provider prefix if present (e.g. "openai-codex/gpt-5.6-terra" -> "gpt-5.6-terra")
	return raw.includes("/") ? raw.split("/")[1] : raw;
}

function collectSubagents(ctx: ExtensionContext): { items: SubagentCostItem[]; totalCny: number } {
	const items: SubagentCostItem[] = [];
	let totalCny = 0;
	let idx = 0;

	const branch = ctx.sessionManager.getBranch();

	// Map of toolCallId -> model requested in arguments
	const callModelMap = new Map<string, string>();

	// Pass 1: Build a knowledge base of known agent IDs -> { description, type, model }
	// by scanning all toolCalls and text notifications in the branch.
	const agentCatalog = new Map<string, { description: string; type: string; model?: string }>();

	for (const entry of branch) {
		if (entry.type !== "message") continue;

		// Scan tool calls for arguments and IDs
		for (const content of entry.message.content || []) {
			if (content && typeof content === "object" && content.type === "toolCall") {
				const args = content.arguments || {};
				if (content.name === "Agent" && args.model) {
					callModelMap.set(content.id, cleanModelName(args.model));
				}
			}
		}

		// Scan toolResult content for spawned/completed agent banners
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

	// Pass 2: Extract all usage entries and cross-reference with agentCatalog
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			idx++;
			const details = entry.message.details || {};
			const usage = entry.message.usage || {};
			const costUsd = usage.cost?.total ?? 0;
			const cny = costUsd * RATE;
			totalCny += cny;

			let description = details.description;
			let subagentType = details.subagentType || details.displayName;
			let modelName = details.modelName;
			let duration =
				details.durationFormatted ||
				(details.durationMs ? `${(details.durationMs / 1000).toFixed(1)}s` : "-");
			let toolUses = details.toolUses ?? 0;
			let agentId = details.agentId || entry.message.toolCallId || "unknown";

			const fullText = extractText(entry.message.content);

			// Extract from text banners if available
			if (fullText) {
				const idMatch = fullText.match(/^Agent:\s*([^\n\r]+)/m);
				if (idMatch && (!details.agentId || details.agentId === "unknown")) {
					agentId = idMatch[1].trim();
				}

				// Check steer text: "Steering message sent to agent <id>." or "Agent <id> is not running"
				const steerMatch =
					fullText.match(/Steering message (?:sent to|queued for) agent\s*([a-f0-9-]+)/i) ||
					fullText.match(/Agent\s*"([a-f0-9-]+)"\s*is not running/i);
				if (steerMatch) {
					agentId = steerMatch[1].trim();
					if (!subagentType) subagentType = "steer";
				}

				const descMatch = fullText.match(/^Description:\s*([^\n\r]+)/m);
				if (descMatch && (!description || description === "Subagent execution")) {
					description = descMatch[1].trim();
				}

				const typeMatch = fullText.match(/^Type:\s*([^|\n\r]+)/m);
				if (typeMatch && (!subagentType || subagentType === "agent")) {
					subagentType = typeMatch[1].trim();
				}

				const durMatch = fullText.match(/Duration:\s*([0-9.]+(?:ms|s|m|h))/i);
				if (durMatch && (duration === "-" || duration === "0.0ms" || duration.endsWith("ms"))) {
					duration = durMatch[1].trim();
				}

				const toolsMatch = fullText.match(/Tool uses:\s*(\d+)/i);
				if (toolsMatch && toolUses === 0) {
					toolUses = Number.parseInt(toolsMatch[1], 10);
				}
			}

			// Cross-reference with agentCatalog
			if (agentCatalog.has(agentId)) {
				const known = agentCatalog.get(agentId)!;
				if (!description || description === "Subagent execution") {
					description =
						subagentType === "steer"
							? `${known.description} (中途调整)`
							: known.description;
				}
				if (!subagentType || subagentType === "agent") {
					subagentType = known.type;
				}
				if ((!modelName || modelName === "default") && known.model) {
					modelName = known.model;
				}
			}

			items.push({
				id: agentId,
				spawnIndex: idx,
				type: subagentType || "Agent",
				model: modelName || "default",
				description: description || "Subagent execution",
				turnCount: details.turnCount ?? 1,
				toolUses,
				tokens: usage.totalTokens ?? 0,
				costCny: cny,
				duration,
				status: details.status || "completed",
			});
		}
	}

	return { items, totalCny };
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
				const label = `${rankPrefix} [${item.type}] ${item.description}`;
				const desc = `${costStr} · ${formatTokens(item.tokens)} tokens · ${item.toolUses} tools · ↻ ${item.turnCount} · ${item.duration} · ${item.model}`;
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
				const title = `Subagents Cost · Total: ¥${totalCny.toFixed(3)} (${originalItems.length} runs) · [${sortLabel}]`;
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
