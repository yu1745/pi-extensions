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
 * - **Short**: real-time speed over a ~3s rolling window (current streaming)
 * - **Mid**:    average speed of the last 1 assistant message
 * - **Long**:   average speed of the last 5 assistant messages
 *
 * Uses `ctx.ui.setStatus()`, so pi's native footer is untouched.
 * Toggle with the `/tokenspeed` command.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WINDOW_MS = 3000; // rolling window length for real-time speed
const MIN_SAMPLES = 3; // need at least 3 samples (sample 0 dropped as initial burst, 1..N form span)
const MIN_WINDOW_TIME_MS = 600; // minimum span in ms to prevent small-divisor spikes
const STATUS_KEY = "tokenspeed";
const HISTORY_LEN = 5; // how many past messages to keep for long-term average
const RATIO_HISTORY = 10; // chars/token samples kept for the median

/** Default fallback characters-per-token ratios if uncalibrated */
const DEFAULT_TEXT_RATIO = 2.5; // blended default for CJK / English text & thinking
const DEFAULT_TOOL_RATIO = 3.5; // JSON arguments have higher chars-per-token

/** Which part of the message we're currently in — only affects the icon. */
type Phase = "thinking" | "answering" | null;

/** One streamed chunk: when it arrived, how many estimated tokens it carried. */
interface Sample {
	ts: number;
	tokens: number;
}

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
	/** Timestamp of the first delta of this message. */
	startTime: number | null;
	/** Timestamp of the last delta of this message. */
	endTime: number | null;
	/** Current phase — icon only. */
	phase: Phase;
	/** Rolling window of recent samples (ts + estimated tokens of each delta). */
	samples: Sample[];
	/** Total chars across text and thinking deltas of this message. */
	textChars: number;
	/** Total chars across tool call deltas of this message. */
	toolChars: number;
	/** Total estimated tokens streamed so far. */
	estimatedTokens: number;
	/** Final `usage.output` from the provider, once it arrives. */
	usageOutput: number;
	/** Final combined speed (tok/s) for this message. */
	lastSpeed: number | null;
	/** Real-time speed (tok/s) while streaming. */
	currentSpeed: number | null;
}

/**
 * Adaptive chars-per-token ratio estimator.
 * Distinguishes general text (including CJK/English/thinking) from JSON/code.
 */
class CharRatio {
	private history: number[] = [];

	value(): number {
		if (this.history.length === 0) return DEFAULT_TEXT_RATIO;
		const sorted = [...this.history].sort((a, b) => a - b);
		return sorted[Math.floor(sorted.length / 2)];
	}

	/**
	 * Calibrate ratio after receiving authoritative usage.output at message_end.
	 */
	update(textChars: number, toolChars: number, totalTokens: number) {
		if (totalTokens <= 0 || (textChars <= 0 && toolChars <= 0)) return;

		// Deduct estimated tool tokens (using fixed JSON ratio) to isolate text ratio
		const estToolTokens = toolChars / DEFAULT_TOOL_RATIO;
		const textTokens = Math.max(1, totalTokens - estToolTokens);
		if (textChars > 0) {
			const ratio = textChars / textTokens;
			// Sanity clamp: real tokenizers stay within ~0.6..6 chars/token.
			if (isFinite(ratio) && ratio >= 0.6 && ratio <= 6) {
				this.history.push(ratio);
				if (this.history.length > RATIO_HISTORY) this.history.shift();
			}
		}
	}
}

/**
 * Fast character-level token estimation.
 * Takes into account CJK characters (~0.6-1 token/char) vs ASCII words (~0.25-0.3 token/char).
 */
