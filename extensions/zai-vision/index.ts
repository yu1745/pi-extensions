/**
 * ZAI Vision Extension
 *
 * Native pi port of @z_ai/mcp-server@0.1.4 (智谱官方视觉 MCP)。
 * 提供 8 个图像/视频分析工具，全部通过智谱 GLM-4.6V chat/completions 接口实现。
 *
 * 不依赖 npm 包，直接 HTTP 调用（与 web-search 扩展风格一致）。
 * 所有系统提示词原样照搬自官方包，保证输出质量。
 *
 * 工具列表：
 *   图像 (6):
 *     - ui_to_artifact           UI 截图转前端代码 / AI prompt / 设计规范 / 自然语言描述
 *     - extract_text_from_screenshot  OCR 文本提取（代码/终端输出/文档）
 *     - diagnose_error_screenshot    错误截图诊断与排错
 *     - understand_technical_diagram  技术图表理解（架构/流程/UML/ER/时序图）
 *     - analyze_data_visualization   数据可视化分析（图表洞察）
 *     - ui_diff_check             UI 视觉回归对比
 *   通用 (1):
 *     - analyze_image            通用图像分析（兜底）
 *   视频 (1):
 *     - analyze_video            视频内容分析（MP4/MOV/M4V，≤8MB）
 *
 * 配置：
 *   优先读环境变量，回退到 zai-coding-cn provider 的登录 key（与 web-search 扩展同源）。
 *     Z_AI_VISION_API_KEY   API key（回退 Z_AI_MCP_API_KEY）
 *     Z_AI_VISION_BASE_URL  接口基址（默认智谱 https://open.bigmodel.cn/api/paas/v4/）
 *     Z_AI_VISION_MODEL     视觉模型（默认 glm-4.6v）
 *   env 均未设置时，从当前 pi 的 auth 配置里拿 zai-coding-cn 的 key（与当前模型 provider 无关）。
 *
 * 放置位置：~/.pi/agent/extensions/zai-vision/（已在此处）
 * 重新加载：交互模式下输入 /reload
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import {
	TEXT_EXTRACTION_PROMPT,
	ERROR_DIAGNOSIS_PROMPT,
	DIAGRAM_UNDERSTANDING_PROMPT,
	DATA_VIZ_ANALYSIS_PROMPT,
	UI_DIFF_CHECK_PROMPT,
	GENERAL_IMAGE_ANALYSIS_PROMPT,
	UI_TO_ARTIFACT_PROMPTS,
} from "./prompts";

// ─── Config ────────────────────────────────────────────────────────────────────

interface VisionConfig {
	baseUrl: string; // 形如 https://open.bigmodel.cn/api/paas/v4/（带尾斜杠）
	model: string;
}

function getConfig(): VisionConfig {
	// Coding Plan 用专属 endpoint（/coding/paas/v4/），与按量付费的 /paas/v4/ 区分。
	// 订阅 key 走通用 endpoint 会返回 1113 余额不足。
	const baseUrl =
		process.env.Z_AI_VISION_BASE_URL ??
		"https://open.bigmodel.cn/api/coding/paas/v4/";
	const model = process.env.Z_AI_VISION_MODEL ?? "glm-4.6v";
	return { baseUrl, model };
}

// Minimal structural type for the bit of ctx we need, so we don't pull in
// the full AuthResult type from pi-ai.
interface ProviderAuthCtx {
	modelRegistry: {
		getProviderAuth(provider: string): Promise<
			| { auth?: { apiKey?: string } }
			| undefined
		>;
	};
}

/**
 * Resolve the Z.AI API key: env var first, then the zai-coding-cn provider
 * auth (independent of which provider/model the current session uses).
 */
async function resolveApiKey(ctx: ProviderAuthCtx): Promise<string> {
	const envKey = process.env.Z_AI_VISION_API_KEY ?? process.env.Z_AI_MCP_API_KEY;
	if (envKey) return envKey;
	const result = await ctx.modelRegistry.getProviderAuth("zai-coding-cn");
	const key = result?.auth?.apiKey;
	if (!key) {
		throw new Error(
			'No Z.AI API key: set Z_AI_VISION_API_KEY env var, or run /login zai-coding-cn (or configure its API key) and retry.',
		);
	}
	return key;
}

