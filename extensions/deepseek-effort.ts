// DeepSeek V4.1 effort controls: documented API presets and experimental scalar prompts.
// Model capability != hosted API contract: the report/encoder support 1..100,
// but api.deepseek.com rejects numeric reasoning_effort. Never send both controls.
// Sources and limitations: README.md#deepseek-effort

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type Mode = "api" | "prompt";
type Effort = number | null;
interface Selection {
	mode: Mode;
	effort: Effort;
	// The EFFECTIVE (possibly clamped) Pi level corresponding to this selection.
	level: ThinkingLevel;
}

const STATUS_KEY = "deepseek-effort";
const STATE_KEY = "deepseek-effort-state";
export const DEFAULT_EFFORT = 75;
export const EFFORT_PRESETS = { low: 50, high: 75, max: 100 } as const;
const LEVEL_EFFORT: Record<ThinkingLevel, Effort> = {
	off: null, minimal: 25, low: 50, medium: 60, high: 75, xhigh: 90, max: 100,
};
const USAGE = "/effort <1-100 | low | high | max | off> (numbers: experimental prompt; names: API presets)";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Known V4.1 IDs, including the current official alias. Do not guess future architectures. */
export function isDeepSeekV41(modelId?: string): boolean {
	return !!modelId && (/^deepseek-flash$/i.test(modelId) ||
		/^(?:deepseek-ai\/)?deepseek-v4\.1(?:$|[-:])/i.test(modelId));
}

function supportsEffort(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model || !model.reasoning || model.api !== "openai-completions" || !isDeepSeekV41(model.id)) return false;
	// A model name alone says nothing about a gateway's wire protocol.
	const compat = model.compat;
	if (compat && "thinkingFormat" in compat && compat.thinkingFormat !== undefined) return compat.thinkingFormat === "deepseek";
	if (model.provider === "deepseek") return true;
	try { return new URL(model.baseUrl).hostname === "api.deepseek.com"; }
	catch { return false; }
}

function modelKey(ctx: ExtensionContext): string {
	return `${ctx.model!.provider}/${ctx.model!.id}`;
}

function fromLevel(level: ThinkingLevel, mode: Mode): Selection {
	const effort = mode === "prompt" ? LEVEL_EFFORT[level]
		: level === "off" ? null : level === "max" ? 100
			: level === "minimal" || level === "low" ? 50 : DEFAULT_EFFORT;
	return { mode, effort, level };
}

function carrierLevel(effort: Effort): ThinkingLevel {
	if (effort === null) return "off";
	if (effort <= 25) return "minimal";
	if (effort <= 50) return "low";
	if (effort <= 65) return "medium";
	if (effort <= 85) return "high";
	return "max";
}

export function parseEffort(input: string): Pick<Selection, "mode" | "effort"> | undefined {
	const value = input.trim().toLowerCase();
	if (value === "off" || value === "0") return { mode: "api", effort: null };
	if (Object.hasOwn(EFFORT_PRESETS, value)) {
		return { mode: "api", effort: EFFORT_PRESETS[value as keyof typeof EFFORT_PRESETS] };
	}
	if (/^(?:[1-9]\d?|100)$/.test(value)) return { mode: "prompt", effort: Number(value) };
	return undefined;
}

/** Technical report §5.1.4 wording; encoding.py uses a different, equivalent-looking sentence. */
export function buildReasoningEffortPrefix(effort: number): string {
	if (!Number.isInteger(effort) || effort < 1 || effort > 100) throw new RangeError("Effort must be an integer in [1, 100]");
	return `Reasoning Effort: ${effort} (range 1-100; higher values request more thorough reasoning)\n\n`;
}

// Remove only complete, leading effort prefixes in the old report or current encoder format.
// Do not search/replace quoted instructions in user messages or the rest of the system prompt.
const PREFIX = /^(?:Reasoning Effort: \d{1,3} \(range 1[-–]100(?:; higher values request more thorough reasoning|, the higher the value, the more thorough the reasoning)\)(?:\r?\n){0,2})+/;
function rewriteText(text: string, effort: Effort): string {
	return (effort === null ? "" : buildReasoningEffortPrefix(effort)) + text.replace(PREFIX, "");
}