function estimateDeltaTokens(delta: string, baseRatio: number, isToolCall: boolean): number {
	if (!delta || delta.length === 0) return 0;
	if (isToolCall) {
		return delta.length / DEFAULT_TOOL_RATIO;
	}

	// Count CJK characters for higher precision before/alongside calibration
	let cjkCount = 0;
	for (let i = 0; i < delta.length; i++) {
		const code = delta.charCodeAt(i);
		if (
			(code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
			(code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
			(code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation
			(code >= 0xff00 && code <= 0xffef)    // Halfwidth and Fullwidth Forms
		) {
			cjkCount++;
		}
	}

	const nonCjkCount = delta.length - cjkCount;
	// CJK is typically ~1.4 chars/token (~0.7 tokens/char)
	// Non-CJK uses calibrated base ratio (or default)
	const cjkTokens = cjkCount * 0.7;
	const nonCjkTokens = nonCjkCount / Math.max(1.5, baseRatio);

	return cjkTokens + nonCjkTokens;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let streaming = false;
	const charRatio = new CharRatio();
	let tracker: Tracker = newTracker();

	// History of finalized per-message speeds (most recent first).
	let messageSpeeds: number[] = [];

	function newTracker(): Tracker {
		return {
			startTime: null,
			endTime: null,
			phase: null,
			samples: [],
			textChars: 0,
			toolChars: 0,
			estimatedTokens: 0,
			usageOutput: 0,
			lastSpeed: null,
			currentSpeed: null,
		};
	}

	function pushStatus(ctx: { ui: { setStatus(key: string, text?: string): void } }) {
		if (!enabled) return;
		ctx.ui.setStatus(STATUS_KEY, formatSpeed());
	}

	/** Record one streamed delta and refresh the real-time speed. */
	function recordDelta(delta: string, isToolCall: boolean, now: number) {
		if (tracker.startTime === null) tracker.startTime = now;
		tracker.endTime = now;

		if (isToolCall) {
			tracker.toolChars += delta.length;
		} else {
			tracker.textChars += delta.length;
		}

		const tokens = estimateDeltaTokens(delta, charRatio.value(), isToolCall);
		tracker.estimatedTokens += tokens;

		tracker.samples.push({ ts: now, tokens });

		// Evict samples older than WINDOW_MS
		const cutoff = now - WINDOW_MS;
		while (tracker.samples.length > MIN_SAMPLES && tracker.samples[0].ts < cutoff) {
			tracker.samples.shift();
		}

		if (tracker.samples.length >= MIN_SAMPLES) {
			// Skip tracker.samples[0] (initial chunk burst / connection warm-up)
			const baseSample = tracker.samples[1];
			const lastSample = tracker.samples[tracker.samples.length - 1];
			const windowSpanMs = lastSample.ts - baseSample.ts;

			if (windowSpanMs >= MIN_WINDOW_TIME_MS) {
				// Sum tokens generated from baseSample onwards
				let windowTokens = 0;
				for (let i = 2; i < tracker.samples.length; i++) {
					windowTokens += tracker.samples[i].tokens;
				}
				const rawSpeed = (windowTokens / windowSpanMs) * 1000;
				// Smooth with exponential moving average to avoid single-packet jitter
				if (tracker.currentSpeed === null) {
					tracker.currentSpeed = rawSpeed;
				} else {
					tracker.currentSpeed = tracker.currentSpeed * 0.7 + rawSpeed * 0.3;
				}
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		tracker = newTracker();
		messageSpeeds = [];
		pushStatus(ctx);
	});

	function formatSpeed(): string {
		const fs = (v: number | null) =>
			v !== null && isFinite(v) && v > 0 ? v.toFixed(1) : "—";

		const short = streaming ? tracker.currentSpeed : tracker.lastSpeed;
		const mid = messageSpeeds.length >= 1 ? messageSpeeds[0] : null;
		let long: number | null = null;
		if (messageSpeeds.length >= 2) {
			const subset = messageSpeeds.slice(0, HISTORY_LEN);
			long = subset.reduce((a, b) => a + b, 0) / subset.length;
		} else if (messageSpeeds.length === 1) {
			long = messageSpeeds[0];
		}

		if (streaming) {
			const tag = tracker.phase === "thinking" ? "💭" : "✍";
			if (short === null && mid === null && long === null) {
				return `${tag} generating…`;
			}
			return `${tag} ${fs(short)} / ${fs(mid)} / ${fs(long)} tok/s`;
		}

		return `⚡ ${fs(short)} / ${fs(mid)} / ${fs(long)} tok/s`;
	}

	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		tracker = newTracker();
		streaming = true;
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
			const estTokens = estimateDeltaTokens(delta, charRatio.value(), ev.type === "toolcall_delta");
			debugRows.push({ ts: now, type: ev.type, chars: delta.length, tokens: estTokens });
		}

		pushStatus(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		streaming = false;

		const usageOutput = event.message.usage?.output ?? 0;
		if (usageOutput > 0) tracker.usageOutput = usageOutput;

		// Finalized speed: total authoritative tokens divided by total generation duration
		// from first chunk arrival to last chunk arrival.
		const elapsed = tracker.startTime !== null && tracker.endTime !== null
			? tracker.endTime - tracker.startTime
			: null;
		if (elapsed !== null && elapsed > 0) {
			const totalTokens = tracker.usageOutput > 0
				? tracker.usageOutput
				: tracker.estimatedTokens;
			if (totalTokens > 0) {
				tracker.lastSpeed = (totalTokens / elapsed) * 1000;
			}
		}

		// Calibrate ratio for future message estimates
		if (tracker.usageOutput > 0) {
			charRatio.update(tracker.textChars, tracker.toolChars, tracker.usageOutput);
		}

		if (debugEnabled) {
			debugUsage = {
				output: tracker.usageOutput || undefined,
				reasoning: event.message.usage?.reasoning ?? undefined,
				chars: tracker.textChars + tracker.toolChars || undefined,
			};
			const fs = await import("node:fs");
			const path = `/tmp/tokenspeed-debug-${Date.now()}.json`;
			fs.writeFileSync(
				path,
				JSON.stringify(
					{ usage: debugUsage, ratio: charRatio.value(), samples: debugRows },
					null,
					"\t",
				),
			);
			debugRows = [];
			ctx.ui.notify(`tokenspeed debug dump: ${path}`, "info");
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
