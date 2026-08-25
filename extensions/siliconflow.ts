// siliconflow.ts — SiliconFlow (硅基流动) model provider for pi.
//
// Registers the `siliconflow` provider with native dynamic model refresh:
// refreshModels() fetches GET /v1/models and publishes the catalog through
// context.publish({ persist }), so pi caches it across sessions, re-checks
// on its normal freshness schedule, and lists models in /model, /login,
// --list-models, and --model matching — just like a built-in provider.
//
// SiliconFlow is OpenAI Chat Completions compatible (api: "openai-completions").
// Auth: env var SILICONFLOW_API_KEY, or a key stored via /login siliconflow.

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Model, RefreshModelsContext } from "@earendil-works/pi-ai";

const PROVIDER_ID = "siliconflow";
const BASE_URL = "https://api.siliconflow.cn/v1";

interface SiliconFlowModelEntry {
	id: string;
	object?: string;
}

// Known reasoning model families → enable pi thinking controls.
const REASONING_PATTERN = /(deepseek-r1|deepseek-v3\.1|deepseek-v3\.2|deepseek-v4|glm-5|glm-z1|qwen3|kimi-k2|qwq|minimax-m2|thinking|reasoner)/i;

function modelMeta(id: string): Pick<ProviderModelConfig, "contextWindow" | "maxTokens" | "reasoning" | "input"> {
	const lower = id.toLowerCase();
	const reasoning = REASONING_PATTERN.test(lower) && !/-instruct(?!.*thinking)/i.test(lower);
	const vision = /vl|vision|omni|ocr|4\.5v/i.test(lower);
	const input: ("text" | "image")[] = vision ? ["text", "image"] : ["text"];

	if (/deepseek-v4|deepseek-v3\.2/i.test(lower)) return { reasoning: true, input, contextWindow: 128000, maxTokens: 65536 };
	if (/deepseek-v3\.1/i.test(lower)) return { reasoning: true, input, contextWindow: 65536, maxTokens: 16384 };
	if (/deepseek/i.test(lower)) return { reasoning, input, contextWindow: 65536, maxTokens: 16384 };
	if (/kimi-k2|glm-5|qwen3\.[56]|minimax-m2|longcat|nex-n2/i.test(lower)) return { reasoning: true, input, contextWindow: 262144, maxTokens: 32768 };
	if (/qwq/i.test(lower)) return { reasoning: true, input, contextWindow: 131072, maxTokens: 16384 };
	if (/qwen/i.test(lower)) return { reasoning, input, contextWindow: 131072, maxTokens: 16384 };
	if (/glm/i.test(lower)) return { reasoning, input, contextWindow: 128000, maxTokens: 16384 };
	if (/kimi|moonshot/i.test(lower)) return { reasoning, input, contextWindow: 131072, maxTokens: 16384 };
	if (/gpt-4o|claude|gemini/i.test(lower)) return { reasoning, input, contextWindow: 128000, maxTokens: 16384 };
	return { reasoning, input, contextWindow: 32768, maxTokens: 8192 };
}

// Keep chat/instruct models only; drop embeddings, rerankers, TTS, image/video generation.
const EXCLUDE_PATTERN = /(embed|bge-|rerank|gte-|speech|tts|voice|whisper|fun-audio|cosyvoice|sensevoice|stable-diffusion|flux|kolors|hunyuan-video|cogvideo|video|sd3|hidream|wan2)/i;

function isChatModel(m: SiliconFlowModelEntry): boolean {
	if (m.object && m.object !== "model") return false;
	return !EXCLUDE_PATTERN.test(m.id.toLowerCase());
}

function shortName(id: string): string {
	return id.replace(/^(deepseek-ai|Qwen|THUDM|moonshotai|meta-llama|mistralai|ZhipuAI|01-ai|inclusionAI)\//, "");
}

// Seed catalog: available before the first successful network refresh
// (pi creates some runtimes with allowNetwork: false, e.g. --list-models).
const SEED_MODELS: Model<"openai-completions">[] = [
	"deepseek-ai/DeepSeek-V3.2",
	"deepseek-ai/DeepSeek-R1",
	"Qwen/Qwen3-Coder-30B-A3B-Instruct",
	"Qwen/Qwen3-32B",
	"zai-org/GLM-5.2",
	"moonshotai/Kimi-K2.7-Code",
	"MiniMaxAI/MiniMax-M2.5",
].map((id) => ({
	id,
	name: shortName(id),
	api: "openai-completions" as const,
	provider: PROVIDER_ID,
	baseUrl: BASE_URL,
	...modelMeta(id),
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));

async function fetchModels(apiKey: string, signal: AbortSignal): Promise<Model<"openai-completions">[]> {
	const res = await fetch(`${BASE_URL}/models?sub_type=chat`, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal,
	});
	if (!res.ok) throw new Error(`SiliconFlow /v1/models returned ${res.status}`);
	const payload = (await res.json()) as { data?: SiliconFlowModelEntry[] };
	return (payload.data ?? []).filter(isChatModel).map((m) => ({
		id: m.id,
		name: shortName(m.id),
		api: "openai-completions" as const,
		provider: PROVIDER_ID,
		baseUrl: BASE_URL,
		...modelMeta(m.id),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [] },
	}));
}

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, {
		name: "SiliconFlow",
		baseUrl: BASE_URL,
		apiKey: "$SILICONFLOW_API_KEY",
		api: "openai-completions",
		models: [...SEED_MODELS],

		// Native refresh channel: pi calls this on its freshness schedule
		// (and on /model open when stale). The catalog persists across
		// sessions, so models stay available offline between checks.
		async refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
			// Offline (e.g. --list-models) → keep persisted catalog, or the seed.
			if (!context.allowNetwork || context.signal.aborted) {
				return context.stored?.models?.length ? [...context.stored.models] : SEED_MODELS;
			}

			let apiKey = process.env.SILICONFLOW_API_KEY;
			if (!apiKey && context.credential) {
				const cred = context.credential as { type?: string; key?: string };
				if (cred.type === "api_key" && cred.key) apiKey = cred.key;
			}
			if (!apiKey) return context.stored?.models ? [...context.stored.models] : SEED_MODELS;

			try {
				const models = await fetchModels(apiKey, context.signal);

			await context.publish({
				persist: {
					models,
					lastModified: Date.now(),
					checkedAt: Date.now(),
				},
			});

			return models;
			} catch {
				// Network failure → keep whatever is cached/seeded.
				return context.stored?.models ? [...context.stored.models] : SEED_MODELS;
			}
		},
	});
}
