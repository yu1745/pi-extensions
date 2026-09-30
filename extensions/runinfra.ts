// runinfra.ts — RunInfra model provider for pi.
//
// Registers the `runinfra` provider with dynamic model discovery.
// Auth: env var RUNINFRA_API_KEY / RUNINFRA_GATEWAY_KEY, or /login runinfra.
// Compatible with OpenAI chat completions.

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { get as httpsGet } from "node:https";

const PROVIDER_ID = "runinfra";
const PROVIDER_NAME = "RunInfra";
const BASE_URL = "https://api.runinfra.ai/v1";

interface RunInfraModelEntry {
	id: string;
	display_name?: string;
	context_window?: number;
	context_length?: number;
	max_output_tokens?: number;
	max_completion_tokens?: number;
	input_modalities?: string[];
	reasoning_efforts?: string[];
	pricing?: {
		input?: number;
		output?: number;
	};
	cached_input_price?: number;
	cached_input_price_usd_per_mtok?: number;
}

const STATIC_MODELS: ProviderModelConfig[] = [
	{
		id: "glm-5-3-flash",
		name: "GLM 5.3 Flash",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 16384,
		cost: { input: 0.11, output: 0.45, cacheRead: 0.03, cacheWrite: 0 },
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "deepseek",
		},
	},
	{
		id: "deepseek-v4-1-flash",
		name: "DeepSeek V4.1 Flash",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128000,
		maxTokens: 16384,
		cost: { input: 0.14, output: 0.58, cacheRead: 0.03, cacheWrite: 0 },
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "deepseek",
		},
	},
	{
		id: "nemotron-3-5-lightning-30b",
		name: "Nemotron 3.5 Lightning 30B",
		reasoning: true,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 16384,
		cost: { input: 0.05, output: 0.15, cacheRead: 0.01, cacheWrite: 0 },
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	},
	{
		id: "qwen3-8-27b",
		name: "Qwen3.8 27B",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 131072,
		maxTokens: 16384,
		cost: { input: 0.10, output: 0.40, cacheRead: 0.01, cacheWrite: 0 },
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "deepseek",
		},
	},
	{
		id: "ornith-1-5-35b",
		name: "Ornith 1.5 35B",
		reasoning: true,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 16384,
		cost: { input: 0.10, output: 0.40, cacheRead: 0.01, cacheWrite: 0 },
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	},
];

function fetchJson(url: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<any> {
	return new Promise((resolve, reject) => {
		const req = httpsGet(url, { headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch (err) {
					reject(err);
				}
			});
		});
		req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
		req.on("error", reject);
	});
}

export default async function (pi: ExtensionAPI): Promise<void> {
	let apiKey = process.env.RUNINFRA_API_KEY || process.env.RUNINFRA_GATEWAY_KEY;

	if (!apiKey) {
		try {
			const { readFileSync } = await import("node:fs");
			const { join } = await import("node:path");
			const os = await import("node:os");
			const authPath = join(os.homedir(), ".pi", "agent", "auth.json");
			const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { type?: string; key?: string }>;
			const cred = auth[PROVIDER_ID];
			if (cred?.key) apiKey = cred.key;
		} catch {
			// no stored auth
		}
	}

	let models: ProviderModelConfig[] = STATIC_MODELS;

	if (apiKey) {
		try {
			const res = await fetchJson(`${BASE_URL}/models`, { Authorization: `Bearer ${apiKey}` });
			if (Array.isArray(res?.data) && res.data.length > 0) {
				models = res.data.map((m: RunInfraModelEntry) => {
					const staticMatch = STATIC_MODELS.find((s) => s.id === m.id);
					const input: ("text" | "image")[] = m.input_modalities?.includes("image")
						? ["text", "image"]
						: (staticMatch?.input ?? ["text"]);
					const costInput = m.pricing?.input ?? staticMatch?.cost.input ?? 0;
					const costOutput = m.pricing?.output ?? staticMatch?.cost.output ?? 0;
					const costCache = m.cached_input_price ?? m.cached_input_price_usd_per_mtok ?? staticMatch?.cost.cacheRead ?? 0;

					return {
						id: m.id,
						name: m.display_name ?? staticMatch?.name ?? m.id,
						reasoning: staticMatch?.reasoning ?? true,
						input,
						contextWindow: m.context_window ?? m.context_length ?? staticMatch?.contextWindow ?? 131072,
						maxTokens: m.max_completion_tokens ?? m.max_output_tokens ?? staticMatch?.maxTokens ?? 16384,
						cost: {
							input: costInput,
							output: costOutput,
							cacheRead: costCache,
							cacheWrite: 0,
						},
						compat: staticMatch?.compat ?? {
							supportsDeveloperRole: false,
							supportsReasoningEffort: false,
							maxTokensField: "max_tokens",
						},
					};
				});
			}
		} catch {
			// fallback to static models
		}
	}

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		apiKey: "$RUNINFRA_API_KEY",
		api: "openai-completions",
		models,
	});
}
