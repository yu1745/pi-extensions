import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	NEXT_AGENT_SHORTCUT,
	PANEL_TOGGLE_SHORTCUT,
	PREV_AGENT_SHORTCUT,
	STATUS_BAR_KEY,
} from "./constants.js";
import { formatToolCall, formatUsage, getFinalOutput } from "./messages.js";
import {
	cancelSubagent,
	getSubagentRuns,
	onSubagentStateChange,
} from "./subagent.js";
import type { SubagentRunState } from "./types.js";

// ---------------------------------------------------------------------------
// Fullscreen subagent view (Codex-style): Alt+Left/Alt+Right switches the
// whole screen to the next/previous subagent's thread, showing its live
// message stream. Ctrl+Shift+S toggles the view; Esc closes it.
// ---------------------------------------------------------------------------

let view: SubagentView | null = null;
let closeView: (() => void) | null = null;
let selectedTaskId: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

const MAX_THREAD_LINES = 34;

function elapsed(state: SubagentRunState): string {
	const end = state.completedAt ?? Date.now();
	const seconds = Math.max(0, Math.round((end - state.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${seconds % 60}s`;
}

function truncate(text: string, width: number): string {
	// Visible-width aware: CJK chars are 2 columns wide, so text.length is not
	// a safe measure. truncateToWidth keeps ANSI codes intact and adds "…".
	return truncateToWidth(text, Math.max(1, width), "…");
}

function firstLine(text: string): string {
	const trimmed = text.trim();
	const line = trimmed.split("\n")[0] ?? "";
	return truncateToWidth(line, 120, "…");
}

function formatToolResult(msg: any): string {
	const parts: string[] = [];
	for (const part of msg.content ?? []) {
		if (part?.type === "text" && typeof part.text === "string") {
			const line = firstLine(part.text);
			if (line) parts.push(line);
		}
	}
	const preview = parts.join(" | ");
	return preview ? `→ ${msg.toolName}: ${preview}` : `→ ${msg.toolName}`;
}

function renderThread(
	state: SubagentRunState,
	width: number,
	theme: Theme,
	maxLines: number,
): string[] {
	const lines: string[] = [];
	const markdownTheme = getMarkdownTheme();
	for (const msg of state.messages) {
		if (msg.role === "assistant") {
			const textParts = msg.content.filter(
				(part): part is Extract<typeof part, { type: "text" }> =>
					part.type === "text" && !!part.text?.trim(),
			);
			if (textParts.length > 0) {
				const md = new Markdown(
					textParts.map((part) => part.text).join("\n\n"),
					0,
					0,
					markdownTheme,
				);
				lines.push(...md.render(width));
			}
			for (const part of msg.content) {
				if (part.type === "toolCall") {
					lines.push(
						truncate(
							theme.fg(
								"toolTitle",
								`⚙ ${formatToolCall(part.name, part.arguments)}`,
							),
							width,
						),
					);
				}
			}
		} else if (msg.role === "user") {
			const text =
				typeof msg.content === "string"
					? msg.content
					: (msg.content
							.map((p: any) => (p?.type === "text" ? p.text : ""))
							.filter(Boolean)
							.join(" ") as string);
			if (text.trim()) {
				lines.push(truncate(theme.fg("muted", `▍ ${firstLine(text)}`), width));
			}
		} else if (msg.role === "toolResult") {
			lines.push(
				truncate(
					theme.fg(msg.isError ? "error" : "dim", formatToolResult(msg)),
					width,
				),
			);
		}
	}
	return lines.slice(-maxLines);
}

function pickerLine(
	runs: SubagentRunState[],
	selectedId: string | null,
	width: number,
	theme: Theme,
): string {
	const parts: string[] = [];
	runs.forEach((run, index) => {
		const selected = run.taskId === selectedId;
		const icon =
			run.status === "running"
				? theme.fg("warning", "●")
				: run.status === "completed"
					? theme.fg("success", "✓")
					: theme.fg("error", "✗");
		const label = `${index + 1}:${run.taskId} [${run.mode}] ${icon}`;
		// 选中项整体负片（反显），替代原先的小三角标记
		parts.push(selected ? theme.inverse(` ${label} `) : label);
	});
	const line = parts.join(theme.fg("dim", " │ "));
	return truncate(line, width);
}

class SubagentView implements Component {
	private theme: Theme;

	constructor(theme: Theme) {
		this.theme = theme;
	}

	invalidate(): void {
		// TUI re-renders after invalidation; nothing cached here.
	}

	cycle(direction: 1 | -1): void {
		const runs = getSubagentRuns();
		if (runs.length === 0) return;
		const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt);
		const index = sorted.findIndex((r) => r.taskId === selectedTaskId);
		const next = sorted[(index + direction + sorted.length) % sorted.length];
		selectedTaskId = next.taskId;
	}

	handleInput(data: string): void {
		if (matchesKey(data, PREV_AGENT_SHORTCUT)) {
			this.cycle(-1);
			return;
		}
		if (matchesKey(data, NEXT_AGENT_SHORTCUT)) {
			this.cycle(1);
			return;
		}
		if (matchesKey(data, "escape")) {
			// Esc stops the selected subagent, then closes the view.
			const selected = selectedTaskId;
			if (selected) void cancelSubagent(selected);
			closeView?.();
			return;
		}
		if (matchesKey(data, "q") || matchesKey(data, PANEL_TOGGLE_SHORTCUT)) {
			// q / ctrl+shift+s just close the view; the subagent keeps running.
			closeView?.();
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		const runs = getSubagentRuns();
		const running = runs.filter((r) => r.status === "running").length;
		const innerWidth = Math.max(20, width - 4);

		const lines: string[] = [];
		// 顶部全宽反显标题条：view 替换的是底部编辑器容器，这一条正好卡在
		// 与上方 pi 主屏幕的交界处，形成明显横向分界
		const runningText = running > 0 ? `● ${running} running` : "idle";
		lines.push(theme.inverse(` Subagents  ${runningText} `.padEnd(width)));
		lines.push(
			theme.fg(
				"dim",
				`${PREV_AGENT_SHORTCUT}/${NEXT_AGENT_SHORTCUT} switch · esc/q close · updates live`,
			),
		);
		lines.push(theme.fg("borderAccent", "═".repeat(innerWidth)));

		if (runs.length === 0) {
			lines.push(
				theme.fg(
					"dim",
					"No subagents yet — ask the agent to use spawn_subagent.",
				),
			);
			return lines;
		}

		const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt);
		if (!selectedTaskId || !runs.some((r) => r.taskId === selectedTaskId)) {
			selectedTaskId = sorted[0].taskId;
		}

		lines.push(pickerLine(sorted, selectedTaskId, innerWidth, theme));
		lines.push(theme.fg("dim", "─".repeat(innerWidth)));

		const selected = runs.find((r) => r.taskId === selectedTaskId);
		if (selected) {
			const header = `${selected.taskId} [${selected.mode}] · ${selected.cwd} · ${elapsed(selected)} · ${formatUsage(selected.usage)}`;
			lines.push(truncate(theme.fg("muted", header), innerWidth));
			lines.push(
				truncate(
					theme.fg(
						"dim",
						`model ${selected.model} · task: ${firstLine(selected.task)}`,
					),
					innerWidth,
				),
			);
			lines.push(theme.fg("dim", "─".repeat(innerWidth)));

			const thread = renderThread(
				selected,
				innerWidth,
				theme,
				MAX_THREAD_LINES,
			);
			if (thread.length === 0) {
				lines.push(
					theme.fg("dim", "(no activity yet — waiting for first message)"),
				);
			} else {
				lines.push(...thread);
			}

			const output = getFinalOutput(selected.messages).trim();
			if (output && selected.status !== "running") {
				lines.push(theme.fg("dim", "─".repeat(innerWidth)));
				lines.push(theme.fg("muted", "final output:"));
				lines.push(
					...output
						.split("\n")
						.slice(0, 8)
						.map((l) => truncate(l, innerWidth)),
				);
			}
		}
		return lines;
	}
}

function scheduleRefresh(): void {
	if (!view) return;
	if (refreshTimer) return;
	refreshTimer = setTimeout(() => {
		refreshTimer = undefined;
		view?.invalidate();
	}, 150);
}

function updateStatusBar(ctx: ExtensionContext): void {
	const running = getSubagentRuns().filter(
		(r) => r.status === "running",
	).length;
	if (running === 0) {
		ctx.ui.setStatus(STATUS_BAR_KEY, undefined);
	} else {
		ctx.ui.setStatus(
			STATUS_BAR_KEY,
			`${ctx.ui.theme.fg("warning", `● ${running} subagent${running > 1 ? "s" : ""}`)}`,
		);
	}
}

function openView(ctx: ExtensionContext): void {
	if (view) return;
	void ctx.ui
		.custom<null>(
			(_tui, theme, _keybindings, done) => {
				const component = new SubagentView(theme);
				view = component;
				closeView = () => done(null);
				return component;
			},
			// No `overlay: true` — the custom view replaces the bottom editor
			// container (not the whole screen), so the inverted title bar doubles
			// as the horizontal boundary against the chat area above.
		)
		.then(() => {
			view = null;
			closeView = null;
		});
}

function toggleView(ctx: ExtensionContext): void {
	if (view) {
		closeView?.();
		return;
	}
	openView(ctx);
}

function switchToView(ctx: ExtensionContext, direction: 1 | -1): void {
	const runs = getSubagentRuns();
	if (view) {
		view.cycle(direction);
		return;
	}
	if (runs.length === 0) {
		openView(ctx);
		ctx.ui.notify("No subagents running — nothing to switch to");
		return;
	}
	openView(ctx);
	const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt);
	const index = sorted.findIndex((r) => r.taskId === selectedTaskId);
	selectedTaskId =
		sorted[(index + direction + sorted.length) % sorted.length].taskId;
}

/** Wire up the fullscreen subagent view, Codex-style shortcuts, and the status bar. */
export function registerSubagentPanel(pi: ExtensionAPI): void {
	onSubagentStateChange(() => {
		scheduleRefresh();
		if (lastCtx) updateStatusBar(lastCtx);
	});

	pi.registerShortcut(PANEL_TOGGLE_SHORTCUT, {
		description: "Toggle the fullscreen subagents view",
		handler: (ctx) => {
			toggleView(ctx);
		},
	});

	pi.registerShortcut(PREV_AGENT_SHORTCUT, {
		description: "Switch to previous subagent (Codex-style)",
		handler: (ctx) => {
			switchToView(ctx, -1);
		},
	});

	pi.registerShortcut(NEXT_AGENT_SHORTCUT, {
		description: "Switch to next subagent (Codex-style)",
		handler: (ctx) => {
			switchToView(ctx, 1);
		},
	});
}

let lastCtx: ExtensionContext | undefined;

/** Called from the spawn tool to refresh status bar with a fresh context. */
export function refreshSubagentStatus(ctx: ExtensionContext): void {
	lastCtx = ctx;
	updateStatusBar(ctx);
}

/** Close the view and clear timers on session shutdown. */
export function disposeSubagentPanel(): void {
	closeView?.();
	view = null;
	closeView = null;
	lastCtx = undefined;
	if (refreshTimer) {
		clearTimeout(refreshTimer);
		refreshTimer = undefined;
	}
}