function rewriteMessages(messages: unknown[], effort: Effort): unknown[] {
	const first = messages[0];
	if (!record(first) || (first.role !== "system" && first.role !== "developer")) {
		return effort === null ? messages : [{ role: "system", content: buildReasoningEffortPrefix(effort) }, ...messages];
	}
	let content = first.content;
	if (typeof content === "string") {
		const rewritten = rewriteText(content, effort);
		// A prefix-only message was inserted for a user-first request. On leaving
		// prompt mode, remove it rather than sending an empty system instruction.
		if (effort === null && content !== rewritten && rewritten === "") return messages.slice(1);
		content = rewritten;
	}
	else if (Array.isArray(content)) {
		const parts = [...content];
		const part = parts[0];
		if (record(part) && part.type === "text" && typeof part.text === "string") {
			parts[0] = { ...part, text: rewriteText(part.text, effort) };
		} else if (effort !== null) parts.unshift({ type: "text", text: buildReasoningEffortPrefix(effort) });
		content = parts;
	} else if (content === null || content === undefined) content = rewriteText("", effort);
	else return messages; // Unknown content shape: do not destroy data.
	return [{ ...first, content }, ...messages.slice(1)];
}

export function rewriteEffortPayload(payload: unknown, selection: Pick<Selection, "mode" | "effort">): unknown {
	if (!record(payload) || !Array.isArray(payload.messages)) return payload;
	const { mode, effort } = selection;
	const next = {
		...payload,
		messages: rewriteMessages(payload.messages, mode === "prompt" ? effort : null),
		thinking: { ...(record(payload.thinking) ? payload.thinking : {}), type: effort === null ? "disabled" : "enabled" },
	};
	if (mode === "prompt" && effort !== null) {
		// Avoid sending Pi's quantized preset alongside the exact scalar. Omission
		// still means the hosted server's default (high), NOT absence of a server prefix.
		delete (next as Record<string, unknown>).reasoning_effort;
	} else {
		(next as Record<string, unknown>).reasoning_effort = effort === null ? "none" : effort === 50 ? "low" : effort === 100 ? "max" : "high";
	}
	return next;
}

function isSelection(value: unknown): value is Selection {
	return record(value) && (value.mode === "api" || value.mode === "prompt") &&
		typeof value.level === "string" && Object.hasOwn(LEVEL_EFFORT, value.level) &&
		(value.effort === null || (typeof value.effort === "number" && Number.isInteger(value.effort) && value.effort >= 1 && value.effort <= 100)) &&
		(value.mode === "prompt" || value.effort === null || Object.values(EFFORT_PRESETS).includes(value.effort as 50 | 75 | 100)) &&
		((value.effort === null) === (value.level === "off"));
}

