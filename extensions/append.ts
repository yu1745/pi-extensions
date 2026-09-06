// append.ts — Defers user messages until agent stops/settles.
//
// /append <message> queues text to be injected when the agent run finishes
// (at the "agent_end" hook, when the model has stopped executing tools),
// instead of interrupting the current turn after the next tool result.
//
// Usage:
//   /append <message>         - Queues a message to be injected when the agent finishes
//   /append                   - Shows current queue or clears it if asked

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "append-queue";

interface AppendState {
	queue: string[];
}

const GLOBAL_KEY = "__piAppendState";

function getState(): AppendState {
	const g = globalThis as Record<string, unknown>;
	return (g[GLOBAL_KEY] as AppendState) ?? (g[GLOBAL_KEY] = {
		queue: [],
	});
}

const state = getState();

function renderStatus(ctx: ExtensionContext): void {
	if (state.queue.length === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(
		STATUS_KEY,
		ctx.ui.theme.fg("warning", `append: ${state.queue.length} pending`),
	);
}

export default function (pi: ExtensionAPI): void {
	// Hook: agent_end fires when the low-level agent run finishes all tool executions for this run.
	// We drain the queue and send each queued message as a follow-up.
	pi.on("agent_end", async (_event, ctx) => {
		if (state.queue.length === 0) return;

		const messagesToSend = [...state.queue];
		state.queue = [];
		renderStatus(ctx);

		for (const msg of messagesToSend) {
			// In agent_end, deliverAs: "followUp" enqueues the message to be picked up
			// immediately by the post-run continuation, starting the next turn cleanly.
			pi.sendUserMessage(msg, { deliverAs: "followUp" });
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		state.queue = [];
		renderStatus(ctx);
	});

	pi.on("message_start", async (_event, ctx) => {
		renderStatus(ctx);
	});

	pi.registerCommand("append", {
		description: "Queue a message to be appended only after the agent stops/finishes its current run",
		handler: async (args, ctx) => {
			const text = args.trim();

			if (!text) {
				if (state.queue.length === 0) {
					ctx.ui.notify("Append queue is currently empty.", "info");
					return;
				}
				ctx.ui.notify(
					`Append queue has ${state.queue.length} message(s):\n` +
					state.queue.map((m, i) => `${i + 1}. ${m}`).join("\n"),
					"info",
				);
				return;
			}

			if (text === "--clear") {
				const count = state.queue.length;
				state.queue = [];
				renderStatus(ctx);
				ctx.ui.notify(`Cleared ${count} pending append message(s).`, "info");
				return;
			}

			// If the agent is currently idle, we can either send directly or queue.
			// Sending directly if idle matches user intent to append next.
			if (ctx.isIdle()) {
				pi.sendUserMessage(text);
				ctx.ui.notify("Agent was idle, message sent immediately.", "info");
				return;
			}

			state.queue.push(text);
			renderStatus(ctx);
			ctx.ui.notify(
				`Message queued (${state.queue.length} pending). Will be sent when the agent finishes running tools.`,
				"info",
			);
		},
	});
}