// ─── Source handling（本地文件 → base64 data URL；URL → 直传）─────────────────

function isUrl(source: string): boolean {
	try {
		const u = new URL(source);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
};
const VIDEO_MIME: Record<string, string> = {
	mp4: "video/mp4",
	mov: "video/quicktime",
	m4v: "video/x-m4v",
	avi: "video/x-msvideo",
	wmv: "video/x-ms-wmv",
	webm: "video/webm",
};

const MAX_IMAGE_MB = 5;
const MAX_VIDEO_MB = 8;

async function toDataUrl(
	source: string,
	kind: "image" | "video",
	maxMb: number,
): Promise<string> {
	if (isUrl(source)) return source; // URL 直传，不转 base64
	if (!existsSync(source)) {
		throw new Error(`${kind} file not found: ${source}`);
	}
	const buf = await readFile(source);
	const sizeMb = buf.length / (1024 * 1024);
	if (sizeMb > maxMb) {
		throw new Error(
			`${kind} file too large: ${sizeMb.toFixed(2)}MB, max ${maxMb}MB`,
		);
	}
	const ext = extname(source).toLowerCase().slice(1);
	const table = kind === "image" ? IMAGE_MIME : VIDEO_MIME;
	const mime = table[ext];
	if (!mime) {
		throw new Error(
			`Unsupported ${kind} format: .${ext}. Supported: ${Object.keys(table).join(", ")}`,
		);
	}
	return `data:${mime};base64,${buf.toString("base64")}`;
}

// ─── GLM-4.6V chat/completions 调用 ─────────────────────────────────────────────

interface ContentBlock {
	type: string;
	text?: string;
	image_url?: { url: string };
	video_url?: { url: string };
}

interface VisionMessage {
	role: "system" | "user";
	content: string | ContentBlock[];
}

interface ChatResponse {
	choices?: Array<{ message?: { content?: string } }>;
}

async function visionComplete(
	messages: VisionMessage[],
	signal: AbortSignal | undefined,
	apiKey: string,
): Promise<string> {
	const cfg = getConfig();
	const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 300_000); // 5 min
	// 让外部 signal 也能触发中止
	if (signal) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", () => controller.abort(), { once: true });
	}

	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"X-Title": "pi-zai-vision-ext",
				"Accept-Language": "en-US,en",
			},
			body: JSON.stringify({
				model: cfg.model,
				messages,
				thinking: { type: "enabled" },
				stream: false,
				temperature: 0.8,
				top_p: 0.6,
				max_tokens: 32768,
			}),
			signal: controller.signal,
		});

		if (!res.ok) {
			const txt = await res.text();
			throw new Error(`HTTP ${res.status}: ${txt}`);
		}

		const data = (await res.json()) as ChatResponse;
		const content = data.choices?.[0]?.message?.content;
		if (!content) {
			throw new Error("Invalid API response: missing content");
		}
		return content;
	} finally {
		clearTimeout(timeoutId);
	}
}

/** 构造单图请求的消息序列 */
function singleImageMessages(
	systemPrompt: string,
	userPrompt: string,
	imageDataUrl: string,
): VisionMessage[] {
	return [
		{ role: "system", content: systemPrompt },
		{
			role: "user",
			content: [
				{ type: "image_url", image_url: { url: imageDataUrl } },
				{ type: "text", text: userPrompt },
			],
		},
	];
}

/** 构造双图请求的消息序列（用于 ui_diff_check） */
function doubleImageMessages(
	systemPrompt: string,
	userPrompt: string,
	expectedUrl: string,
	actualUrl: string,
): VisionMessage[] {
	return [
		{ role: "system", content: systemPrompt },
		{
			role: "user",
			content: [
				{ type: "text", text: "Expected UI:" },
				{ type: "image_url", image_url: { url: expectedUrl } },
				{ type: "text", text: "Actual UI:" },
				{ type: "image_url", image_url: { url: actualUrl } },
				{ type: "text", text: userPrompt },
			],
		},
	];
}

/** 构造视频请求的消息序列 */
function videoMessages(
	userPrompt: string,
	videoDataUrl: string,
): VisionMessage[] {
	return [
		{
			role: "user",
			content: [
				{ type: "video_url", video_url: { url: videoDataUrl } },
				{ type: "text", text: userPrompt },
			],
		},
	];
}

