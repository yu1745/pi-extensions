// subagent-model-map: route subagents to per-main-model target models,
// configured in settings.json:
//
//   "explorationModelMap": {
//     "openai-codex/gpt-5.6-sol": {
//       "model": "openai-codex/gpt-5.6-luna",
//       "thinkingLevels": ["low", "medium"]
//     }
//   },
//   "generalPurposeModelMap": {
//     "openai-codex/gpt-5.6-sol": {
//       "model": "openai-codex/gpt-5.6-luna",
//       "thinkingLevels": ["minimal", "low", "medium", "high"]
//     }
//   }
//
// The value may also be a plain "provider/model-id" string, in which case no
// thinking level list is injected. Keys and values are full "provider/model-id"
// names. Both global (~/.pi/agent/settings.json) and project
// (<cwd>/.pi/settings.json) settings are read; per-key, project entries
// override global ones. When the active model matches a key, an instruction
// is injected into the system prompt telling the model to dispatch the
// corresponding subagent type (Explore via explorationModelMap,
// general-purpose via generalPurposeModelMap) with the mapped model. If
// `thinkingLevels` is provided, it is injected as the allowed values;
// otherwise Explore falls back to low/medium and general-purpose to choosing
// freely by task difficulty.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MARKER = "[subagent-model-map]";
const SETTINGS_KEYS = ["explorationModelMap", "generalPurposeModelMap"] as const;
const SUBAGENT_TYPES: Record<(typeof SETTINGS_KEYS)[number], string> = {
	explorationModelMap: "Explore",
	generalPurposeModelMap: "general-purpose",
};

/** All valid pi thinking level names. */
const VALID_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Parsed mapping entry: target model plus optional allowed thinking levels. */
type Target = { model: string; levels: string[] | null };

/** Resolve the pi agent config directory (~/.pi/agent, honoring PI_CODING_AGENT_DIR). */
function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir.startsWith("~/") ? join(homedir(), envDir.slice(2)) : envDir;
	return join(homedir(), ".pi", "agent");
}

/** Validate and normalize one mapping value. Returns undefined if invalid. */
function parseTarget(value: unknown): Target | undefined {
	// Plain string form: "provider/model-id", no level list.
	if (typeof value === "string") {
		return value.includes("/") ? { model: value, levels: null } : undefined;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	const model = obj["model"];
	if (typeof model !== "string" || !model.includes("/")) return undefined;
	const levels = obj["thinkingLevels"];
	if (levels === undefined) return { model, levels: null };
	if (!Array.isArray(levels)) return undefined;
	const valid = levels.filter((l): l is string => typeof l === "string" && VALID_LEVELS.has(l));
	return { model, levels: valid.length > 0 ? valid : null };
}

/** Parse one settings file and extract the validated map under `key`. */
function parseModelMap(raw: string, key: string): Record<string, Target> {
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(raw);
	} catch {
		return {};
	}
	const map = settings[key];
	if (map === null || typeof map !== "object" || Array.isArray(map)) return {};
	const result: Record<string, Target> = {};
	for (const [from, to] of Object.entries(map as Record<string, unknown>)) {
		const target = parseTarget(to);
		if (target && from.includes("/")) result[from] = target;
	}
	return result;
}

/**
 * Read a model mapping by settings key from pi's settings files:
 * the global ~/.pi/agent/settings.json and the project <cwd>/.pi/settings.json.
 * Per-key, project entries override global ones. Any read/parse/shape failure
 * safely degrades to skipping that file (no injection from it).
 */
function readModelMap(key: string): Record<string, Target> {
	const files = [join(getAgentDir(), "settings.json"), join(process.cwd(), ".pi", "settings.json")];
	const merged: Record<string, Target> = {};
	for (const file of files) {
		let raw: string;
		try {
			raw = readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		Object.assign(merged, parseModelMap(raw, key));
	}
	return merged;
}

/** Build the instruction injected into the system prompt for one subagent type. */
function buildInstruction(subagentType: string, target: Target, freeThinking: boolean): string {
	const levelList = target.levels ? target.levels.join(", ") : null;
	return (
		(freeThinking
			? `When calling the Agent tool with \`subagent_type\` set to \`${subagentType}\`, set \`model\` to \`${target.model}\` `
			: `For codebase exploration or research, call the Agent tool with \`subagent_type\` set to \`${subagentType}\`, ` +
				`\`model\` set to \`${target.model}\` `) +
		`(the full model name; a bare shorthand is only a fuzzy fallback), ` +
		(freeThinking
			? levelList
				? `and \`thinking\` to one of ${levelList}, choosing the level appropriate for the task's difficulty. `
				: `and \`thinking\` to the level appropriate for the task's difficulty. `
			: levelList
				? `and \`thinking\` set explicitly to one of ${levelList}. `
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
			const target = readModelMap(key)[active];
			// No matching rule for the active model: skip this subagent type.
			if (!target) continue;
			instructions.push(buildInstruction(SUBAGENT_TYPES[key], target, key === "generalPurposeModelMap"));
		}
		if (instructions.length === 0) return;

		if (event.systemPrompt.includes(MARKER)) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${MARKER}\n${instructions.join("\n")}`,
		};
	});
}
