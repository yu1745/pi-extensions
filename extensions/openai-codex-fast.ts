// openai-codex-fast.ts — OpenAI Codex Fast & Ultrafast mode controls for pi.
//
// /fast toggles service_tier=priority on openai-codex Responses API requests.
// /ultrafast toggles service_tier=ultrafast (currently supported on models like gpt-5.6-sol).
// Mode is process-shared (including in-process subagents), reset after pi restarts.
// Request snapshots are durable non-context entries; they do not restore the mode.

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TARGET_PROVIDER = "openai-codex";
const STATUS_KEY = "openai-codex-fast";
const FAST_SERVICE_TIER = "priority";
const ULTRAFAST_SERVICE_TIER = "ultrafast";
const DEFAULT_SERVICE_TIER = "default";

type ServiceTierMode = "standard" | "fast" | "ultrafast";

// Shared state lives on globalThis so that in-process subagent sessions
// (pi-subagents' createAgentSession, which re-imports this module with jiti
// moduleCache:false) see the same speed mode as the main session.
interface CodexFastState {
	serviceTier: ServiceTierMode;
}

const GLOBAL_KEY = "__piCodexFastState";

function getState(): CodexFastState {
	const g = globalThis as Record<string, unknown>;
	return (g[GLOBAL_KEY] as CodexFastState) ?? (g[GLOBAL_KEY] = {
		serviceTier: "standard",
	});
}

const state = getState();

function renderStatus(ctx: ExtensionContext): void {
	if (ctx.model?.provider !== TARGET_PROVIDER) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	let label = "standard";
	let color: "warning" | "dim" = "dim";
	if (state.serviceTier === "ultrafast") {
		label = "ULTRAFAST";
		color = "warning";
	} else if (state.serviceTier === "fast") {
		label = "FAST";
		color = "warning";
	}
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, `Codex ${label}`));
}

function setServiceTier(ctx: ExtensionContext, tier: ServiceTierMode): void {
	state.serviceTier = tier;
	renderStatus(ctx);
}

export default function (pi: ExtensionAPI): void {
	// Rewrite the provider payload immediately before sending. This is the same
	// request field used by Codex's native /fast and /ultrafast commands.
	pi.on("message_start", async (_event, ctx) => {
		renderStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== TARGET_PROVIDER) return;
		renderStatus(ctx);
		if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;

		// Snapshot now, never at message_end: the shared mode may change in flight.
		const mode = state.serviceTier;
		const payload = event.payload as Record<string, unknown>;
		const nextPayload = mode === "standard" ? payload : {
			...payload,
			service_tier: mode === "ultrafast" ? ULTRAFAST_SERVICE_TIER : FAST_SERVICE_TIER,
		};
		// No request/message correlation token is exposed by this event. A local
		// id identifies this hook invocation only, not a server request or retry.
		pi.appendEntry("openai-codex-fast-request", {
			version: 1,
			kind: "requested_service_tier",
			request_id: randomUUID(),
			session_id: ctx.sessionManager.getSessionId(),
			parent_entry_id: ctx.sessionManager.getLeafId(),
			provider: TARGET_PROVIDER,
			model: typeof payload.model === "string" ? payload.model : ctx.model.id,
			mode,
			service_tier: nextPayload.service_tier === undefined ? DEFAULT_SERVICE_TIER
				: [DEFAULT_SERVICE_TIER, FAST_SERVICE_TIER, ULTRAFAST_SERVICE_TIER].includes(nextPayload.service_tier as string)
					? nextPayload.service_tier : "unknown",
			service_tier_explicit: nextPayload.service_tier !== undefined,
		});
		if (mode !== "standard") return nextPayload;
	});

	pi.on("session_start", async (_event, ctx) => {
		renderStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		renderStatus(ctx);
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex Fast mode (service_tier=priority)",
		handler: async (_args, ctx) => {
			if (ctx.model?.provider !== TARGET_PROVIDER) {
				ctx.ui.notify("/fast is only available for the openai-codex provider", "warning");
				return;
			}
			const nextTier: ServiceTierMode = state.serviceTier === "fast" ? "standard" : "fast";
			setServiceTier(ctx, nextTier);
			ctx.ui.notify(
				nextTier === "fast"
					? "Codex Fast mode enabled (service_tier=priority)"
					: `Codex Fast mode disabled (service_tier=${DEFAULT_SERVICE_TIER})`,
				"info",
			);
		},
	});

	pi.registerCommand("ultrafast", {
		description: "Toggle OpenAI Codex Ultrafast mode (service_tier=ultrafast)",
		handler: async (_args, ctx) => {
			if (ctx.model?.provider !== TARGET_PROVIDER) {
				ctx.ui.notify("/ultrafast is only available for the openai-codex provider", "warning");
				return;
			}
			const nextTier: ServiceTierMode = state.serviceTier === "ultrafast" ? "standard" : "ultrafast";
			setServiceTier(ctx, nextTier);
			ctx.ui.notify(
				nextTier === "ultrafast"
					? "Codex Ultrafast mode enabled (service_tier=ultrafast)"
					: `Codex Ultrafast mode disabled (service_tier=${DEFAULT_SERVICE_TIER})`,
				"info",
			);
		},
	});
}

