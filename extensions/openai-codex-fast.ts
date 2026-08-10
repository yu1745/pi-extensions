// openai-codex-fast.ts — OpenAI Codex Fast + GPT-5.6 context controls for pi.
//
// /fast toggles service_tier=priority on openai-codex Responses API requests.
// /context-window restores the model default with no argument, or sets a
// requested context window (clamped to the GPT-5.6 API ceiling) with an argument.
//
// Both controls are session-local and are disabled after pi restarts.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TARGET_PROVIDER = "openai-codex";
const STATUS_KEY = "openai-codex-fast";
const FAST_SERVICE_TIER = "priority";
const DEFAULT_SERVICE_TIER = "default";
// GPT-5.6 API context ceiling reported by current model specifications.
// User values are accepted below this ceiling and clamped above it.
const MAX_CONTEXT_WINDOW = 950_000;
const GPT56_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);

let fastModeEnabled = false;
let contextWindowEnabled = false;
let contextWindowValue = MAX_CONTEXT_WINDOW;
let applyingContextWindow = false;
const originalContextWindows = new Map<string, number>();

function isGpt56(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === TARGET_PROVIDER && GPT56_MODELS.has(ctx.model.id.toLowerCase());
}

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
	return Math.min(Math.floor(amount * multiplier), MAX_CONTEXT_WINDOW);
}

function renderStatus(ctx: ExtensionContext): void {
	if (ctx.model?.provider !== TARGET_PROVIDER) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const parts: string[] = [fastModeEnabled ? "FAST" : "standard"];
	if (isGpt56(ctx) && contextWindowEnabled) parts.push(`ctx ${formatTokens(contextWindowValue)}`);
	const color: "warning" | "dim" = fastModeEnabled || contextWindowEnabled ? "warning" : "dim";
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, `Codex ${parts.join(" | ")}`));
}

function setFastMode(ctx: ExtensionContext, enabled: boolean): void {
	fastModeEnabled = enabled;
	renderStatus(ctx);
}

async function setContextWindow(ctx: ExtensionContext, enabled: boolean, pi: ExtensionAPI, requestedValue = contextWindowValue): Promise<void> {
	if (!ctx.model || !isGpt56(ctx) || applyingContextWindow) return;
	const model = ctx.model;
	if (!originalContextWindows.has(model.id)) originalContextWindows.set(model.id, model.contextWindow);
	contextWindowValue = Math.min(Math.max(1, Math.floor(requestedValue)), MAX_CONTEXT_WINDOW);
	const contextWindow = enabled
		? contextWindowValue
		: (originalContextWindows.get(model.id) ?? model.contextWindow);
	if (model.contextWindow !== contextWindow) {
		applyingContextWindow = true;
		try {
			await pi.setModel({ ...model, contextWindow });
		} finally {
			applyingContextWindow = false;
		}
	}
	contextWindowEnabled = enabled;
	renderStatus(ctx);
}

export default function (pi: ExtensionAPI): void {
	// Rewrite the provider payload immediately before sending. This is the same
	// request field used by Codex's native /fast command.
	pi.on("before_provider_request", (event, ctx) => {
		if (!fastModeEnabled || ctx.model?.provider !== TARGET_PROVIDER) return;
		if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
		return {
			...(event.payload as Record<string, unknown>),
			service_tier: FAST_SERVICE_TIER,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		fastModeEnabled = false;
		contextWindowEnabled = false;
		contextWindowValue = MAX_CONTEXT_WINDOW;
		originalContextWindows.clear();
		renderStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (ctx.model?.provider !== TARGET_PROVIDER) {
			contextWindowEnabled = false;
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (!isGpt56(ctx)) contextWindowEnabled = false;
		if (contextWindowEnabled && !applyingContextWindow) {
			await setContextWindow(ctx, true, pi);
			return;
		}
		renderStatus(ctx);
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex Fast mode (service_tier=priority)",
		handler: async (_args, ctx) => {
			if (ctx.model?.provider !== TARGET_PROVIDER) {
				ctx.ui.notify("/fast is only available for the openai-codex provider", "warning");
				return;
			}
			setFastMode(ctx, !fastModeEnabled);
			ctx.ui.notify(
				fastModeEnabled
					? "Codex Fast mode enabled (service_tier=priority)"
					: `Codex Fast mode disabled (service_tier=${DEFAULT_SERVICE_TIER})`,
				"info",
			);
		},
	});

	pi.registerCommand("context-window", {
		description: "Set/clamp context window for OpenAI Codex GPT-5.6 models",
		handler: async (args, ctx) => {
			if (ctx.model?.provider !== TARGET_PROVIDER || !isGpt56(ctx)) {
				ctx.ui.notify("/context-window only works with openai-codex GPT-5.6 models", "warning");
				return;
			}
			const raw = args.trim();
			if (!raw) {
				await setContextWindow(ctx, false, pi);
				ctx.ui.notify("Codex context window restored to model default", "info");
				return;
			}
			const requested = parseContextWindow(raw);
			if (requested === null) {
				ctx.ui.notify("Usage: /context-window [tokens|Nk|Nm]", "warning");
				return;
			}
			const rawNumber = raw.toLowerCase();
			const requestedRaw = rawNumber.endsWith("m")
				? Number.parseFloat(rawNumber) * 1_000_000
				: rawNumber.endsWith("k")
					? Number.parseFloat(rawNumber) * 1_000
					: Number(rawNumber);
			const clamped = Number.isFinite(requestedRaw) && requestedRaw > MAX_CONTEXT_WINDOW;
			await setContextWindow(ctx, true, pi, requested);
			ctx.ui.notify(
				`Codex context window ${formatTokens(requested)}${clamped ? ` (clamped from ${formatTokens(requestedRaw)})` : ""}`,
				"info",
			);
		},
	});
}