// ─── 通用执行包装：处理输入校验 + 文件读取 + 调用 + 错误格式化 ────────────────

interface BaseParams {
	prompt: string;
}

function validatePrompt(prompt: string, toolName: string): void {
	if (!prompt || !prompt.trim()) {
		throw new Error(`Prompt is required for ${toolName}`);
	}
}

function errorResult(toolName: string, err: unknown) {
	const msg = err instanceof Error ? err.message : String(err);
	return {
		content: [{ type: "text" as const, text: `Error (${toolName}): ${msg}` }],
		isError: true,
		details: { tool: toolName, error: msg },
	};
}

// ─── Extension ─────────────────────────────────────────────────────────────────

const ZAI_VISION_TOOL_NAMES = new Set([
	"ui_to_artifact",
	"extract_text_from_screenshot",
	"diagnose_error_screenshot",
	"understand_technical_diagram",
	"analyze_data_visualization",
	"ui_diff_check",
	"analyze_image",
	"analyze_video",
]);

function supportsNativeVision(model: { input?: readonly string[] } | undefined): boolean {
	return model?.input?.includes("image") ?? false;
}

export default function zaiVision(pi: ExtensionAPI) {
	let toolsSuppressed = false;
	let toolsToRestore: string[] = [];

	const syncToolActivation = (model: { input?: readonly string[] } | undefined) => {
		const activeTools = pi.getActiveTools();

		if (supportsNativeVision(model)) {
			if (toolsSuppressed) return;

			toolsToRestore = activeTools.filter((name) => ZAI_VISION_TOOL_NAMES.has(name));
			pi.setActiveTools(activeTools.filter((name) => !ZAI_VISION_TOOL_NAMES.has(name)));
			toolsSuppressed = true;
			return;
		}

		if (!toolsSuppressed) return;

		const registeredTools = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools([
			...new Set([
				...activeTools,
				...toolsToRestore.filter((name) => registeredTools.has(name)),
			]),
		]);
		toolsToRestore = [];
		toolsSuppressed = false;
	};
	// ── 1. ui_to_artifact ──────────────────────────────────────────────────────
	pi.registerTool({
		name: "ui_to_artifact",
		label: "UI to Artifact",
		description: `Convert UI screenshots to various artifacts.

Use this tool ONLY when the user has a UI/design screenshot and wants to convert it.
Can generate: frontend code, AI prompts for UI recreation, design specification documents, or natural language descriptions.

Do NOT use for: OCR text extraction, error diagnosis, or diagram understanding.`,
		parameters: Type.Object({
			image_source: Type.String({
				description: "Local file path or remote URL to the image",
			}),
			output_type: Type.Union([
				Type.Literal("code"),
				Type.Literal("prompt"),
				Type.Literal("spec"),
				Type.Literal("description"),
			], { description: "Type of output to generate. Options: 'code' (generate frontend code), 'prompt' (generate AI prompt for recreating this UI), 'spec' (generate design specification document), 'description' (natural language description of the UI)." }),
			prompt: Type.String({
				description: "Detailed instructions describing what to generate from this UI image. Should clearly state the desired output and any specific requirements.",
			}),
		}),
		promptSnippet: "Convert UI screenshots to code, AI prompts, specs, or descriptions.",
		async execute(_id, params: { image_source: string; output_type: "code" | "prompt" | "spec" | "description"; prompt: string }, signal, _onUpdate, ctx) {
			const toolName = "ui_to_artifact";
			try {
				validatePrompt(params.prompt, toolName);
				const systemPrompt = UI_TO_ARTIFACT_PROMPTS[params.output_type];
				if (!systemPrompt) {
					throw new Error(`Invalid output_type: ${params.output_type}`);
				}
				const imgUrl = await toDataUrl(params.image_source, "image", MAX_IMAGE_MB);
				const messages = singleImageMessages(systemPrompt, params.prompt, imgUrl);
				const result = await visionComplete(messages, signal, await resolveApiKey(ctx));
				return {
					content: [{ type: "text", text: result }],
					details: { output_type: params.output_type, source: params.image_source },
				};
			} catch (err) {
				return errorResult(toolName, err);
			}
		},
	});

	// ── 2. extract_text_from_screenshot ────────────────────────────────────────
	pi.registerTool({
		name: "extract_text_from_screenshot",
		label: "Extract Text (OCR)",
		description: `Extract and recognize text from screenshots using advanced OCR capabilities.

Use this tool ONLY when the user has a screenshot containing text and wants to extract it.
This tool specializes in OCR for code, terminal output, documentation, and general text extraction.

Do NOT use for: UI design conversion, error diagnosis, or diagram understanding.`,
		parameters: Type.Object({
			image_source: Type.String({
				description: "Local file path or remote URL to the image",
			}),
			prompt: Type.String({
				description: "Instructions for text extraction. Specify what type of text to extract and any formatting requirements.",
			}),
			programming_language: Type.Optional(
				Type.String({
					description: "Optional: specify the programming language if the screenshot contains code (e.g., 'python', 'javascript', 'java'). Leave empty for auto-detection or non-code text.",
				}),
			),
		}),
		promptSnippet: "OCR text extraction from screenshots (code, logs, docs).",
		async execute(_id, params: { image_source: string; prompt: string; programming_language?: string }, signal, _onUpdate, ctx) {
			const toolName = "extract_text_from_screenshot";
			try {
				validatePrompt(params.prompt, toolName);
				let enhanced = params.prompt;
				if (params.programming_language?.trim()) {
					enhanced = `${params.prompt}\n\n<language_hint>The code is in ${params.programming_language}.</language_hint>`;
				}
				const imgUrl = await toDataUrl(params.image_source, "image", MAX_IMAGE_MB);
				const messages = singleImageMessages(TEXT_EXTRACTION_PROMPT, enhanced, imgUrl);
				const result = await visionComplete(messages, signal, await resolveApiKey(ctx));
				return {
					content: [{ type: "text", text: result }],
					details: { source: params.image_source, language: params.programming_language },
				};
			} catch (err) {
				return errorResult(toolName, err);
			}
		},
	});

	// ── 3. diagnose_error_screenshot ───────────────────────────────────────────
	pi.registerTool({
		name: "diagnose_error_screenshot",
		label: "Diagnose Error",
		description: `Diagnose errors and troubleshoot from error screenshots.

Use this tool ONLY when the user has a screenshot showing an error message or stack trace and wants help understanding and fixing it.

Do NOT use for: general image analysis, UI design conversion, or text extraction.`,
		parameters: Type.Object({
			image_source: Type.String({
				description: "Local file path or remote URL to the image",
			}),
			prompt: Type.String({
				description: "Description of what you need help with regarding this error. Include any relevant context about when it occurred.",
			}),
			context: Type.Optional(
				Type.String({
					description: "Optional: additional context about when the error occurred (e.g., 'during npm install', 'when running the app', 'after deployment'). Helps with more accurate diagnosis.",
				}),
			),
		}),
		promptSnippet: "Diagnose errors and stack traces from screenshots.",
		async execute(_id, params: { image_source: string; prompt: string; context?: string }, signal, _onUpdate, ctx) {
			const toolName = "diagnose_error_screenshot";
			try {
				validatePrompt(params.prompt, toolName);
				let enhanced = params.prompt;
				if (params.context?.trim()) {
					enhanced = `${params.prompt}\n\n<context>${params.context}</context>`;
				}
				const imgUrl = await toDataUrl(params.image_source, "image", MAX_IMAGE_MB);
				const messages = singleImageMessages(ERROR_DIAGNOSIS_PROMPT, enhanced, imgUrl);
				const result = await visionComplete(messages, signal, await resolveApiKey(ctx));
				return {
					content: [{ type: "text", text: result }],
					details: { source: params.image_source },
				};
			} catch (err) {
				return errorResult(toolName, err);
			}
		},
	});

	// ── 4. understand_technical_diagram ────────────────────────────────────────
	pi.registerTool({
		name: "understand_technical_diagram",
		label: "Understand Diagram",
		description: `Analyze and explain technical diagrams.

Use this tool ONLY when the user has a technical diagram screenshot (architecture, flowchart, UML, ER, sequence diagram, etc.) and wants to understand it.

Do NOT use for: general image analysis, UI design conversion, or data visualization analysis.`,
		parameters: Type.Object({
			image_source: Type.String({
				description: "Local file path or remote URL to the image",
			}),
			prompt: Type.String({
				description: "What you want to understand or extract from this diagram.",
			}),
			diagram_type: Type.Optional(
				Type.String({
					description: "Optional: specify the diagram type if known (e.g., 'architecture', 'flowchart', 'uml', 'er-diagram', 'sequence'). Leave empty for auto-detection.",
				}),
			),
		}),
		promptSnippet: "Explain architecture/flowchart/UML/ER/sequence diagrams.",
		async execute(_id, params: { image_source: string; prompt: string; diagram_type?: string }, signal, _onUpdate, ctx) {
			const toolName = "understand_technical_diagram";
			try {
				validatePrompt(params.prompt, toolName);
				let enhanced = params.prompt;
				if (params.diagram_type?.trim()) {
					enhanced = `${params.prompt}\n\n<diagram_type>${params.diagram_type}</diagram_type>`;
				}
				const imgUrl = await toDataUrl(params.image_source, "image", MAX_IMAGE_MB);
				const messages = singleImageMessages(DIAGRAM_UNDERSTANDING_PROMPT, enhanced, imgUrl);
				const result = await visionComplete(messages, signal, await resolveApiKey(ctx));
				return {
					content: [{ type: "text", text: result }],
					details: { source: params.image_source, diagram_type: params.diagram_type },
				};
			} catch (err) {
				return errorResult(toolName, err);
			}
		},
	});

	// ── 5. analyze_data_visualization ──────────────────────────────────────────
	pi.registerTool({
		name: "analyze_data_visualization",
		label: "Analyze Data Viz",
		description: `Analyze data visualizations and extract insights.

Use this tool ONLY when the user has a chart, graph, or dashboard screenshot and wants insights about the data.

Do NOT use for: technical diagram understanding, UI design conversion, or general image analysis.`,
		parameters: Type.Object({
			image_source: Type.String({
				description: "Local file path or remote URL to the image",
			}),
			prompt: Type.String({
				description: "What insights or information you want to extract from this visualization.",
			}),
			analysis_focus: Type.Optional(
				Type.String({
					description: "Optional: specify what to focus on (e.g., 'trends', 'anomalies', 'comparisons', 'performance metrics'). Leave empty for comprehensive analysis.",
				}),
			),
		}),
		promptSnippet: "Extract insights from charts/graphs/dashboards.",
		async execute(_id, params: { image_source: string; prompt: string; analysis_focus?: string }, signal, _onUpdate, ctx) {
			const toolName = "analyze_data_visualization";
			try {
				validatePrompt(params.prompt, toolName);
				let enhanced = params.prompt;
				if (params.analysis_focus?.trim()) {
					enhanced = `${params.prompt}\n\n<analysis_focus>${params.analysis_focus}</analysis_focus>`;
				}
				const imgUrl = await toDataUrl(params.image_source, "image", MAX_IMAGE_MB);
				const messages = singleImageMessages(DATA_VIZ_ANALYSIS_PROMPT, enhanced, imgUrl);
				const result = await visionComplete(messages, signal, await resolveApiKey(ctx));
				return {
					content: [{ type: "text", text: result }],
					details: { source: params.image_source },
				};
			} catch (err) {
				return errorResult(toolName, err);
			}
		},
	});

	// ── 6. ui_diff_check ───────────────────────────────────────────────────────
	pi.registerTool({
		name: "ui_diff_check",
		label: "UI Diff Check",
		description: `Compare two UI screenshots for visual regression.

Use this tool ONLY when the user wants to compare two UI images (typically expected/design vs actual/implementation) and identify visual differences.

Do NOT use for: single image analysis, error diagnosis, or diagram understanding.`,
		parameters: Type.Object({
			expected_image_source: Type.String({
				description: "Local file path or remote URL to the expected (design/reference) image",
			}),
			actual_image_source: Type.String({
				description: "Local file path or remote URL to the actual (implemented) image",
			}),
			prompt: Type.String({
				description: "Instructions for the comparison. Specify what aspects to focus on or what level of detail is needed.",
			}),
		}),
		promptSnippet: "Visual regression: compare expected vs actual UI screenshots.",
		async execute(_id, params: { expected_image_source: string; actual_image_source: string; prompt: string }, signal, _onUpdate, ctx) {
			const toolName = "ui_diff_check";
			try {
				validatePrompt(params.prompt, toolName);
				const [expectedUrl, actualUrl] = await Promise.all([
					toDataUrl(params.expected_image_source, "image", MAX_IMAGE_MB),
					toDataUrl(params.actual_image_source, "image", MAX_IMAGE_MB),
				]);
				const messages = doubleImageMessages(
					UI_DIFF_CHECK_PROMPT,
					params.prompt,
					expectedUrl,
					actualUrl,
				);
				const result = await visionComplete(messages, signal, await resolveApiKey(ctx));
				return {
					content: [{ type: "text", text: result }],
					details: { expected: params.expected_image_source, actual: params.actual_image_source },
				};
			} catch (err) {
				return errorResult(toolName, err);
			}
		},
	});

	// ── 7. analyze_image（通用兜底）────────────────────────────────────────────
	pi.registerTool({
		name: "analyze_image",
		label: "Analyze Image",
		description: `General-purpose image analysis.

Use this tool when the user wants to analyze an image but none of the specialized tools (ui_to_artifact, extract_text, diagnose_error, understand_diagram, analyze_data_visualization, ui_diff_check) fit the need. This is the flexible fallback for any visual content.

Supports local file paths and remote URLs.`,
		parameters: Type.Object({
			image_source: Type.String({
				description: "Local file path or remote URL to the image",
			}),
			prompt: Type.String({
				description: "Detailed description of what you want to analyze, extract, or understand from the image. Be specific about your requirements.",
			}),
		}),
		promptSnippet: "General-purpose image analysis (fallback for any visual content).",
		async execute(_id, params: { image_source: string; prompt: string }, signal, _onUpdate, ctx) {
			const toolName = "analyze_image";
			try {
				validatePrompt(params.prompt, toolName);
				const imgUrl = await toDataUrl(params.image_source, "image", MAX_IMAGE_MB);
				const messages = singleImageMessages(GENERAL_IMAGE_ANALYSIS_PROMPT, params.prompt, imgUrl);
				const result = await visionComplete(messages, signal, await resolveApiKey(ctx));
				return {
					content: [{ type: "text", text: result }],
					details: { source: params.image_source },
				};
			} catch (err) {
				return errorResult(toolName, err);
			}
		},
	});

	// ── 8. analyze_video ──────────────────────────────────────────────────────
	pi.registerTool({
		name: "analyze_video",
		label: "Analyze Video",
		description: `Analyze video content using advanced AI vision models.

Use this tool when the user wants to:
- Understand what happens in a video
- Extract key moments or actions from video
- Analyze video content, scenes, or sequences
- Get descriptions of video footage
- Identify objects, people, or activities in video

Supports both local files and remote URLs. Maximum file size: 8MB. Supports MP4, MOV, M4V formats.`,
		parameters: Type.Object({
			video_source: Type.String({
				description: "Local file path or remote URL to the video (supports MP4, MOV, M4V)",
			}),
			prompt: Type.String({
				description: "Detailed text prompt describing what to analyze, extract, or understand from the video",
			}),
		}),
		promptSnippet: "Analyze video content (scenes, actions, key moments).",
		async execute(_id, params: { video_source: string; prompt: string }, signal, _onUpdate, ctx) {
			const toolName = "analyze_video";
			try {
				validatePrompt(params.prompt, toolName);
				const videoUrl = await toDataUrl(params.video_source, "video", MAX_VIDEO_MB);
				const messages = videoMessages(params.prompt, videoUrl);
				const result = await visionComplete(messages, signal, await resolveApiKey(ctx));
				return {
					content: [{ type: "text", text: result }],
					details: { source: params.video_source },
				};
			} catch (err) {
				return errorResult(toolName, err);
			}
		},
	});

	// 原生支持图像输入的模型直接接收图片，不向模型暴露 ZAI 视觉工具；
	// 切回纯文本模型时，仅恢复此前由本扩展停用的工具。
	pi.on("session_start", (_event, ctx) => {
		syncToolActivation(ctx.model);
	});

	pi.on("model_select", (event) => {
		syncToolActivation(event.model);
	});
}
