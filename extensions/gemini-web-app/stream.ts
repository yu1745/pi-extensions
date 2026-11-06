/**
 * streamGeminiWeb — pi stream implementation over the Gemini App web protocol.
 * Renders the transcript to a single prompt (the wire protocol has no message
 * array), posts it to StreamGenerate, and re-emits the wrb.fr frame stream as
 * pi text/thinking/toolcall events.
 *
 * Tool calling is prompt-level (same approach as gemini-web2api): declared
 * tools are described in the prompt and the model is asked to answer tool
 * calls with ```tool_call``` fenced JSON blocks, which are parsed back into
 * real toolCall content blocks.
 */
import {
	calculateCost,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type Tool,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	WEB_MODELS,
	buildEndpoint,
	buildFreq,
	buildHeaders,
	buildRequestBody,
	chromeFetchHeaders,
	randomUuid,
	modelNeedsLogin,
	type WebModelConfig,
} from "./protocol.js";
import { DeltaTracker, cleanGeminiText, cleanKeepCode, extractUpstreamModel, parseLine } from "./parse.js";
import { currentBl, getXsrf, loadCookieConfig, parseCookieBlob, type WebCookieConfig } from "./cookie.js";
import { webFetch } from "./http.js";

export const GEMINI_WEB_API = "gemini-web-app-api" as const;
export const PROVIDER_ID = "gemini-web-app";

// ─── prompt rendering ─────────────────────────────────────────────────────────

function renderToolDeclarations(tools: Tool[]): string {
	// Compact schema: minified JSON, description truncated. Full schemas with
	// pretty-printed JSON Schema ballooned the prompt (~11KB → several KB of it
	// tool boilerplate) which costs bytes on the wire and dilutes the model's
	// attention; the web endpoint has no native tool protocol to lean on.
	const lines = tools.map((t) => {
		const desc = (t.description ?? "").split("\n")[0].slice(0, 200);
		const params = t.parameters ? JSON.stringify(t.parameters) : "{}";
		return `- ${t.name}: ${desc}\n  args schema: ${params}`;
	});
	return [
		"# Tool calling protocol",
		'To call a tool, reply with ONLY this fenced block: ```tool_call\n{"name":"<tool>","arguments":{…}}\n``` One call per reply; continue after the tool result arrives. Otherwise answer in plain text.',
		"Available tools:",
		...lines,
	].join("\n");
}

function renderTranscript(context: TranscriptContext, toolBlock: string | null): string {
	const systemPrompt = getCurrentSystemPrompt(context.messages);
	const parts: string[] = [];
	if (systemPrompt) parts.push(`# System instructions\n${systemPrompt}`);
	if (toolBlock) parts.push(toolBlock);

	for (const message of context.messages) {
		const role = message.role;
		if (role === "system") continue; // already folded into getCurrentSystemPrompt
		let text = "";
		if (message.role === "toolResult") {
			// Standalone tool-result message in the transcript.
			const resultText = message.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			text = `[tool ${message.toolName} result]\n${resultText}`;
		} else if (typeof message.content === "string") {
			text = message.content;
		} else if (Array.isArray(message.content)) {
			const chunks: string[] = [];
			for (const block of message.content) {
				if (block.type === "text") chunks.push(block.text);
				else if (block.type === "thinking") chunks.push(`[thinking omitted]`);
				else if (block.type === "toolCall") {
					chunks.push(`[tool call ${block.name}(${JSON.stringify(block.arguments)})]`);
				} else if (block.type === "image") {
					chunks.push("[image attached — not supported on this transport]");
				}
			}
			text = chunks.join("\n");
		}
		if (!text.trim()) continue;
		parts.push(role === "user" ? `# User\n${text}` : `# Assistant\n${text}`);
	}
	parts.push("# Assistant\n");
	return parts.join("\n\n");
}

// ─── stream ────────────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;

