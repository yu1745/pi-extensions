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
 * - **Short**: real-time speed over a ~4s rolling window (current streaming)
 * - **Mid**:    average speed of the last 1 assistant message
 * - **Long**:   average speed of the last 5 assistant messages
 *
 * ## Design (v4 — per-delta counting, active-time window, usage reconciliation)
 *
 * Verified against pi-mono source (packages/agent/src/agent-loop.ts,
 * packages/ai/src/api/*.ts):
 *
 * - Providers mutate the partial AssistantMessage in place, and every
 *   `message_update` carries the authoritative stream event in
 *   `event.assistantMessageEvent` — including `delta` strings for
 *   text / thinking / tool-call arguments. This is the most reliable
 *   mid-stream signal: it covers every content path regardless of provider.
 * - `usage.output` arrives **only at the end of the stream** for most
 *   providers (Anthropic final `message_delta`, OpenAI final chunk with
 *   `stream_options.include_usage`, codex `response.completed`). So usage
 *   can only be used for the *finalized* per-message speed — never
 *   mid-stream.
 * - Wall-clock-windowed rates decay when the provider batches chunks or the
 *   network stalls, because elapsed time grows while tokens don't. The fix
 *   (same approach as community meters like opencode-tps) is to measure
 *   **active time**: the sum of inter-sample gaps inside the window, with the
 *   idle tail capped, so pauses don't dilute the readout.
 * - The chars→tokens ratio is learned per message: after each message whose
 *   final `usage.output` is known, we record chars/token and reuse the recent
 *   median (CJK text is ~1.5-2 chars/token vs ~4 for English, so a fixed
 *   ratio misreads one of them by 2-3x).
 *
 * Uses `ctx.ui.setStatus()`, so pi's native footer is untouched.
 * Toggle with the `/tokenspeed` command.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WINDOW_MS = 4000; // rolling window length for short-term speed
const TAIL_CAP_MS = 1000; // idle time after the last sample counted as active
const GAP_CAP_MS = 100; // per-gap cap: bursts of same-millisecond chunks
// must not be treated as free time; long stalls (>100ms) don't dilute the
// rate either. Chosen empirically against a real SSE delta dump (median
// inter-chunk gap ~30ms, bursts of 2-3 chunks per network packet).
const MIN_ACTIVE_MS = 200; // minimum active time before trusting the rate
const DEFAULT_CHARS_PER_TOKEN = 4; // before any ratio is learned
const STATUS_KEY = "tokenspeed";
const HISTORY_LEN = 5; // how many past messages to keep for long-term average
const RATIO_HISTORY = 10; // chars/token samples kept for the median

/** Which part of the message we're currently in — only affects the icon. */
type Phase = "thinking" | "answering" | null;

/** One streamed chunk: when it arrived and how many chars it carried. */
interface Sample {
	ts: number;
	chars: number;
}

/** Debug: full per-delta log for offline analysis (see /tokenspeed-debug). */
interface DebugRow {
	ts: number;
	type: string;
	chars: number;
}
let debugEnabled = false;
let debugRows: DebugRow[] = [];
let debugStart: number | null = null;
let debugUsage: { output?: number; reasoning?: number; chars?: number } = {};

interface Tracker {
	/** Timestamp of the first delta of this message. */
	startTime: number | null;
	/** Timestamp of the last delta of this message. */
	endTime: number | null;
	/** Current phase — icon only. */
	phase: Phase;
	/** Rolling window of recent samples (ts + chars of each delta). */
	samples: Sample[];
	/** Total chars across ALL deltas of this message. */
	chars: number;
	/** Final `usage.output` from the provider, once it arrives. */
	usageOutput: number;
	/** Final combined speed (tok/s) for this message. */
	lastSpeed: number | null;
	/** Real-time speed (tok/s) while streaming. */
	currentSpeed: number | null;
	/** Chars-per-token ratio used for this message's estimates. */
	ratio: number;
}

/**
 * Adaptive chars-per-token ratio. English is ~4 chars/token, CJK ~1.5-2 —
 * a fixed value misreads one of them badly. After each finished message we
 * record the measured ratio and use the recent median for the next message.
 */
class CharRatio {
	private history: number[] = [];

	value(): number {
		if (this.history.length === 0) return DEFAULT_CHARS_PER_TOKEN;
		const sorted = [...this.history].sort((a, b) => a - b);
		return sorted[Math.floor(sorted.length / 2)];
	}

	update(chars: number, tokens: number) {
		if (chars <= 0 || tokens <= 0) return;
		const ratio = chars / tokens;
		// Sanity clamp: real tokenizers stay within ~0.5..8 chars/token.
		if (!isFinite(ratio) || ratio < 0.5 || ratio > 8) return;
		this.history.push(ratio);
		if (this.history.length > RATIO_HISTORY) this.history.shift();
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let streaming = false;
	const charRatio = new CharRatio();
	let tracker: Tracker = newTracker(charRatio.value());

	// History of finalized per-message speeds (most recent first).
	let messageSpeeds: number[] = [];

	function newTracker(ratio: number): Tracker {
		return {
			startTime: null,
			endTime: null,
			phase: null,
			samples: [],
			chars: 0,
			usageOutput: 0,
			lastSpeed: null,
			currentSpeed: null,
			ratio,
		};
	}

	function pushStatus(ctx: { ui: { setStatus(key: string, text?: string): void } }) {
		if (!enabled) return;
		ctx.ui.setStatus(STATUS_KEY, formatSpeed());
	}

	/**
	 * Active (generating) time inside the current window: sum of gaps between
	 * consecutive samples, plus the idle tail capped at TAIL_CAP_MS. Network
	 * stalls and chunk batching therefore don't dilute the rate.
	 */
	function activeMs(samples: Sample[], now: number): number {
		if (samples.length === 0) return 0;
		let total = 0;
		for (let i = 1; i < samples.length; i++) {
			total += Math.min(
				Math.max(0, samples[i].ts - samples[i - 1].ts),
				GAP_CAP_MS,
			);
		}
		total += Math.min(Math.max(0, now - samples[samples.length - 1].ts), TAIL_CAP_MS);
		return total;
	}

	/** Record one streamed delta and refresh the real-time speed. */
	function recordDelta(deltaChars: number, now: number) {
		if (tracker.startTime === null) tracker.startTime = now;
		tracker.endTime = now;
		tracker.chars += deltaChars;

		tracker.samples.push({ ts: now, chars: deltaChars });
		const cutoff = now - WINDOW_MS;
		while (tracker.samples.length > 2 && tracker.samples[0].ts < cutoff) {
			tracker.samples.shift();
		}

		const windowChars = tracker.samples.reduce((a, s) => a + s.chars, 0);
		const dt = activeMs(tracker.samples, now);
		if (dt >= MIN_ACTIVE_MS) {
			tracker.currentSpeed = (windowChars / tracker.ratio / dt) * 1000;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		tracker = newTracker(charRatio.value());
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
		tracker = newTracker(charRatio.value());
		streaming = true;
	});

	pi.on("message_update", async (event, ctx) => {
		if (!enabled) return;
		if (event.message.role !== "assistant") return;

		const ev = event.assistantMessageEvent;
		if (!ev) return;
		const now = Date.now();

		// Per-delta capture — the authoritative mid-stream signal. Covers
		// text, thinking AND tool-call arguments; whatever the provider
		// streams arrives here.
		if (ev.type === "thinking_delta") {
			tracker.phase = "thinking";
			recordDelta(ev.delta?.length ?? 0, now);
		} else if (ev.type === "text_delta") {
			tracker.phase = "answering";
			recordDelta(ev.delta?.length ?? 0, now);
		} else if (ev.type === "toolcall_delta") {
			tracker.phase = "answering";
			recordDelta(ev.delta?.length ?? 0, now);
		} else {
			return;
		}
		if (debugEnabled) {
			debugRows.push({ ts: now, type: ev.type, chars: ev.delta?.length ?? 0 });
		}

		pushStatus(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		streaming = false;

		const usageOutput = event.message.usage?.output ?? 0;
		if (usageOutput > 0) tracker.usageOutput = usageOutput;

		// Finalized speed: prefer the provider's actually-returned token
		// count; wall time from first to last delta (excludes any post-stream
		// bookkeeping delay before message_end fires).
		const elapsed = tracker.startTime !== null && tracker.endTime !== null
			? tracker.endTime - tracker.startTime
			: null;
		if (elapsed !== null && elapsed > 0) {
			const totalTokens = tracker.usageOutput > 0
				? tracker.usageOutput
				: tracker.chars / tracker.ratio;
			if (totalTokens > 0) {
				tracker.lastSpeed = (totalTokens / elapsed) * 1000;
			}
		}

		// Learn the real chars/token ratio for the next message's estimates.
		charRatio.update(tracker.chars, tracker.usageOutput);

		if (debugEnabled) {
			debugUsage = {
				output: tracker.usageOutput || undefined,
				reasoning: event.message.usage?.reasoning ?? undefined,
				chars: tracker.chars || undefined,
			};
			const fs = await import("node:fs");
			const path = `/tmp/tokenspeed-debug-${Date.now()}.json`;
			fs.writeFileSync(
				path,
				JSON.stringify(
					{ usage: debugUsage, ratio: tracker.ratio, samples: debugRows },
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
