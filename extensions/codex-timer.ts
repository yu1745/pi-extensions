/**
 * Codex-style timers for pi.
 *
 * 1. While the model is thinking (before a text block streams out), the footer
 *    status shows a live "Thinking Ns" counter; when the first text arrives it
 *    settles to "Thought Ns" until the turn moves on.
 * 2. Between two user inputs, when the agent finishes working, a dim separator
 *    "─ Worked for Xm YYs ─" is appended to the transcript (not sent to LLM).
 *
 * Ported from openai/codex TUI (status_indicator_widget timer + FinalMessageSeparator).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const STATUS_KEY = "codex-timer";

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
	const startThinking = (ctx: { ui: { setStatus: (k: string, v: string) => void }; hasUI: boolean }) => {
		thinkStart = Date.now();
		awaitingText = true;
		if (!ctx.hasUI) return;
		stopTick();
		ctx.ui.setStatus(STATUS_KEY, "Thinking 0s");
		tick = setInterval(() => {
			ctx.ui.setStatus(STATUS_KEY, `Thinking ${fmt((Date.now() - thinkStart) / 1000)}`);
		}, 1000);
	};

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
			awaitingText = false;
			stopTick();
			if (ctx.hasUI) {
				ctx.ui.setStatus(STATUS_KEY, `Thought ${fmt((Date.now() - thinkStart) / 1000)}`);
			}
		}
	});

	// Assistant message finished without producing text (tool calls only): drop the timer.
	pi.on("message_end", async (_event, ctx) => {
		if (awaitingText) {
			awaitingText = false;
			stopTick();
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "");
		}
	});

	// --- Feature 2: on settle, append separator ---
	pi.on("agent_settled", async (_event, ctx) => {
		stopTick();
		awaitingText = false;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "");
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
