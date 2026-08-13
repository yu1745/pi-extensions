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
 * - **Short**: real-time speed from a ~4s sliding window (current streaming)
 * - **Mid**:    average speed of the last 1 assistant message
 * - **Long**:   average speed of the last 5 assistant messages
 *
 * ## Reasoning-aware
 *
 * Many providers only emit a single `usage` at the very end of the stream (or
 * update it only once the answer body starts). Relying solely on
 * `usage.output` therefore makes the speed readout sit dead at "—" during the
 * whole thinking phase and then snap to a value the instant reasoning finishes
 * — exactly the bug this version fixes.
 *
 * We now track thinking and answering as two independent phases, each with its
 * own sliding window that falls back to a chars/4 token estimate whenever the
 * provider's `usage.output` isn't advancing. While reasoning, the status shows
 * the thinking speed prefixed with 💭; once the body starts streaming it shows
 * the answer speed prefixed with ✍.
 *
 * Uses `ctx.ui.setStatus()`, so pi's native footer is untouched.
 * Toggle with the `/tokenspeed` command.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Phase tracking --------------------------------------------------------

/**
 * Which part of the assistant message we are currently in.
 *
 * - "thinking": receiving `thinking_delta` (reasoning/thinking phase)
 * - "answering": receiving `text_delta` (the visible answer)
 *
 * `null` means we haven't seen either yet.
 */
type Phase = "thinking" | "answering" | null;

interface PhaseWindow {
	/** Sliding window of [timestampMs, cumulativeTokens]. */
	samples: Array<[number, number]>;
	/** Sliding window of [timestampMs, cumulativeChars] for the char fallback. */
	charSamples: Array<[number, number]>;
	/** First-seen timestamp for this phase, in ms. */
	startTime: number | null;
	/** Cumulative chars seen in this phase's deltas. */
	chars: number;
	/**
	 * Highest cumulative token count attributable to this phase.
	 *
	 * For "thinking" this is `usage.reasoning` (a subset of `usage.output`).
	 * For "answering" this is `usage.output - (usage.reasoning ?? 0)`.
	 * Either may stay flat when the provider doesn't stream usage deltas.
	 */
	lastTokens: number;
	/** Last measured real-time speed (tok/s) for this phase. */
	currentSpeed: number | null;
	/** Final measured speed (tok/s) for this phase, set at message_end. */
	finalSpeed: number | null;
}

function newPhaseWindow(): PhaseWindow {
	return {
		samples: [],
		charSamples: [],
		startTime: null,
		chars: 0,
		lastTokens: 0,
		currentSpeed: null,
		finalSpeed: null,
	};
}

interface SpeedTracker {
	/** When the very first delta of the message arrived (any phase). */
	startTime: number | null;
	/** Phase we're currently streaming. */
	phase: Phase;
	/** Per-phase state. */
	thinking: PhaseWindow;
	answering: PhaseWindow;
	/** Last cumulative usage.output reported by the provider. */
	lastOutputTokens: number;
	/** Last cumulative usage.reasoning reported by the provider. */
	lastReasoningTokens: number;
	/** Final combined speed (tok/s) for the most recent message. */
	lastSpeed: number | null;
}

function newTracker(): SpeedTracker {
	return {
		startTime: null,
		phase: null,
		thinking: newPhaseWindow(),
		answering: newPhaseWindow(),
		lastOutputTokens: 0,
		lastReasoningTokens: 0,
		lastSpeed: null,
	};
}

