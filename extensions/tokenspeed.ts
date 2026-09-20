/**
 * Token Speed Extension
 *
 * Shows the model's current output speed (tokens/sec) as a status line in the
 * built-in pi footer. Displays three speed metrics inspired by `top`'s load
 * averages:
 *
 *   ⚡ 42.3 / 38.7 / 35.1 tok/s
 *       ^^^     ^^^     ^^^
 *       short   mid     long
 *
 * - **Short**: real-time kernel-smoothed speed (using Oh My Pi's TokenRateMeter
 *              algorithm with multi-scale exponential decay and hidden token compensation)
 * - **Mid**:    average speed of the last 1 assistant message (authoritative)
 * - **Long**:   average speed of the last 5 assistant messages (authoritative)
 *
 * Suffix indicator:
 * - Appends ` (estimate)` while downloading/using adaptive estimation.
 * - Removes ` (estimate)` once the real tokenizer is loaded and active.
 *
 * Uses `ctx.ui.setStatus()`, so pi's native footer is untouched.
 * Toggle with the `/tokenspeed` command.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Tokenizer } from "@huggingface/tokenizers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJevClient } from "./shared/jev/client.ts";

const STATUS_KEY = "tokenspeed";
const HISTORY_LEN = 5; // how many past messages to keep for long-term average
const RATIO_HISTORY = 10; // chars/token samples kept for the median

/** Default fallback characters-per-token ratios if uncalibrated */
export const DEFAULT_TEXT_RATIO = 2.5; // blended default for CJK / English text & thinking
export const DEFAULT_TOOL_RATIO = 3.5; // JSON arguments have higher chars-per-token

/**
 * Oh My Pi TokenRateMeter parameters:
 * - Half-lives of the decayed-sum scales: [5s, 20s, 80s].
 *   Short scale reacts quickly to speed changes; long scale provides stability against bursts.
 * - Evidence gate: fewer decayed tokens than 200, or less stream time than 4s,
 *   is noise, not a reliable rate.
 * - Bucket size: 250ms batching to avoid tokenizing tiny deltas individually.
 */
export const METER_HALF_LIVES_MS = [5_000, 20_000, 80_000];
export const METER_MIN_TOKENS = 200;
export const METER_MIN_TIME_MS = 4_000;
export const METER_BUCKET_MS = 250;
export const METER_CARRY_MAX_CHARS = 32;
export const METER_HIDDEN_DECAY = 0.8;
export const METER_HIDDEN_PRIOR_MS = 10_000;
const LN2 = Math.LN2;

/**
 * Tokenizer registry: Only remote URLs, zero JSON bundled in code.
 * Uses hf-mirror.com for reliable high-speed downloads.
 */
export const TOKENIZER_REGISTRY: Record<string, { url: string; fallbackUrl?: string }> = {
	minimax: {
		url: "https://hf-mirror.com/MiniMaxAI/MiniMax-Text-01-hf/resolve/main/tokenizer.json",
		fallbackUrl: "https://huggingface.co/MiniMaxAI/MiniMax-Text-01-hf/resolve/main/tokenizer.json",
	},
	qwen: {
		url: "https://hf-mirror.com/Qwen/Qwen2.5-72B-Instruct/resolve/main/tokenizer.json",
		fallbackUrl: "https://huggingface.co/Qwen/Qwen2.5-72B-Instruct/resolve/main/tokenizer.json",
	},
	deepseek: {
		url: "https://hf-mirror.com/deepseek-ai/DeepSeek-V3/resolve/main/tokenizer.json",
		fallbackUrl: "https://huggingface.co/deepseek-ai/DeepSeek-V3/resolve/main/tokenizer.json",
	},
	glm: {
		url: "https://hf-mirror.com/zai-org/GLM-4.7-Flash/resolve/main/tokenizer.json",
		fallbackUrl: "https://huggingface.co/zai-org/GLM-4.7-Flash/resolve/main/tokenizer.json",
	},
	openai: {
		url: "https://hf-mirror.com/Xenova/gpt-4o/resolve/main/tokenizer.json",
		fallbackUrl: "https://huggingface.co/Xenova/gpt-4o/resolve/main/tokenizer.json",
	},
	llama: {
		url: "https://hf-mirror.com/unsloth/Meta-Llama-3.1-8B-Instruct/resolve/main/tokenizer.json",
		fallbackUrl: "https://huggingface.co/unsloth/Meta-Llama-3.1-8B-Instruct/resolve/main/tokenizer.json",
	},
	claude: {
		url: "https://hf-mirror.com/Xenova/claude-tokenizer/resolve/main/tokenizer.json",
		fallbackUrl: "https://huggingface.co/Xenova/claude-tokenizer/resolve/main/tokenizer.json",
	},
	mistral: {
		url: "https://hf-mirror.com/mistralai/Mistral-7B-Instruct-v0.3/resolve/main/tokenizer.json",
		fallbackUrl: "https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3/resolve/main/tokenizer.json",
	},
	gemma: {
		url: "https://hf-mirror.com/unsloth/gemma-2-9b-it/resolve/main/tokenizer.json",
		fallbackUrl: "https://huggingface.co/unsloth/gemma-2-9b-it/resolve/main/tokenizer.json",
	},
	yi: {
		url: "https://hf-mirror.com/01-ai/Yi-1.5-34B-Chat/resolve/main/tokenizer.json",
		fallbackUrl: "https://huggingface.co/01-ai/Yi-1.5-34B-Chat/resolve/main/tokenizer.json",
	},
	grok: {
		url: "https://hf-mirror.com/Xenova/grok-1-tokenizer/resolve/main/tokenizer.json",
		fallbackUrl: "https://huggingface.co/Xenova/grok-1-tokenizer/resolve/main/tokenizer.json",
	},
	phi: {
		url: "https://hf-mirror.com/microsoft/Phi-3-mini-4k-instruct/resolve/main/tokenizer.json",
		fallbackUrl: "https://huggingface.co/microsoft/Phi-3-mini-4k-instruct/resolve/main/tokenizer.json",
	},
};