export default function (pi: ExtensionAPI): void {
	// Instance-local, branch-persisted state. No globalThis sharing between SDK sessions.
	const selections = new Map<string, Selection>();
	let settingLevel = false;

	function setCarrier(requested: ThinkingLevel): ThinkingLevel {
		settingLevel = true;
		try { pi.setThinkingLevel(requested); }
		finally { settingLevel = false; }
		return pi.getThinkingLevel();
	}

	function hasNewerThinkingChange(ctx: ExtensionContext, key: string): boolean {
		// Pi records the level change synchronously BEFORE emitting its asynchronous
		// notification. Our command records the exact selection AFTER setThinkingLevel.
		// Branch order therefore distinguishes newer UI changes from delayed echoes,
		// even when a user cycles back to the same level or commands arrive rapidly.
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "thinking_level_change") return true;
			if (entry.type === "custom" && entry.customType === STATE_KEY && record(entry.data) &&
				entry.data.version === 1 && entry.data.modelKey === key && isSelection(entry.data)) return false;
		}
		return true;
	}

	function save(key: string, selection: Selection): void {
		pi.appendEntry(STATE_KEY, { version: 1, modelKey: key, ...selection });
	}

	function synchronize(ctx: ExtensionContext): Selection | undefined {
		if (!supportsEffort(ctx)) return undefined;
		const key = modelKey(ctx);
		const previous = selections.get(key);
		const level = pi.getThinkingLevel();
		if (previous?.level === level) return previous;
		const current = fromLevel(level, previous?.mode ?? "api");
		selections.set(key, current);
		if (previous) save(key, current);
		return current;
	}

	function updateStatus(ctx: ExtensionContext): void {
		const selection = synchronize(ctx);
		if (!ctx.hasUI) return;
		if (!selection) { ctx.ui.setStatus(STATUS_KEY, undefined); return; }
		const { effort, mode } = selection;
		const color = effort === null ? "dim" : mode === "prompt" ? "warning" : "accent";
		const label = effort === null ? "Effort: off" : `Effort: ${effort} [${mode === "api" ? "API" : "prompt?"}]`;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, label));
	}

	function restore(ctx: ExtensionContext, restoreCarrier: boolean): void {
		selections.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_KEY || !record(entry.data)) continue;
			const data = entry.data;
			if (data.version === 1 && typeof data.modelKey === "string" && isSelection(data)) {
				selections.set(data.modelKey, { mode: data.mode, effort: data.effort, level: data.level });
			}
		}
		// Pi's /tree restores messages, NOT the live thinking level. Restore our
		// carrier explicitly there; session_start still honors CLI/session overrides.
		if (restoreCarrier && supportsEffort(ctx)) {
			const key = modelKey(ctx);
			const saved = selections.get(key);
			if (saved) {
				const previousLevel = pi.getThinkingLevel();
				const level = setCarrier(saved.level);
				const restored = (level === "off") === (saved.effort === null)
					? { ...saved, level } : fromLevel(level, saved.mode);
				selections.set(key, restored);
				if (level !== previousLevel || level !== saved.level) save(key, restored);
			}
		}
		updateStatus(ctx);
	}

	pi.on("session_start", (_event, ctx) => restore(ctx, false));
	pi.on("session_tree", (_event, ctx) => restore(ctx, true));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));
	pi.on("thinking_level_select", (event, ctx) => {
		if (settingLevel || !supportsEffort(ctx) || event.level !== pi.getThinkingLevel()) return;
		const key = modelKey(ctx);
		if (!hasNewerThinkingChange(ctx, key)) return;
		const previous = selections.get(key);
		// A genuine user change wins even if rapid cycling returns to the same
		// carrier (low -> max -> low). Only our own echoes preserve an exact scalar.
		const current = fromLevel(event.level, previous?.mode ?? "api");
		selections.set(key, current);
		if (previous) save(key, current);
		updateStatus(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// One injection site at serialization time: no stale per-turn prefix on tool
	// follow-ups, no before_agent_start prefix leaking when the model changes.
	pi.on("before_provider_request", (event, ctx) => {
		if (!supportsEffort(ctx)) return;
		if (record(event.payload) && typeof event.payload.model === "string" && event.payload.model !== ctx.model?.id) return;
		const selection = synchronize(ctx);
		if (!selection) return;
		updateStatus(ctx);
		return rewriteEffortPayload(event.payload, selection);
	});

	pi.registerCommand("effort", {
		description: "DeepSeek V4.1: 1–100 via experimental system prefix; low/high/max/off via API",
		getArgumentCompletions: (prefix) => {
			const items = ["off", "low", "high", "max", "1", "25", "50", "75", "100"]
				.filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			if (!supportsEffort(ctx)) {
				ctx.ui.notify("/effort requires a DeepSeek V4.1 reasoning model (including deepseek-flash) using DeepSeek Chat Completions format.", "warning");
				return;
			}
			const input = args.trim();
			if (!input) {
				const current = synchronize(ctx)!;
				ctx.ui.notify(`Effort: ${current.effort ?? "off"}; mode: ${current.mode}. ${USAGE}`, "info");
				return;
			}
			const target = parseEffort(input);
			if (!target) { ctx.ui.notify(`Invalid effort. ${USAGE}`, "error"); return; }
			const level = setCarrier(carrierLevel(target.effort));
			if ((level === "off") !== (target.effort === null)) {
				updateStatus(ctx);
				ctx.ui.notify("The model's thinkingLevelMap does not support the requested on/off state.", "error");
				return;
			}
			const current = { ...target, level };
			selections.set(modelKey(ctx), current);
			save(modelKey(ctx), current);
			updateStatus(ctx);
			ctx.ui.notify(target.mode === "prompt"
				? `Effort: ${target.effort} via experimental system prefix. API reasoning_effort is omitted; the server still defaults to high. Exact hosted scalar control is not guaranteed.`
				: `Effort: ${target.effort ?? "off"} via the documented API preset.`, target.mode === "prompt" ? "warning" : "info");
		},
	});
}
