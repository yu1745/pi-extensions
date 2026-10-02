/**
 * Codex-style timers for pi.
 *
 * 1. While the model is thinking (before a text block streams out), the footer
 *    status shows a live "Thinking Ns" counter; when the first text arrives it
 *    settles to "Thought Ns" and stays visible until the next response.
 * 2. Between two user inputs, when the agent finishes working, a dim separator
 *    "─ Worked for Xm YYs ─" is appended to the transcript (not sent to LLM).
 *
 * Ported from openai/codex TUI (status_indicator_widget timer + FinalMessageSeparator).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// Footer statuses sort by key; keep the timer before quota and speed text.
export const CODEX_TIMER_STATUS_KEY = "00-codex-timer";
export const CODEX_TIMER_STATUS_WIDTH = 20;

function fmt(secs: number): string {
	const s = Math.floor(secs);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(s / 3600);
	return `${h}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m ${String(s % 60).padStart(2, "0")}s`;
}

interface WorkedForData {
	label: string;
}

export default function (pi: ExtensionAPI) {
	let turnStart = 0; // agent run start (feature 2)
	let thinkStart = 0; // current assistant message start (feature 1)
	let awaitingText = false;
	let tick: ReturnType<typeof setInterval> | null = null;

	const stopTick = () => {
		if (tick) clearInterval(tick);
		tick = null;
	};

	// --- Feature 2: transcript separator "Worked for ..." ---
	pi.registerEntryRenderer<WorkedForData>("worked-for", (entry, _opts, theme) =>
		new Text(theme.fg("dim", entry.data?.label ?? ""), 0, 0),
	);

	// --- Feature 1: live thinking timer in footer status ---
	type TimerContext = { ui: { setStatus: (k: string, v?: string) => void }; hasUI: boolean };
	const setTimerStatus = (ctx: TimerContext, text: string) => {
		if (ctx.hasUI) ctx.ui.setStatus(CODEX_TIMER_STATUS_KEY, text.slice(0, CODEX_TIMER_STATUS_WIDTH).padEnd(CODEX_TIMER_STATUS_WIDTH));
	};
	const finishThinking = (ctx: TimerContext) => {
		if (!awaitingText) return;
		awaitingText = false;
		stopTick();
		setTimerStatus(ctx, `Thought ${fmt((Date.now() - thinkStart) / 1000)}`);
	};
	const startThinking = (ctx: TimerContext) => {
		thinkStart = Date.now();
		awaitingText = true;
		if (!ctx.hasUI) return;
		stopTick();
		setTimerStatus(ctx, "Thinking 0s");
		tick = setInterval(() => {
			setTimerStatus(ctx, `Thinking ${fmt((Date.now() - thinkStart) / 1000)}`);
		}, 1000);
	};

	pi.on("session_start", (_event, ctx) => {
		stopTick();
		turnStart = 0;
		thinkStart = 0;
		awaitingText = false;
		setTimerStatus(ctx, "Ready");
	});

	pi.on("agent_start", async () => {
		turnStart = Date.now();
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role === "assistant") startThinking(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		if (!awaitingText) return;
		const t = event.assistantMessageEvent?.type;
		if (t === "text_start" || t === "text_delta") {
			finishThinking(ctx);
		}
	});

	// Tool-only responses also retain their final thinking duration.
	pi.on("message_end", async (_event, ctx) => {
		finishThinking(ctx);
	});

	// --- Feature 2: on settle, append separator ---
	pi.on("agent_settled", async (_event, ctx) => {
		finishThinking(ctx);
		stopTick();
		const secs = (Date.now() - turnStart) / 1000;
		if (turnStart > 0 && secs >= 1) {
			pi.appendEntry<WorkedForData>("worked-for", {
				label: `─ Worked for ${fmt(secs)} ─`,
			});
		}
		turnStart = 0;
	});

	pi.on("session_shutdown", () => stopTick());
}