const JEV_CRITERIA: Record<string, string> = {
	minimax: "MiniMax models (e.g. MiniMax-M2.5, MiniMax-M3, abab, MiniMax-Text)",
	qwen: "Qwen models (e.g. Qwen2, Qwen2.5, Qwen3, Qwen-Coder)",
	deepseek: "DeepSeek models (e.g. DeepSeek-V3, V4, R1, deepseek-chat)",
	glm: "Zhipu GLM models (e.g. GLM-4, GLM-5, GLM-5.3, GLM-5v)",
	openai: "OpenAI models (e.g. GPT-4o, GPT-5, GPT-6, o1, o3, Codex, gpt-oss)",
	claude: "Anthropic Claude models (e.g. Claude 3, 3.5, 4, Sonnet, Opus)",
	gemini: "Google Gemini / Gemma models",
	llama: "Meta Llama models (e.g. Llama-3, Llama-3.1, Llama-3.3)",
	mistral: "Mistral / Mixtral models",
	other: "Other or unknown models",
};

/** Which part of the message we're currently in — only affects the icon. */
type Phase = "thinking" | "answering" | null;

/** Debug: full per-delta log for offline analysis (see /tokenspeed-debug). */
interface DebugRow {
	ts: number;
	type: string;
	chars: number;
	tokens: number;
}
let debugEnabled = false;
let debugRows: DebugRow[] = [];
let debugUsage: { output?: number; reasoning?: number; chars?: number } = {};

interface Tracker {
	startTime: number | null;
	endTime: number | null;
	phase: Phase;
	textChars: number;
	toolChars: number;
	estimatedTokens: number;
	usageOutput: number;
	lastSpeed: number | null;
}

/**
 * Exponentially decayed token and time sums on one half-life.
 */
export class DecayedSums {
	tokens = 0;
	time = 0;

	constructor(readonly halfLifeMs: number) {}

	advance(dtMs: number, inflight: boolean, hiddenRate: number): void {
		if (dtMs <= 0) return;
		const f = 2 ** (-dtMs / this.halfLifeMs);
		this.tokens *= f;
		this.time *= f;
		if (inflight) {
			const integral = (this.halfLifeMs / LN2) * (1 - f);
			this.time += integral;
			this.tokens += hiddenRate * integral;
		}
	}

	reset(): void {
		this.tokens = 0;
		this.time = 0;
	}
}

/**
 * Live generation throughput meter ported from Oh My Pi.
 */
export class TokenRateMeter {
	readonly #count: (text: string) => number;
	readonly #history = METER_HALF_LIVES_MS.map((ms) => new DecayedSums(ms));
	readonly #inflight = METER_HALF_LIVES_MS.map((ms) => new DecayedSums(ms));
	#startedAt: number | null = null;
	#advancedTo = 0;
	#inflightLocal = 0;
	#inflightHiddenRate = 0;
	#pendingIndex = -1;
	#pending = "";
	#hiddenTokens = 0;
	#hiddenSpanMs = 0;

