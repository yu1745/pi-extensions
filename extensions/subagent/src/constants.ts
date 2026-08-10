import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type {
	SubagentMode,
	SubagentModeConfig,
	ThinkingLevel,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

export const CONFIG_FILENAME = "pi-subagent.json";
export const PACKAGE_CONFIG_PATH = path.join(ROOT_DIR, "config.json");
export const CHILD_ENV = "PI_SUBAGENT_CHILD";
export const TOOL_NAME = "subagent";
export const TOOL_LABEL = "Subagent";
export const SPAWN_TOOL_NAME = "spawn_subagent";
export const SPAWN_TOOL_LABEL = "Spawn Subagent";
export const WAIT_TOOL_NAME = "wait_subagent";
export const WAIT_TOOL_LABEL = "Wait Subagent";

/** Keyboard shortcuts (mirroring Codex's Alt+Left/Alt+Right agent switching). */
export const PANEL_TOGGLE_SHORTCUT = "ctrl+shift+s";
export const PREV_AGENT_SHORTCUT = "alt+left";
export const NEXT_AGENT_SHORTCUT = "alt+right";

export const DONE_MESSAGE_TYPE = "subagent-done";

export const STATUS_BAR_KEY = "subagents";

/**
 * Appended to the parent agent's system prompt on every turn (before_agent_start)
 * when injectUsageGuidance is enabled (default). Tool descriptions are easy for
 * models to ignore; a system-prompt policy drives actual delegation behavior.
 */
export const USAGE_GUIDANCE = `### Subagent delegation policy

You have subagent tools and should delegate aggressively instead of doing everything inline:
- \`spawn_subagent\` — background, returns immediately; collect the result later with \`wait_subagent\`. Prefer this whenever you can continue other work in parallel; launch several in parallel within a single message when the subtasks are independent.
- \`subagent\` — blocking; use when you need the result before you can proceed.
- \`wait_subagent\` — collect a finished background subagent's full result; call sparingly, only when the result blocks your very next step.

Delegate concrete, bounded sidecar work — recon, surveys, isolated implementations, experiments — instead of consuming many of your own turns on it. Keep urgent critical-path work local; never delegate work that needs live back-and-forth (the subagent cannot reply to follow-ups).

Mode choice: \`shallow\` = read-only recon (answer a specific codebase question with file/line evidence and stop); \`task\` = general work that may read, write, edit, and run commands (must return a changed-files manifest).

Trust subagent results. Do not re-verify a subagent's findings by re-reading the same files yourself — you may still inspect code for your own context when you genuinely need it, but do not redo the subagent's investigation. Re-running a subagent's search yourself wastes turns and undermines delegation.

Write self-contained task briefs: background and context, exact goal, scope and boundaries (what to touch and what NOT to touch), constraints, cwd, and precisely what to return in the final message.`;

export const SHALLOW_PROMPT_PATH = path.join(ROOT_DIR, "shallow.prompt.md");
export const TASK_PROMPT_PATH = path.join(ROOT_DIR, "task.prompt.md");

export const DEFAULT_CONFIG: Record<
	SubagentMode,
	Required<SubagentModeConfig>
> = {
	shallow: {
		thinking: "low",
	},
	task: {
		thinking: "medium",
	},
};

export const MODE_SPECS = {
	shallow: {
		label: "Shallow",
		shortDescription:
			"Read-only recon. Answer a specific codebase question with concrete evidence and stop.",
		promptPath: SHALLOW_PROMPT_PATH,
		systemPreamble: "Stay strictly in discovery mode. Read-only.",
	},
	task: {
		label: "Task",
		shortDescription:
			"General-purpose work. May read, write, edit, and run commands. Returns a changed-files manifest.",
		promptPath: TASK_PROMPT_PATH,
		systemPreamble:
			"You are a general-purpose worker. Edits and commands are allowed.",
	},
} as const;

export const ALLOWED_THINKING = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
export const RPC_READY_TIMEOUT_MS = 10_000;
export const RPC_RESPONSE_TIMEOUT_MS = 30_000;

export function getAgentDir(): string {
	const configured = process.env["PI_CODING_AGENT_DIR"]?.trim();
	return configured || path.join(os.homedir(), ".pi", "agent");
}

export function getConfigPath(): string {
	return path.join(getAgentDir(), CONFIG_FILENAME);
}

export const SubagentModeSchema = StringEnum(
	["shallow", "task"] as const,
	{
		description:
			"shallow | task — `shallow`: read-only recon that answers a specific codebase question with evidence and stops; `task`: general work that may edit files and run commands.",
	},
) as any;

export const SubagentParams = Type.Object({
	task: Type.String({
		description:
			"Self-contained task brief. The subagent has no access to this conversation, so include: background and context, the exact goal, scope and boundaries (what to touch and what NOT to touch), constraints, cwd, and precisely what to return in its final message (e.g. file paths with line ranges, findings, or a changed-files list).",
	}),
	mode: SubagentModeSchema,
	cwd: Type.Optional(
		Type.String({ description: "Working directory. Defaults to current cwd." }),
	),
}) as any;
