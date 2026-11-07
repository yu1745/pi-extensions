/**
 * 翻译调用：挑模型、拼 prompt、分块、收尾。
 *
 * 这里不直接碰 ctx，调用方把 `complete` 传进来（生产环境是
 * `ctx.modelRegistry.complete`），单测可以传假实现。
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { chunkMarkdown } from "./detect.ts";

/** `provider/modelId`（provider 里也可能带 `/`，所以从「已知 provider 前缀」匹配） */
export function parseModelRef(ref: string): { provider: string; id: string } | null {
	const trimmed = ref.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return null;
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

/** 便宜的翻译模型长这样：flash / mini / fast / haiku / lite / turbo */
const CHEAP_MODEL = /(flash|mini|fast|haiku|lite|turbo|nano)/i;

/**
 * 挑翻译模型：显式配置优先；其次是「可用的便宜模型」，按输入单价从低到高。
 * 返回候选序列，调用方（index.ts）从前往后试，一个失败就换下一个。
 */
export function rankTranslateModels(
	available: readonly Model<Api>[],
	options: { preferred?: string; fallback?: Model<Api> | null } = {},
): Model<Api>[] {
	const { preferred, fallback } = options;
	const ranked: Model<Api>[] = [];
	const push = (model: Model<Api> | null | undefined) => {
		if (model && !ranked.some((item) => item.provider === model.provider && item.id === model.id)) ranked.push(model);
	};
	if (preferred && preferred.trim()) {
		const ref = parseModelRef(preferred);
		if (ref) {
			push(available.find((model) => model.provider === ref.provider && model.id === ref.id));
			// 只写了模型 id 时按 id 匹配
			push(available.find((model) => model.id === preferred.trim()));
		} else {
			push(available.find((model) => model.id === preferred.trim()));
		}
	}
	const cheap = available
		.filter((model) => CHEAP_MODEL.test(model.id))
		// 优先挑上下文小、单价低的（flash 类通常两者都小），同名时稳定排序
		.sort((a, b) => (a.cost?.input ?? 0) - (b.cost?.input ?? 0) || a.id.localeCompare(b.id));
	for (const model of cheap) push(model);
	push(fallback);
	return ranked;
}

/** 候选序列的第一个；没有就是 null */
export function chooseTranslateModel(
	available: readonly Model<Api>[],
	options: { preferred?: string; fallback?: Model<Api> | null } = {},
): Model<Api> | null {
	return rankTranslateModels(available, options)[0] ?? null;
}

export function buildTranslationSystemPrompt(targetLanguage: string): string {
	return [
		`你是思考过程的翻译器。把用户给出的模型思考内容（英文等外语的推理过程）翻译成${targetLanguage}。`,
		"规则：",
		"1. 代码块、行内代码、命令行、文件路径、URL、变量名、函数名、库名、模型名保持原样，不要翻译；",
		"2. 保持原有的 Markdown 结构、段落数、列表项和顺序，不要合并、删减或补充内容；",
		"3. 专业术语首次出现时写成「中文（English）」，之后用中文；",
		"4. 只输出译文本身，不要任何前言、后记、解释，也不要用代码块把结果包起来。",
	].join("\n");
}

export interface TranslateOptions {
	targetLanguage: string;
	maxChars: number;
	/** 单块请求的完成函数：返回助手输出的纯文本 */
	complete: (systemPrompt: string, userText: string) => Promise<string>;
	/** 用于取消（会话切换、用户按 Esc 等） */
	signal?: AbortSignal;
}

/** 分块翻译后按原顺序拼回去；空块直接丢弃 */
export async function translateMarkdown(text: string, options: TranslateOptions): Promise<string> {
	const systemPrompt = buildTranslationSystemPrompt(options.targetLanguage);
	const chunks = chunkMarkdown(text, options.maxChars);
	const parts: string[] = [];
	for (const chunk of chunks) {
		if (options.signal?.aborted) throw new Error("aborted");
		if (!chunk.trim()) continue;
		const translated = await options.complete(systemPrompt, chunk);
		const cleaned = cleanTranslation(translated);
		if (cleaned) parts.push(cleaned);
	}
	return parts.join("\n\n");
}

/** 模型有时会带上 ``` 包裹或「以下是翻译：」之类的壳，去掉 */
export function cleanTranslation(raw: string): string {
	let text = raw.trim();
	text = text.replace(/^(?:以下是|这是)?(?:译文|翻译)(?:如下)?[:：]\s*/u, "");
	const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text);
	if (fenced) text = fenced[1];
	return text.trim();
}

/** 从 AssistantMessage.content 里抽纯文本；非文本块忽略 */
export function assistantText(message: { content: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const typed = block as { type?: string; text?: unknown };
			return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
		})
		.join("");
}