	constructor(count: (text: string) => number) {
		this.#count = count;
	}

	begin(nowMs: number = Date.now()): void {
		this.#clearInflight();
		this.#startedAt = nowMs;
		this.#advancedTo = nowMs;
		this.#inflightHiddenRate = Math.max(
			0,
			this.#hiddenTokens / (this.#hiddenSpanMs + METER_HIDDEN_PRIOR_MS),
		);
	}

	push(text: string, nowMs: number = Date.now()): void {
		if (text.length === 0) return;
		if (this.#startedAt === null) this.begin(nowMs);
		const index = Math.floor((nowMs - (this.#startedAt ?? nowMs)) / METER_BUCKET_MS);
		if (index !== this.#pendingIndex) {
			this.#flushPending(true, nowMs);
			this.#pendingIndex = index;
		}
		this.#pending += text;
	}

	end(outputTokens: number | undefined, nowMs: number = Date.now()): void {
		if (this.#startedAt === null) return;
		this.#flushPending(false, nowMs);
		this.#advance(nowMs);
		const spanMs = nowMs - this.#startedAt;
		const billed =
			outputTokens !== undefined && Number.isFinite(outputTokens) && outputTokens > 0;
		let extra = 0;
		if (billed) {
			const hidden = outputTokens - this.#inflightLocal;
			this.#hiddenTokens = this.#hiddenTokens * METER_HIDDEN_DECAY + hidden;
			this.#hiddenSpanMs = this.#hiddenSpanMs * METER_HIDDEN_DECAY + spanMs;
			extra = hidden - this.#inflightHiddenRate * spanMs;
		}
		for (let k = 0; k < this.#history.length; k++) {
			const live = this.#inflight[k];
			const corrected = live.tokens + (spanMs > 0 ? (extra * live.time) / spanMs : 0);
			this.#history[k].tokens += Math.max(0, corrected);
			this.#history[k].time += live.time;
		}
		this.#clearInflight();
	}

	reset(): void {
		this.#clearInflight();
		for (const sums of this.#history) sums.reset();
	}

	seed(outputTokens: number, durationMs: number): void {
		if (
			!Number.isFinite(outputTokens) ||
			outputTokens <= 0 ||
			!Number.isFinite(durationMs) ||
			durationMs <= 0
		) {
			this.reset();
			return;
		}
		this.#clearInflight();
		const scale = Math.max(1, METER_MIN_TOKENS / outputTokens, METER_MIN_TIME_MS / durationMs);
		for (const sums of this.#history) {
			sums.tokens = outputTokens * scale;
			sums.time = durationMs * scale;
		}
	}

	rate(nowMs: number = Date.now()): number | null {
		const dtMs = this.#startedAt === null ? 0 : nowMs - this.#advancedTo;
		const pendingTokens = this.#pending.length > 0 ? this.#count(this.#pending) : 0;
		let tokens = 0;
		let time = 0;
		let evidenceTokens = 0;
		let evidenceTime = 0;
		for (let k = 0; k < this.#history.length; k++) {
			const f = 2 ** (-dtMs / METER_HALF_LIVES_MS[k]);
			const integral = (METER_HALF_LIVES_MS[k] / LN2) * (1 - f);
			evidenceTokens =
				(this.#history[k].tokens + this.#inflight[k].tokens) * f +
				this.#inflightHiddenRate * integral +
				pendingTokens;
			evidenceTime = (this.#history[k].time + this.#inflight[k].time) * f + integral;
			tokens += evidenceTokens;
			time += evidenceTime;
		}
		if (evidenceTokens < METER_MIN_TOKENS || evidenceTime < METER_MIN_TIME_MS) return null;
		return (tokens * 1000) / time;
	}

	#advance(nowMs: number): void {
		const dtMs = nowMs - this.#advancedTo;
		if (dtMs <= 0) return;
		this.#advancedTo = nowMs;
		for (let k = 0; k < this.#history.length; k++) {
			this.#history[k].advance(dtMs, false, 0);
			this.#inflight[k].advance(dtMs, true, this.#inflightHiddenRate);
		}
	}

	#clearInflight(): void {
		for (const sums of this.#inflight) sums.reset();
		this.#startedAt = null;
		this.#inflightLocal = 0;
		this.#inflightHiddenRate = 0;
		this.#pendingIndex = -1;
		this.#pending = "";
	}

	#flushPending(carry: boolean, nowMs: number): void {
		if (this.#pendingIndex < 0 || this.#pending.length === 0) return;
		let text = this.#pending;
		let tail = "";
		if (carry) {
			const cut = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"));
			if (cut > 0 && text.length - cut <= METER_CARRY_MAX_CHARS) {
				tail = text.slice(cut);
				text = text.slice(0, cut);
			}
		}
		this.#pending = tail;
		if (text.length === 0) return;
		this.#advance(nowMs);
		const tokens = this.#count(text);
		for (const sums of this.#inflight) sums.tokens += tokens;
		this.#inflightLocal += tokens;
	}
}

/**
 * Adaptive chars-per-token ratio estimator.
 */
export class CharRatio {
	private history: number[] = [];

	value(): number {
		if (this.history.length === 0) return DEFAULT_TEXT_RATIO;
		const sorted = [...this.history].sort((a, b) => a - b);
		return sorted[Math.floor(sorted.length / 2)];
	}

	update(textChars: number, toolChars: number, totalTokens: number) {
		if (totalTokens <= 0 || (textChars <= 0 && toolChars <= 0)) return;

		const estToolTokens = toolChars / DEFAULT_TOOL_RATIO;
		const textTokens = Math.max(1, totalTokens - estToolTokens);
		if (textChars > 0) {
			const ratio = textChars / textTokens;
			if (isFinite(ratio) && ratio >= 0.6 && ratio <= 6) {
				this.history.push(ratio);
				if (this.history.length > RATIO_HISTORY) this.history.shift();
			}
		}
	}
}

/**
 * Fast character-level token estimation.
 */
export function estimateDeltaTokens(delta: string, baseRatio: number, isToolCall: boolean): number {
	if (!delta || delta.length === 0) return 0;
	if (isToolCall) {
		return delta.length / DEFAULT_TOOL_RATIO;
	}

	let cjkCount = 0;
	for (let i = 0; i < delta.length; i++) {
		const code = delta.charCodeAt(i);
		if (
			(code >= 0x4e00 && code <= 0x9fff) ||
			(code >= 0x3400 && code <= 0x4dbf) ||
			(code >= 0x3000 && code <= 0x303f) ||
			(code >= 0xff00 && code <= 0xffef)
		) {
			cjkCount++;
		}
	}

	const nonCjkCount = delta.length - cjkCount;
	const cjkTokens = cjkCount * 0.7;
	const nonCjkTokens = nonCjkCount / Math.max(1.5, baseRatio);

	return cjkTokens + nonCjkTokens;
}

/**
 * Fast-path rule classifier before invoking Jev.
 */
export function fastClassifyModel(modelId: string): string | null {
	const lower = modelId.toLowerCase();
	if (lower.includes("minimax") || lower.includes("abab")) return "minimax";
	if (lower.includes("deepseek")) return "deepseek";
	if (lower.includes("qwen")) return "qwen";
	if (lower.includes("glm") || lower.includes("chatglm")) return "glm";
	if (
		lower.includes("gpt") ||
		lower.includes("o1") ||
		lower.includes("o3") ||
		lower.includes("codex")
	)
		return "openai";
	if (lower.includes("claude") || lower.includes("sonnet") || lower.includes("opus"))
		return "claude";
	if (lower.includes("gemini") || lower.includes("gemma")) return "gemma";
	if (lower.includes("llama")) return "llama";
	if (lower.includes("mistral") || lower.includes("mixtral") || lower.includes("codestral"))
		return "mistral";
	if (lower.includes("grok")) return "grok";
	if (lower.includes("phi")) return "phi";
	if (lower.includes("yi-") || lower.includes("01-ai")) return "yi";
	return null;
}

/**
 * Read Jev API key from ~/.pi/agent/auth.json
 */
function getJevApiKey(): string | null {
	try {
		const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
		if (!fs.existsSync(authPath)) return null;
		const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
		const jev = auth["typesafe-jev"];
		if (!jev) return null;
		if (typeof jev === "string") return jev;
		return jev.key || jev.apiKey || jev.token || null;
	} catch {
		return null;
	}
}

/**
 * Tokenizer Manager: handles classification (Jev + cache), lazy downloading, and caching.
 */
class TokenizerManager {
	private readonly cacheDir: string;
	private readonly taxonomyCacheFile: string;
	private taxonomyCache: Record<string, string> = {};
	private tokenizerInstances = new Map<string, Tokenizer>();
	private downloading = new Set<string>();

	constructor() {
		this.cacheDir = path.join(os.homedir(), ".pi", "agent", "cache", "tokenizers");
		this.taxonomyCacheFile = path.join(os.homedir(), ".pi", "agent", "model-tokenizer-cache.json");
		try {
			fs.mkdirSync(this.cacheDir, { recursive: true });
			if (fs.existsSync(this.taxonomyCacheFile)) {
				this.taxonomyCache = JSON.parse(fs.readFileSync(this.taxonomyCacheFile, "utf8"));
			}
		} catch {
			// ignore
		}
	}

	/**
	 * Classify model identifier into tokenizer family.
	 * Fast-path -> Local Cache -> Jev.
	 */
	async resolveFamily(modelId: string): Promise<string> {
		if (!modelId) return "generic";

		// 1. Fast path
		const fast = fastClassifyModel(modelId);
		if (fast) return fast;

		// 2. Local cache
		if (this.taxonomyCache[modelId]) {
			return this.taxonomyCache[modelId];
		}

		// 3. Jev evaluation
		const apiKey = getJevApiKey();
		if (apiKey) {
			try {
				const client = createJevClient({ apiKey });
				const res = await client.evaluate({
					state: { modelId },
					questions: {
						family: {
							type: "choice",
							instructions:
								"Classify this deployed model identifier into its core base architecture/tokenizer family.",
							criteria: JEV_CRITERIA,
						},
					},
				});
				const choice = res.answers.family?.choice;
				if (choice && choice !== "other") {
					const mapped = choice === "gemini" ? "gemma" : choice;
					this.taxonomyCache[modelId] = mapped;
					try {
						fs.writeFileSync(
							this.taxonomyCacheFile,
							JSON.stringify(this.taxonomyCache, null, 2),
							"utf8",
						);
					} catch {
						// ignore
					}
					return mapped;
				}
			} catch {
				// Fallback if Jev request fails
			}
		}

		return "generic";
	}

	/**
	 * Get loaded tokenizer for a family if available, or start background lazy download.
	 */
	getOrLoad(family: string, onLoaded?: () => void): Tokenizer | null {
		if (family === "generic" || !TOKENIZER_REGISTRY[family]) {
			return null;
		}

		// 1. In-memory loaded instance
		if (this.tokenizerInstances.has(family)) {
			return this.tokenizerInstances.get(family)!;
		}

		const localPath = path.join(this.cacheDir, `${family}.json`);

		// 2. Local cached file exists -> load asynchronously
		if (fs.existsSync(localPath)) {
			fs.promises
				.readFile(localPath, "utf8")
				.then((text) => {
					const json = JSON.parse(text);
					const tok = new Tokenizer(json, {});
					this.tokenizerInstances.set(family, tok);
					onLoaded?.();
				})
				.catch(() => {
					// Corrupt file, remove and re-download
					try {
						fs.unlinkSync(localPath);
					} catch {
						// ignore
					}
				});
			return null;
		}

		// 3. Not downloaded yet -> start non-blocking background fetch
		if (!this.downloading.has(family)) {
			this.downloading.add(family);
			const entry = TOKENIZER_REGISTRY[family];
			this.downloadFile(entry.url, entry.fallbackUrl, localPath)
				.then((json) => {
					this.downloading.delete(family);
					if (json) {
						const tok = new Tokenizer(json, {});
						this.tokenizerInstances.set(family, tok);
						onLoaded?.();
					}
				})
				.catch(() => {
					this.downloading.delete(family);
				});
		}

		return null;
	}

	private async downloadFile(
		url: string,
		fallbackUrl: string | undefined,
		destPath: string,
	): Promise<object | null> {
		const tryFetch = async (targetUrl: string) => {
			const res = await fetch(targetUrl, {
				headers: { "User-Agent": "Mozilla/5.0" },
				redirect: "follow",
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.text();
		};

		let text: string;
		try {
			text = await tryFetch(url);
		} catch (err) {
			if (fallbackUrl) {
				text = await tryFetch(fallbackUrl);
			} else {
				throw err;
			}
		}

		const tmpPath = `${destPath}.tmp-${Date.now()}`;
		await fs.promises.writeFile(tmpPath, text, "utf8");
		await fs.promises.rename(tmpPath, destPath);
		return JSON.parse(text);
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let streaming = false;
	const charRatio = new CharRatio();
	const tokenizerManager = new TokenizerManager();

	let currentFamily = "generic";
	let activeTokenizer: Tokenizer | null = null;
	let isEstimate = true;

	let lastCtx: { ui: { setStatus(key: string, text?: string): void } } | null = null;

	function countTokens(text: string): number {
		if (!isEstimate && activeTokenizer) {
			try {
				return activeTokenizer.encode(text).ids.length;
			} catch {
				return estimateDeltaTokens(text, charRatio.value(), false);
			}
		}
		return estimateDeltaTokens(text, charRatio.value(), false);
	}

	// Oh My Pi TokenRateMeter using the dynamic counter
	const meter = new TokenRateMeter((text) => countTokens(text));

	let tracker: Tracker = newTracker();
	let messageSpeeds: number[] = [];

	function newTracker(): Tracker {
		return {
			startTime: null,
			endTime: null,
			phase: null,
			textChars: 0,
			toolChars: 0,
			estimatedTokens: 0,
			usageOutput: 0,
			lastSpeed: null,
		};
	}

	function pushStatus(ctx: { ui: { setStatus(key: string, text?: string): void } }) {
		lastCtx = ctx;
		if (!enabled) return;
		ctx.ui.setStatus(STATUS_KEY, formatSpeed());
	}

	/**
	 * Switch model family and load its tokenizer non-blockingly.
	 */
	function updateActiveModel(modelId: string | undefined) {
		if (!modelId) return;
		tokenizerManager.resolveFamily(modelId).then((family) => {
			currentFamily = family;
			const tok = tokenizerManager.getOrLoad(family, () => {
				// Called when tokenizer is loaded from disk or network
				activeTokenizer = tokenizerManager.getOrLoad(family);
				isEstimate = activeTokenizer === null;
				if (lastCtx) pushStatus(lastCtx);
			});
			activeTokenizer = tok;
			isEstimate = activeTokenizer === null;
			if (lastCtx) pushStatus(lastCtx);
		});
	}

	function recordDelta(delta: string, isToolCall: boolean, now: number) {
		if (tracker.startTime === null) tracker.startTime = now;
		tracker.endTime = now;

		if (isToolCall) {
			tracker.toolChars += delta.length;
		} else {
			tracker.textChars += delta.length;
		}

		const tokens = isEstimate
			? estimateDeltaTokens(delta, charRatio.value(), isToolCall)
			: countTokens(delta);
		tracker.estimatedTokens += tokens;

		meter.push(delta, now);
	}

	function formatSpeed(): string {
		const fs = (v: number | null) =>
			v !== null && isFinite(v) && v > 0 ? v.toFixed(1) : "—";

		const liveRate = meter.rate();
		const short = streaming ? liveRate : tracker.lastSpeed;
		const mid = messageSpeeds.length >= 1 ? messageSpeeds[0] : null;
		let long: number | null = null;
		if (messageSpeeds.length >= 2) {
			const subset = messageSpeeds.slice(0, HISTORY_LEN);
			long = subset.reduce((a, b) => a + b, 0) / subset.length;
		} else if (messageSpeeds.length === 1) {
			long = messageSpeeds[0];
		}

		const suffix = isEstimate ? " (estimate)" : "";

		if (streaming) {
			const tag = tracker.phase === "thinking" ? "🤔" : "✏️";
			if (short === null && mid === null && long === null) {
				return `${tag} generating…${suffix}`;
			}
			return `${tag} ${fs(short)} / ${fs(mid)} / ${fs(long)} tok/s${suffix}`;
		}

		return `⚡ ${fs(short)} / ${fs(mid)} / ${fs(long)} tok/s${suffix}`;
	}

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		tracker = newTracker();
		messageSpeeds = [];
		meter.reset();

		if (ctx.model) {
			updateActiveModel(ctx.model.id);
		}

		// Seed from previous session entries if available
		try {
			const entries = ctx.sessionManager?.getEntries?.() ?? [];
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry.type === "message" && entry.message?.role === "assistant") {
					const msg = entry.message;
					const output = msg.usage?.output;
					const duration = (msg as { duration?: number }).duration;
					if (
						typeof output === "number" &&
						output > 0 &&
						typeof duration === "number" &&
						duration > 0
					) {
						const speed = (output * 1000) / duration;
						messageSpeeds.push(speed);
						if (messageSpeeds.length === 1) {
							tracker.lastSpeed = speed;
							meter.seed(output, duration);
						}
						if (messageSpeeds.length >= HISTORY_LEN) break;
					}
				}
			}
		} catch {
			// Ignore if session entries are unavailable
		}

		pushStatus(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		lastCtx = ctx;
		if (event.model) {
			updateActiveModel(event.model.id);
		}
	});

	pi.on("message_start", async (event, ctx) => {
		lastCtx = ctx;
		if (event.message.role !== "assistant") return;
		tracker = newTracker();
		streaming = true;

		const modelId = event.message.model || ctx.model?.id;
		if (modelId) {
			updateActiveModel(modelId);
		}

		meter.begin(Date.now());
	});

	pi.on("message_update", async (event, ctx) => {
		if (!enabled) return;
		if (event.message.role !== "assistant") return;

		const ev = event.assistantMessageEvent;
		if (!ev) return;
		const now = Date.now();

		const delta = ev.delta ?? "";
		if (ev.type === "thinking_delta") {
			tracker.phase = "thinking";
			recordDelta(delta, false, now);
		} else if (ev.type === "text_delta") {
			tracker.phase = "answering";
			recordDelta(delta, false, now);
		} else if (ev.type === "toolcall_delta") {
			tracker.phase = "answering";
			recordDelta(delta, true, now);
		} else {
			return;
		}

		if (debugEnabled) {
			const estTokens = countTokens(delta);
			debugRows.push({ ts: now, type: ev.type, chars: delta.length, tokens: estTokens });
		}

		pushStatus(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		streaming = false;

		const now = Date.now();
		const usageOutput = event.message.usage?.output ?? 0;
		if (usageOutput > 0) tracker.usageOutput = usageOutput;

		meter.end(tracker.usageOutput > 0 ? tracker.usageOutput : undefined, now);

		const elapsed =
			tracker.startTime !== null && tracker.endTime !== null
				? tracker.endTime - tracker.startTime
				: null;
		if (elapsed !== null && elapsed > 0) {
			const totalTokens =
				tracker.usageOutput > 0 ? tracker.usageOutput : tracker.estimatedTokens;
			if (totalTokens > 0) {
				tracker.lastSpeed = (totalTokens / elapsed) * 1000;
				meter.seed(totalTokens, elapsed);
			}
		}

		if (tracker.usageOutput > 0) {
			charRatio.update(tracker.textChars, tracker.toolChars, tracker.usageOutput);
		}

		if (debugEnabled) {
			debugUsage = {
				output: tracker.usageOutput || undefined,
				reasoning: event.message.usage?.reasoning ?? undefined,
				chars: tracker.textChars + tracker.toolChars || undefined,
			};
			const fsModule = await import("node:fs");
			const debugPath = `/tmp/tokenspeed-debug-${Date.now()}.json`;
			fsModule.writeFileSync(
				debugPath,
				JSON.stringify(
					{
						usage: debugUsage,
						ratio: charRatio.value(),
						family: currentFamily,
						isEstimate,
						samples: debugRows,
					},
					null,
					"\t",
				),
			);
			debugRows = [];
			ctx.ui.notify(`tokenspeed debug dump: ${debugPath}`, "info");
		}

		if (tracker.lastSpeed !== null) {
			messageSpeeds.unshift(tracker.lastSpeed);
			if (messageSpeeds.length > HISTORY_LEN) {
				messageSpeeds.length = HISTORY_LEN;
			}
		}

		pushStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		streaming = false;
		pushStatus(ctx);
	});

	pi.registerCommand("tokenspeed-debug", {
		description: "Toggle per-delta debug dump (written to /tmp after each message)",
		handler: async (_args, ctx) => {
			debugEnabled = !debugEnabled;
			debugRows = [];
			ctx.ui.notify(
				debugEnabled ? "tokenspeed debug ON" : "tokenspeed debug OFF",
				"info",
			);
		},
	});

	pi.registerCommand("tokenspeed", {
		description: "Toggle the model output-speed status in the footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;

			if (enabled) {
				pushStatus(ctx);
				ctx.ui.notify("Token-speed status enabled", "info");
			} else {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("Token-speed status disabled", "info");
			}
		},
	});
}
