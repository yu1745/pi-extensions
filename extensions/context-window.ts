// context-window.ts — Dynamic context window controls for pi models.
//
// /context-window restores the model default with no argument, or sets a
// requested context window with an argument (e.g. /context-window 128k, 1m, 64000).
//
// State is session-local and is reset when pi restarts.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "context-window-override";

interface ContextWindowState {
	enabled: boolean;
	value: number;
}

const GLOBAL_KEY = "__piContextOverrideState";

function getState(): ContextWindowState {
	const g = globalThis as Record<string, unknown>;
	return (g[GLOBAL_KEY] as ContextWindowState) ?? (g[GLOBAL_KEY] = {
		enabled: false,
		value: 0,
	});
}

// Per-model original context windows: keyed by `${provider}/${id}`
const originalContextWindows = new Map<string, number>();

const state = getState();
let applyingContextWindow = false;

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`;
	}
	return `${Math.round(tokens / 1000)}K`;
}

function parseContextWindow(args: string): number | null {
	const value = args.trim().toLowerCase();
	const match = value.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
	if (!match) return null;
	const amount = Number(match[1]);
	const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
	if (!Number.isFinite(amount) || amount <= 0) return null;
	return Math.floor(amount * multiplier);
}

function renderStatus(ctx: ExtensionContext): void {
	if (!state.enabled) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", `ctx ${formatTokens(state.value)}`));
}

async function setContextWindow(ctx: ExtensionContext, enabled: boolean, pi: ExtensionAPI, requestedValue = state.value): Promise<void> {
	if (!ctx.model || applyingContextWindow) return;
	const model = ctx.model;
	const modelKey = `${model.provider}/${model.id}`;
	if (!originalContextWindows.has(modelKey)) {
		originalContextWindows.set(modelKey, model.contextWindow);
	}
	state.value = Math.max(1, Math.floor(requestedValue));
	const contextWindow = enabled
		? state.value
		: (originalContextWindows.get(modelKey) ?? model.contextWindow);

	if (model.contextWindow !== contextWindow) {
		applyingContextWindow = true;
		try {
			await pi.setModel({ ...model, contextWindow });
		} finally {
			applyingContextWindow = false;
		}
	}
	state.enabled = enabled;
	renderStatus(ctx);
}

export default function (pi: ExtensionAPI): void {
	pi.on("message_start", async (_event, ctx) => {
		renderStatus(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		originalContextWindows.clear();
		renderStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (state.enabled && !applyingContextWindow) {
			await setContextWindow(ctx, true, pi);
			return;
		}
		renderStatus(ctx);
	});

	pi.registerCommand("context-window", {
		description: "Set/override context window for current model (/context-window [tokens|Nk|Nm] or empty to reset)",
		handler: async (args, ctx) => {
			if (!ctx.model) {
				ctx.ui.notify("No active model", "warning");
				return;
			}
			const raw = args.trim();
			if (!raw) {
				await setContextWindow(ctx, false, pi);
				ctx.ui.notify(`Context window restored to model default (${formatTokens(ctx.model.contextWindow)})`, "info");
				return;
			}
			const requested = parseContextWindow(raw);
			if (requested === null) {
				ctx.ui.notify("Usage: /context-window [tokens|Nk|Nm]", "warning");
				return;
			}
			await setContextWindow(ctx, true, pi, requested);
			ctx.ui.notify(
				`Context window set to ${formatTokens(requested)} for ${ctx.model.id}`,
				"info",
			);
		},
	});
}
