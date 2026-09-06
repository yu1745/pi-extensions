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
//     "openai-codex/gpt-5.6-sol": [
//       { "model": "openai-codex/gpt-5.6-terra", "description": "routine or medium tasks" },
//       { "model": "openai-codex/gpt-5.6-sol", "description": "complex architecture or deep analysis" }
//     ]
//   }
//
// The value may also be:
// - A plain "provider/model-id" string
// - A single Target object { model: string, thinkingLevels?: string[], description?: string }
// - An array of (Target | string) items
//
// Keys and values are full "provider/model-id" names. Both global
// (~/.pi/agent/settings.json) and project (<cwd>/.pi/settings.json) settings
// are read; per-key, project entries override global ones. When the active
// model matches a key, an instruction is injected into the system prompt telling
// the model to dispatch the corresponding subagent type with the mapped model(s).

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

/** Parsed mapping entry: target model plus optional allowed thinking levels and description. */
type Target = { model: string; levels: string[] | null; description?: string };

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
	const description = typeof obj["description"] === "string" ? obj["description"] : undefined;
	const levels = obj["thinkingLevels"];
	if (levels === undefined) return { model, levels: null, description };
	if (!Array.isArray(levels)) return undefined;
	const valid = levels.filter((l): l is string => typeof l === "string" && VALID_LEVELS.has(l));
	return { model, levels: valid.length > 0 ? valid : null, description };
}

/** Parse target or array of targets from one config entry. */
function parseTargetList(value: unknown): Target[] {
	if (Array.isArray(value)) {
		const list: Target[] = [];
		for (const item of value) {
			const parsed = parseTarget(item);
			if (parsed) list.push(parsed);
		}
		return list;
	}
	const single = parseTarget(value);
	return single ? [single] : [];
}

/** Parse one settings file and extract the validated map under `key`. */
function parseModelMap(raw: string, key: string): Record<string, Target[]> {
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(raw);
	} catch {
		return {};
	}
	const map = settings[key];
	if (map === null || typeof map !== "object" || Array.isArray(map)) return {};
	const result: Record<string, Target[]> = {};
	for (const [from, to] of Object.entries(map as Record<string, unknown>)) {
		const targets = parseTargetList(to);
		if (targets.length > 0 && from.includes("/")) result[from] = targets;
	}
	return result;
}

/**
 * Read a model mapping by settings key from pi's settings files:
 * the global ~/.pi/agent/settings.json and the project <cwd>/.pi/settings.json.
 * Per-key, project entries override global ones. Any read/parse/shape failure
 * safely degrades to skipping that file (no injection from it).
 */
function readModelMap(key: string): Record<string, Target[]> {
	const files = [join(getAgentDir(), "settings.json"), join(process.cwd(), ".pi", "settings.json")];
	const merged: Record<string, Target[]> = {};
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
function buildInstruction(subagentType: string, targets: Target[], freeThinking: boolean): string {
	if (targets.length === 0) return "";

	if (targets.length === 1) {
		const target = targets[0];
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

	// Multiple candidate models
	const optionsList = targets
		.map((t) => {
			let line = `- \`${t.model}\``;
			if (t.description) line += `: ${t.description}`;
			if (t.levels && t.levels.length > 0) {
				line += ` (allowed thinking: ${t.levels.join(", ")})`;
			}
			return line;
		})
		.join("\n");

	return (
		`When calling the Agent tool with \`subagent_type\` set to \`${subagentType}\`, choose the most suitable model from the following candidate models based on the task complexity (always provide the full model name as specified below):\n` +
		`${optionsList}\n` +
		(freeThinking
			? `Set \`thinking\` to a level appropriate for the task's difficulty (respecting any listed allowed thinking levels for the chosen model). `
			: `Set \`thinking\` explicitly (preferring \`low\` or \`medium\` unless more reasoning is required, and respecting any listed allowed levels). `) +
		`Do not omit \`model\` or \`thinking\`.`
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const model = ctx.model;
		if (!model) return;

		const active = `${model.provider}/${model.id}`;
		const instructions: string[] = [];
		for (const key of SETTINGS_KEYS) {
			const targets = readModelMap(key)[active];
			// No matching rule for the active model: skip this subagent type.
			if (!targets || targets.length === 0) continue;
			const inst = buildInstruction(SUBAGENT_TYPES[key], targets, key === "generalPurposeModelMap");
			if (inst) instructions.push(inst);
		}
		if (instructions.length === 0) return;

		if (event.systemPrompt.includes(MARKER)) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${MARKER}\n${instructions.join("\n")}`,
		};
	});
}
