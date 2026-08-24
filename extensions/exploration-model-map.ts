// exploration-model-map: route exploration subagents to a per-main-model
// target model, configured in settings.json:
//
//   "explorationModelMap": {
//     "openai-codex/gpt-5.6-sol": "openai-codex/gpt-5.6-luna"
//   }
//
// Keys and values are full "provider/model-id" names. When the active model
// matches a key, an instruction is injected into the system prompt telling the
// model to dispatch Explore subagents with the mapped model and an explicit
// low/medium thinking level. When no rule matches, nothing is injected.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MARKER = "[exploration-model-map]";
const SETTINGS_KEY = "explorationModelMap";

/** Resolve the pi agent config directory (~/.pi/agent, honoring PI_CODING_AGENT_DIR). */
function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir.startsWith("~/") ? join(homedir(), envDir.slice(2)) : envDir;
	return join(homedir(), ".pi", "agent");
}

/**
 * Read the `explorationModelMap` mapping from pi's settings.json.
 * Shape: { "provider/model-id": "provider/model-id", ... }
 * Any read/parse/shape failure safely degrades to an empty map (no injection).
 */
function readModelMap(): Record<string, string> {
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
	const map = settings[SETTINGS_KEY];
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

/** Build the instruction injected into the system prompt for `targetModel`. */
function buildInstruction(targetModel: string): string {
	return (
		`For codebase exploration or research, call the Agent tool with \`subagent_type\` set to \`Explore\`, ` +
		`\`model\` set to \`${targetModel}\` (the full model name; a bare shorthand is only a fuzzy fallback), ` +
		`and \`thinking\` set explicitly to either \`low\` or \`medium\`, choosing the lower level unless the task ` +
		`requires more reasoning. Do not omit these parameters.`
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const model = ctx.model;
		if (!model) return;

		const targetModel = readModelMap()[`${model.provider}/${model.id}`];
		// No matching rule for the active model: inject nothing.
		if (!targetModel) return;

		if (event.systemPrompt.includes(MARKER)) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${MARKER}\n${buildInstruction(targetModel)}`,
		};
	});
}
