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

export const SHALLOW_PROMPT_PATH = path.join(ROOT_DIR, "shallow.prompt.md");
export const DEEP_PROMPT_PATH = path.join(ROOT_DIR, "deep.prompt.md");
export const TASK_PROMPT_PATH = path.join(ROOT_DIR, "task.prompt.md");

export const DEFAULT_CONFIG: Record<
	SubagentMode,
	Required<SubagentModeConfig>
> = {
	shallow: {
		thinking: "low",
	},
	deep: {
		thinking: "low",
	},
	task: {
		thinking: "medium",
	},
};

export const MODE_SPECS = {
	shallow: {
		label: "Shallow",
		shortDescription: "Tight, bounded scan. Find key files and stop early.",
		promptPath: SHALLOW_PROMPT_PATH,
		systemPreamble: "Stay strictly in discovery mode.",
	},
	deep: {
		label: "Deep",
		shortDescription:
			"Broad scan. Good for surveys, triage, and compare/rank work.",
		promptPath: DEEP_PROMPT_PATH,
		systemPreamble: "Stay strictly in discovery mode.",
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
	["shallow", "deep", "task"] as const,
	{
		description:
			"shallow | deep | task — `shallow`: narrow, bounded recon; `deep`: broad surveys / triage / compare-rank; `task`: general work that may edit files and run commands.",
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