interface WebStreamOptions extends SimpleStreamOptions {
	cookieConfig?: WebCookieConfig;
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: GEMINI_WEB_API,
		provider: PROVIDER_ID,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function parseToolCalls(text: string): { cleaned: string; calls: ToolCall[] } {
	const calls: ToolCall[] = [];
	const cleaned = text.replace(/```tool_call\s*\n([\s\S]*?)```/g, (_m, body: string) => {
		try {
			const parsed = JSON.parse(body.trim()) as { name?: string; arguments?: Record<string, unknown> };
			if (parsed.name) {
				calls.push({
					type: "toolCall",
					id: `call_${randomUuid().slice(0, 8)}`,
					name: parsed.name,
					arguments: (parsed.arguments ?? {}) as ToolCall["arguments"],
				});
				return ""; // consume the block from visible text
			}
		} catch {
			// malformed block — keep as text so the model can correct it
		}
		return _m;
	});
	return { cleaned, calls };
}

export function streamGeminiWeb(
	model: Model<Api>,
	context: TranscriptContext,
	options?: WebStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const opts = options ?? {};

	void (async () => {
		const output = createOutput(model);
		try {
			// Credential precedence: explicit option > provider apiKey (the cookie blob
			// piped through the `!command` interpolation) > the on-disk cookie store.
			const cookieConfig =
				opts.cookieConfig ??
				(opts.apiKey ? parseCookieBlob(opts.apiKey) : null) ??
				(await loadCookieConfig()) ??
				{ cookie: "", sapisid: "", authuser: 0 };
			const cfg: WebModelConfig | undefined = WEB_MODELS[model.id];
			if (!cfg) throw new Error(`gemini-web-app: unknown model ${model.id}`);
			if (!cookieConfig && modelNeedsLogin(cfg)) {
				throw new Error(
					`${model.id} requires a signed-in Google AI Pro/Ultra cookie. Run /gemini-web-cookie <pasted cookie header> first (Firefox export recommended).`,
				);
			}

			const tools = getCurrentTools(context.messages);
			const toolBlock = tools && tools.length > 0 ? renderToolDeclarations(tools) : null;
			const prompt = renderTranscript(context, toolBlock);

			const __tx = Date.now();
			const xsrf = await getXsrf(cookieConfig ?? { cookie: "", sapisid: "", authuser: 0 });
			const freq = buildFreq(prompt, cfg);
			const sessionUuid = randomUuid();
			const headers = buildHeaders({
				cookie: cookieConfig?.cookie ?? "",
				sapisid: cookieConfig?.sapisid ?? "",
				xsrf,
				cfg,
				authuser: cookieConfig?.authuser ?? 0,
				requestUuid: sessionUuid,
			});

			const endpoint = buildEndpoint(cookieConfig?.authuser ?? 0, currentBl());
			const body = buildRequestBody(freq, xsrf);

			if (opts.signal?.aborted) throw new Error("Request was aborted");

			const response = await webFetch(endpoint, {
				method: "POST",
				headers: { ...chromeFetchHeaders(), ...headers },
				body,
				signal: opts.signal,
				redirect: "manual",
			});

			if (response.status === 302 || response.status === 303) {
				throw new Error(
					"gemini.google.com redirected this request (IP throttled to /sorry or cookie expired). Wait ~2h or refresh the cookie.",
				);
			}
			if (!response.ok) {
				const text = await response.text();
				throw new Error(`Gemini web HTTP ${response.status}: ${text.slice(0, 300)}`);
			}
			if (!response.body) throw new Error("No response body");

			opts.onResponse?.(
				{ status: response.status, headers: response.headers, body: undefined } as never,
				model,
			);

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let started = false;
			let currentBlock: { type: "text"; text: string } | { type: "thinking"; thinking: string } | null = null;
			let hasContent = false;
			let rawResponse = "";
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;

			const ensureStarted = () => {
				if (!started) {
					stream.push({ type: "start", partial: output });
					started = true;
				}
			};
			const finishCurrent = () => {
				if (!currentBlock) return;
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
				currentBlock = null;
			};

			const tracker = new DeltaTracker();
			const reasoningTracker = new DeltaTracker();

			const handleLine = (line: string): boolean => {
				rawResponse += line + "\n";
				const parsed = parseLine(line);
				if (parsed.failureReply) return false; // upstream error phrase — treat as empty
				if (parsed.reasoning) {
					const delta = reasoningTracker.push(parsed.reasoning);
					if (delta) {
						hasContent = true;
						if (!currentBlock || currentBlock.type !== "thinking") {
							finishCurrent();
							currentBlock = { type: "thinking", thinking: "" };
							blocks.push(currentBlock);
							ensureStarted();
							stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
						}
						currentBlock.thinking += delta;
						stream.push({ type: "thinking_delta", contentIndex: blockIndex(), delta, partial: output });
					}
				}
				for (const t of parsed.texts) {
					const delta = tracker.push(t);
					if (delta) {
						hasContent = true;
						if (!currentBlock || currentBlock.type !== "text") {
							finishCurrent();
							currentBlock = { type: "text", text: "" };
							blocks.push(currentBlock);
							ensureStarted();
							stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
						}
						currentBlock.text += delta;
						stream.push({ type: "text_delta", contentIndex: blockIndex(), delta, partial: output });
					}
				}
				return true;
			};

			let __reads = 0;
			while (true) {
				const __r0 = Date.now();
				const result = await reader.read();
				__reads++;
				if (__reads <= 5 || Date.now() - __r0 > 500) {
				}
				if (result.done) break;
				if (!(result.value instanceof Uint8Array)) continue;
				buffer += decoder.decode(result.value, { stream: true });
				let idx: number;
				while ((idx = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 1);
					handleLine(line);
				}
			}
			if (buffer) handleLine(buffer);
			finishCurrent();

			if (!hasContent) {
				// Distinguish silent downgrade from transient refusal.
				const served = extractUpstreamModel(rawResponse);
				if (served && cookieConfig && modelNeedsLogin(cfg) && served !== cfg.upstream) {
					throw new Error(
						`gemini-web-app: server silently downgraded the request to "${served}" — the cookie's account does not have ${cfg.upstream} access. Check the model selector in gemini.google.com for this account.`,
					);
				}
				throw new Error("Gemini web returned no content frame (transient refusal or rate limit)");
			}

			// Post-process prompt-level tool calls out of the text block.
			const textIdx = blocks.findIndex((b) => b.type === "text");
			if (textIdx !== -1) {
				const textBlock = blocks[textIdx] as { type: "text"; text: string };
				const { cleaned, calls } = parseToolCalls(textBlock.text);
				if (calls.length > 0) {
					textBlock.text = cleanKeepCode(cleaned) || cleaned.trim();
					for (const call of calls) {
						blocks.push(call);
					}
					output.stopReason = "toolUse";
				}
			}

			// Usage is an estimate — the wire format exposes no token counts.
			const promptTokens = estimateTokens(prompt);
			const outputText = blocks
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join("");
			const thinkingText = blocks
				.filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking")
				.map((b) => b.thinking)
				.join("");
			output.usage.input = promptTokens;
			output.usage.output = estimateTokens(outputText) + estimateTokens(thinkingText);
			output.usage.totalTokens = promptTokens + output.usage.output;
			calculateCost(model, output.usage);

			const served = extractUpstreamModel(rawResponse);
			if (served) output.responseModel = served;

			if (opts.signal?.aborted) {
				output.stopReason = "error";
				output.errorMessage = "Request aborted";
				stream.push({ type: "error", reason: "aborted" as const, error: output });
			} else {
				stream.push({
					type: "done",
					reason: output.stopReason === "toolUse" ? ("toolUse" as const) : ("stop" as const),
					message: output,
				});
			}
			stream.end();
		} catch (error) {
			const reason = opts.signal?.aborted ? ("aborted" as const) : ("error" as const);
			output.stopReason = reason === "aborted" ? "error" : "error";
			const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
			const detail = cause?.code ? ` (${cause.code})` : "";
			output.errorMessage = (error instanceof Error ? error.message : String(error)) + detail;
			stream.push({ type: "error", reason, error: output });
			stream.end();
		}
	})();

	return stream;
}

export { cleanGeminiText };
