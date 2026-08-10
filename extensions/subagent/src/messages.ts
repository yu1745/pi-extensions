import type { Message } from "@earendil-works/pi-ai";
import type { SubagentMode, UsageStats } from "./types.js";

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getMode(value: unknown): SubagentMode | null {
	if (value === "shallow" || value === "deep" || value === "task") return value;
	return null;
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message) continue;
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (typeof part === "object" && part.type === "text") return part.text;
		}
	}
	return "";
}

export function getToolCalls(
	messages: Message[],
): { name: string; args: Record<string, unknown> }[] {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (typeof part === "object" && part.type === "toolCall")
				calls.push({ name: part.name, args: part.arguments });
		}
	}
	return calls;
}

export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.turns)
		parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens)
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	return parts.join(" ");
}

export function formatToolCall(
	name: string,
	args: Record<string, unknown>,
): string {
	if (name === "read") {
		const filePath = String(args["file_path"] ?? args["path"] ?? "?");
		const offset =
			typeof args["offset"] === "number" ? args["offset"] : undefined;
		const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
		const range =
			offset !== undefined || limit !== undefined
				? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
				: "";
		return `read ${filePath}${range}`;
	}
	if (name === "grep")
		return `grep /${String(args["pattern"] ?? "")}/ in ${String(args["path"] ?? ".")}`;
	if (name === "find")
		return `find ${String(args["pattern"] ?? "*")} in ${String(args["path"] ?? ".")}`;
	if (name === "ls") return `ls ${String(args["path"] ?? ".")}`;
	if (name === "bash") return `$ ${String(args["command"] ?? "")}`;
	return `${name} ${JSON.stringify(args)}`;
}
