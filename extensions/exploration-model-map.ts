// exploration-model-map: route subagents to per-main-model target models,
// configured in settings.json:
//
//   "explorationModelMap": {
//     "openai-codex/gpt-5.6-sol": "openai-codex/gpt-5.6-luna"
//   },
//   "generalPurposeModelMap": {
//     "openai-codex/gpt-5.6-sol": "openai-codex/gpt-5.6-luna"
//   }
//
// Keys and values are full "provider/model-id" names. When the active model
// matches a key, an instruction is injected into the system prompt telling the
// model to dispatch the corresponding subagent type (Explore via
// explorationModelMap, general-purpose via generalPurposeModelMap) with the
// mapped model and an explicit thinking level. The target model's supported
// thinking levels are resolved from the model registry's thinkingLevelMap and
// injected as the allowed values; without a thinkingLevelMap the instruction
// is still injected but without a level list. If the target model cannot be
// found in the registry, nothing is injected for that subagent type.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MARKER = "[exploration-model-map]";
const SETTINGS_KEYS = ["explorationModelMap", "generalPurposeModelMap"] as const;
const SUBAGENT_TYPES: Record<(typeof SETTINGS_KEYS)[number], string> = {
	explorationModelMap: "Explore",
	generalPurposeModelMap: "general-purpose",
};

/** Resolve the pi agent config directory (~/.pi/agent, honoring PI_CODING_AGENT_DIR). */
function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir.startsWith("~/") ? join(homedir(), envDir.slice(2)) : envDir;
	return join(homedir(), ".pi", "agent");
}

/**
 * Read a model mapping from pi's settings.json by settings key.
 * Shape: { "provider/model-id": "provider/model-id", ... }
 * Any read/parse/shape failure safely degrades to an empty map (no injection).
 */
function readModelMap(key: string): Record<string, string> {
	let raw: string;
	try {
		raw = readFileSync(join(getAgentDir(), "settings.json"), "utf-8");
	} catch {
		return {};
	}
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(raw);
	} catch {
		return {};
	}
	const map = settings[key];
	if (map === null || typeof map !== "object" || Array.isArray(map)) return {};
	// Keep only "provider/model" -> "provider/model" string pairs.
	const result: Record<string, string> = {};
	for (const [from, to] of Object.entries(map as Record<string, unknown>)) {
		if (typeof to === "string" && from.includes("/") && to.includes("/")) {
			result[from] = to;
		}
	}
	return result;
}

/** Canonical pi thinking level order. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type LevelMap = Partial<Record<(typeof THINKING_LEVELS)[number], string | null>>;
type Registry = { find(provider: string, modelId: string): { thinkingLevelMap?: LevelMap } | undefined };

/**
 * Resolve the thinking levels supported by `targetModel` from its
 * thinkingLevelMap (non-null entries, in canonical order). Returns undefined
 * when the model is unknown, null when it has no thinkingLevelMap.
 */
function resolveThinkingLevels(modelRegistry: Registry, targetModel: string): string[] | null | undefined {
	const slash = targetModel.indexOf("/");
	if (slash <= 0) return null;
	let target: ReturnType<Registry["find"]>;
	try {
		target = modelRegistry.find(targetModel.slice(0, slash), targetModel.slice(slash + 1));
	} catch {
		return undefined;
	}
	if (!target) return undefined;
	if (!target.thinkingLevelMap) return null;
	return THINKING_LEVELS.filter((level) => target.thinkingLevelMap?.[level] != null);
}

/** Build the instruction injected into the system prompt for one subagent type. */
function buildInstruction(
	subagentType: string,
	targetModel: string,
	levels: string[] | null,
	freeThinking: boolean,
): string {
	const levelList = levels ? levels.join(", ") : null;
	return (
		(freeThinking
			? `When calling the Agent tool with \`subagent_type\` set to \`${subagentType}\`, set \`model\` to \`${targetModel}\` `
			: `For codebase exploration or research, call the Agent tool with \`subagent_type\` set to \`${subagentType}\`, ` +
				`\`model\` set to \`${targetModel}\` `) +
		`(the full model name; a bare shorthand is only a fuzzy fallback), ` +
		(freeThinking
			? levelList
				? `and \`thinking\` to one of ${levelList}, choosing the level appropriate for the task's difficulty. `
				: `and \`thinking\` to the level appropriate for the task's difficulty. `
			: `and \`thinking\` set explicitly to either \`low\` or \`medium\`, choosing the lower level unless the task ` +
				`requires more reasoning. `) +
		`Do not omit these parameters.`
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const model = ctx.model;
		if (!model) return;

		const active = `${model.provider}/${model.id}`;
		const instructions: string[] = [];
		for (const key of SETTINGS_KEYS) {
			const targetModel = readModelMap(key)[active];
			// No matching rule for the active model: skip this subagent type.
			if (!targetModel) continue;
			// Unknown target model: skip this subagent type entirely.
			const levels = resolveThinkingLevels(ctx.modelRegistry, targetModel);
			if (levels === undefined) continue;
			// No thinkingLevelMap (levels === null): inject without a level list.
			instructions.push(
				buildInstruction(SUBAGENT_TYPES[key], targetModel, levels, key === "generalPurposeModelMap"),
			);
		}
		if (instructions.length === 0) return;

		if (event.systemPrompt.includes(MARKER)) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${MARKER}\n${instructions.join("\n")}`,
		};
	});
}
