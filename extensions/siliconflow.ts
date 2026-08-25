// siliconflow.ts — SiliconFlow (硅基流动) model provider for pi.
//
// Registers the `siliconflow` provider with dynamic model discovery:
// the async extension factory fetches GET /v1/models before startup
// continues (documented pi behavior), so models appear in /model,
// /login, --list-models, and --model matching on every launch.
//
// SiliconFlow is OpenAI Chat Completions compatible (api: "openai-completions").
// Auth: env var SILICONFLOW_API_KEY, or a key stored via /login siliconflow.
// Without a key the extension is a no-op; pi starts normally.

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { get as httpsGet } from "node:https";

const PROVIDER_ID = "siliconflow";
const BASE_URL = "https://api.siliconflow.cn/v1";
const PRICING_URL = "https://www.siliconflow.cn/pricing";
// Pricing page lists RMB per million tokens; pi cost fields use USD.
const RMB_TO_USD = 1 / 6.8;

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
	return { reasoning, input, contextWindow: 32768, maxTokens: 8192 };
}

// Keep chat/instruct models only; drop embeddings, rerankers, TTS, image/video generation.
const EXCLUDE_PATTERN = /(embed|bge-|rerank|gte-|speech|tts|voice|whisper|fun-audio|cosyvoice|sensevoice|stable-diffusion|flux|kolors|hunyuan-video|cogvideo|video|sd3|hidream|wan2|paddleocr|captioner|mt-)/i;

function isChatModel(m: SiliconFlowModelEntry): boolean {
	if (m.object && m.object !== "model") return false;
	return !EXCLUDE_PATTERN.test(m.id.toLowerCase());
}

function shortName(id: string): string {
	return id.replace(/^(deepseek-ai|Qwen|THUDM|moonshotai|meta-llama|mistralai|ZhipuAI|01-ai|inclusionAI|zai-org|MiniMaxAI|tencent|ByteDance-Seed|stepfun-ai|meituan-longcat|nex-agi|Pro)\//, "");
}

function fetchText(url: string, headers: Record<string, string> = {}, timeoutMs = 10000): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = httpsGet(url, { headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		});
		req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
		req.on("error", reject);
	});
}

// Scrape the chat-model pricing table from the SSR pricing page.
// Each row: <a href=".../models?target=<id>">Name</a> followed by ¥ prices
// (input, output, cache) within the same row. Returns RMB per M tokens.
function parsePricing(html: string): Map<string, { input: number; output: number; cacheRead: number }> {
	const chatStart = html.indexOf("\u5bf9\u8bdd\u6a21\u578b"); // 对话模型
	const chatEnd = html.indexOf("\u751f\u56fe\u6a21\u578b"); // 生图模型
	if (chatStart < 0 || chatEnd < 0 || chatEnd <= chatStart) return new Map();
	const chatHtml = html.slice(chatStart, chatEnd);
	const out = new Map<string, { input: number; output: number; cacheRead: number }>();
	const rowRe = /target=([A-Za-z0-9%._-]+)"[^>]*>([^<]*)<\/a>/g;
	let m: RegExpExecArray | null;
	while ((m = rowRe.exec(chatHtml))) {
		const id = decodeURIComponent(m[1]);
		const rest = chatHtml.slice(m.index, m.index + 2500);
		const prices = [...rest.matchAll(/\u00a5\s*([\d.]+)/g)].map((x) => Number(x[1]));
		if (prices.length >= 2 && !out.has(id)) {
			out.set(id, { input: prices[0], output: prices[1], cacheRead: prices[2] ?? 0 });
		}
	}
	return out;
}

export default async function (pi: ExtensionAPI): Promise<void> {
	let apiKey = process.env.SILICONFLOW_API_KEY;

	// Fall back to a key stored via /login siliconflow (read auth.json directly,
	// ExtensionAPI does not expose the registry).
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
			// no stored auth — fine
		}
	}

	// Register the provider shell even without models, so /login siliconflow
	// works and users can store a key first. Discovery happens next launch.
	let models: ProviderModelConfig[] = [];
	if (apiKey) {
		try {
			const [modelsPayload, pricingHtml] = await Promise.all([
				fetchText(`${BASE_URL}/models?sub_type=chat`, { Authorization: `Bearer ${apiKey}` })
					.then((t) => JSON.parse(t) as { data?: SiliconFlowModelEntry[] }),
				fetchText(PRICING_URL).catch(() => ""),
			]);
			const pricing = parsePricing(pricingHtml);
			models = (modelsPayload.data ?? []).filter(isChatModel).map((m) => {
				const p = pricing.get(m.id);
				const cost = p
					? {
						input: +(p.input * RMB_TO_USD).toFixed(4),
						output: +(p.output * RMB_TO_USD).toFixed(4),
						cacheRead: +(p.cacheRead * RMB_TO_USD).toFixed(4),
						cacheWrite: 0,
					}
					: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
				return {
					id: m.id,
					name: shortName(m.id),
					...modelMeta(m.id),
					cost,
					compat: {
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
						maxTokensField: "max_tokens",
						thinkingFormat: "deepseek",
					},
				};
			});
		} catch {
			// Network failure → empty list this launch; pi still starts.
		}
	}

	pi.registerProvider(PROVIDER_ID, {
		name: "SiliconFlow",
		baseUrl: BASE_URL,
		apiKey: "$SILICONFLOW_API_KEY",
		api: "openai-completions",
		models,
	});
}