const WINDOW_MS = 4000; // rolling window length for short-term speed
const MIN_WINDOW_MS = 600; // need at least this much elapsed to trust the rate
const CHARS_PER_TOKEN = 4; // rough estimate when usage isn't streaming
const STATUS_KEY = "tokenspeed";
const HISTORY_LEN = 5; // how many past messages to keep for long-term average

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let tracker = newTracker();
	let streaming = false;

	// History of finalized per-message speeds (most recent first).
	let messageSpeeds: number[] = [];

	function pushStatus(ctx: { ui: { setStatus(key: string, text?: string): void } }) {
		if (!enabled) return;
		ctx.ui.setStatus(STATUS_KEY, formatSpeed());
	}

	function resetTracker() {
		tracker = newTracker();
	}

	function resetHistory() {
		messageSpeeds = [];
	}

	/**
	 * Feed one sample into a phase's sliding window and refresh its real-time
	 * speed. Falls back to a chars/4 estimate when the provider isn't advancing
	 * usage during streaming.
	 */
	function recordPhaseSample(pw: PhaseWindow, ts: number) {
		if (pw.startTime === null) pw.startTime = ts;

		const cutoff = ts - WINDOW_MS;

		// Push the usage-derived token count.
		pw.samples.push([ts, pw.lastTokens]);
		while (pw.samples.length > 2 && pw.samples[0][0] < cutoff) {
			pw.samples.shift();
		}

		// Push the char count in lockstep so the fallback can use the same
		// rolling window instead of the phase's total elapsed time.
		pw.charSamples.push([ts, pw.chars]);
		while (pw.charSamples.length > 2 && pw.charSamples[0][0] < cutoff) {
			pw.charSamples.shift();
		}

		// Primary path: rate over the window from advancing usage tokens.
		if (pw.samples.length >= 2) {
			const [t0, v0] = pw.samples[0];
			const [t1, v1] = pw.samples[pw.samples.length - 1];
			const dt = t1 - t0;
			if (dt >= MIN_WINDOW_MS) {
				const dv = v1 - v0;
				if (dv > 0) {
					pw.currentSpeed = (dv / dt) * 1000;
					return;
				}
			}
		}

		// Fallback: estimate from the chars received inside the same rolling
		// window. Measuring the *delta* of chars (not chars-since-phase-start)
		// means a pause in streaming leaves the last speed in place instead of
		// decaying toward zero while time keeps advancing.
		if (pw.charSamples.length >= 2) {
			const [t0, c0] = pw.charSamples[0];
			const [t1, c1] = pw.charSamples[pw.charSamples.length - 1];
			const dt = t1 - t0;
			if (dt >= MIN_WINDOW_MS) {
				const dc = c1 - c0;
				if (dc > 0) {
					pw.currentSpeed = ((dc / CHARS_PER_TOKEN) / dt) * 1000;
					return;
				}
			}
		}

		// Otherwise leave whatever speed we last computed.
	}

	function recordSample(now: number) {
		if (tracker.startTime === null) tracker.startTime = now;
		const phase = tracker.phase;
		if (phase === "thinking") recordPhaseSample(tracker.thinking, now);
		else if (phase === "answering") recordPhaseSample(tracker.answering, now);
	}

	pi.on("session_start", async (_event, ctx) => {
		resetTracker();
		resetHistory();
		pushStatus(ctx);
	});

	function currentPhaseSpeed(): number | null {
		const phase = tracker.phase;
		if (phase === "thinking") return tracker.thinking.currentSpeed;
		if (phase === "answering") return tracker.answering.currentSpeed;
		return tracker.thinking.currentSpeed ?? tracker.answering.currentSpeed;
	}

	function formatSpeed(): string {
		// Short: real-time speed of the active phase (while streaming), else the
		// last finalized combined speed.
		const short = streaming ? currentPhaseSpeed() : tracker.lastSpeed;
		// Mid: last 1 message
		const mid = messageSpeeds.length >= 1 ? messageSpeeds[0] : null;
		// Long: average of last 5 messages
		let long: number | null = null;
		if (messageSpeeds.length >= 2) {
			const subset = messageSpeeds.slice(0, HISTORY_LEN);
			long = subset.reduce((a, b) => a + b, 0) / subset.length;
		} else if (messageSpeeds.length === 1) {
			long = messageSpeeds[0]; // same as mid when only 1 message
		}

		const fs = (v: number | null) =>
			v !== null && isFinite(v) && v > 0 ? v.toFixed(1) : "—";

		if (streaming) {
			const phase = tracker.phase;
			const tag = phase === "thinking" ? "💭" : "✍";
			if (short === null && mid === null && long === null) {
				return `${tag} generating…`;
			}
			return `${tag} ${fs(short)} / ${fs(mid)} / ${fs(long)} tok/s`;
		}

		return `⚡ ${fs(short)} / ${fs(mid)} / ${fs(long)} tok/s`;
	}

	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		resetTracker();
		streaming = true;
	});

	pi.on("message_update", async (event, ctx) => {
		if (!enabled) return;
		if (event.message.role !== "assistant") return;

		const ev = event.assistantMessageEvent;
		const now = Date.now();

		// Track which phase we're in from delta events. Tool-call arguments are
		// real (non-reasoning) output tokens, so they belong to the answering
		// phase's char estimate; ignoring them used to make the readout decay
		// during every tool call.
		if (ev.type === "thinking_delta") {
			tracker.phase = "thinking";
			tracker.thinking.chars += ev.delta?.length ?? 0;
		} else if (ev.type === "text_delta") {
			tracker.phase = "answering";
			tracker.answering.chars += ev.delta?.length ?? 0;
		} else if (ev.type === "toolcall_delta") {
			tracker.phase = "answering";
			tracker.answering.chars += ev.delta?.length ?? 0;
		}

		// Track the highest usage.output / usage.reasoning seen (monotonic).
		const out = event.message.usage?.output ?? 0;
		if (out > tracker.lastOutputTokens) tracker.lastOutputTokens = out;
		const reasoning = event.message.usage?.reasoning ?? 0;
		if (reasoning > tracker.lastReasoningTokens) tracker.lastReasoningTokens = reasoning;

		// Distribute tokens across phases. usage.output already includes
		// reasoning tokens, so the answer-side share is the difference.
		const ansTokens = Math.max(0, tracker.lastOutputTokens - tracker.lastReasoningTokens);
		if (tracker.thinking.lastTokens < tracker.lastReasoningTokens) {
			tracker.thinking.lastTokens = tracker.lastReasoningTokens;
		}
		if (tracker.answering.lastTokens < ansTokens) {
			tracker.answering.lastTokens = ansTokens;
		}

		recordSample(now);
		pushStatus(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		streaming = false;

		// Finalize per-phase speeds from whatever signal we have.
		const finalize = (pw: PhaseWindow, totalTokens: number, totalChars: number) => {
			if (pw.startTime === null) return; // phase never happened
			const elapsed = Date.now() - pw.startTime;
			if (elapsed <= 0) return;
			// Prefer the provider's authoritative token count...
			if (totalTokens > 0) {
				pw.finalSpeed = (totalTokens / elapsed) * 1000;
			} else if (totalChars > 0) {
				// ...else fall back to chars/4 estimate.
				pw.finalSpeed = ((totalChars / CHARS_PER_TOKEN) / elapsed) * 1000;
			} else if (pw.currentSpeed !== null) {
				pw.finalSpeed = pw.currentSpeed;
			}
		};

		finalize(tracker.thinking, tracker.lastReasoningTokens, tracker.thinking.chars);
		const ansTokens = Math.max(0, tracker.lastOutputTokens - tracker.lastReasoningTokens);
		finalize(tracker.answering, ansTokens, tracker.answering.chars);

		// Combined per-message speed: total tokens / total wall time of the
		// message (from first delta to now). This is what feeds mid/long.
		const totalTokens = tracker.lastOutputTokens;
		if (tracker.startTime !== null && totalTokens > 0) {
			const elapsed = Date.now() - tracker.startTime;
			if (elapsed > 0) tracker.lastSpeed = (totalTokens / elapsed) * 1000;
		} else {
			// No usage at all — estimate entirely from chars of both phases.
			const totalChars = tracker.thinking.chars + tracker.answering.chars;
			if (tracker.startTime !== null && totalChars > 0) {
				const elapsed = Date.now() - tracker.startTime;
				if (elapsed > 0) {
					tracker.lastSpeed = ((totalChars / CHARS_PER_TOKEN) / elapsed) * 1000;
				}
			}
		}

		// Push finalized speed into history.
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
