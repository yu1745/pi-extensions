import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";

export type ThinkingLevel = ModelThinkingLevel;
export type SubagentMode = "shallow" | "deep" | "task";

export interface SubagentModeConfig {
	thinking?: ThinkingLevel;
}

export interface ExtensionConfig {
	/** Append subagent usage guidance to the parent agent's system prompt each turn. Default: true. */
	injectUsageGuidance?: boolean;
	shallow?: SubagentModeConfig;
	deep?: SubagentModeConfig;
	task?: SubagentModeConfig;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface ChildRunDetails {
	mode: SubagentMode;
	toolName: string;
	task: string;
	cwd: string;
	model: string;
	thinking?: ThinkingLevel;
	messages: Message[];
	stderr: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	usage: UsageStats;
}

export type SubagentStatus = "running" | "completed" | "failed";

/** Live state of one subagent run, kept in the in-memory registry. */
export interface SubagentRunState {
	taskId: string;
	mode: SubagentMode;
	task: string;
	cwd: string;
	model: string;
	status: SubagentStatus;
	startedAt: number;
	completedAt?: number;
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
	messages: Message[];
	usage: UsageStats;
	logFile: string;
	/** Most recent tool call, for the live panel. */
	lastToolCall?: { name: string; args: Record<string, unknown> };
}

export interface PersistedChildRunDetails {
	mode: SubagentMode;
	cwd: string;
}

export interface ModeSpec {
	label: string;
	shortDescription: string;
	promptPath: string;
	systemPreamble: string;
}

export interface SubagentMessageDetails {
	status: "running" | "done" | "failed";
	details?: ChildRunDetails;
	error?: string;
}
