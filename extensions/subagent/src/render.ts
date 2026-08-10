import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { isSubagentFailure } from "./config.js";
import { MODE_SPECS, TOOL_NAME } from "./constants.js";
import { formatToolCall, formatUsage, getToolCalls } from "./messages.js";
import type { ChildRunDetails } from "./types.js";

function getSubagentCallPreview(
	details: Pick<ChildRunDetails, "task" | "mode">,
	theme: any,
): string {
	const preview =
		details.task.length > 90 ? `${details.task.slice(0, 90)}...` : details.task;
	return `${theme.fg("toolTitle", theme.bold(TOOL_NAME))} ${theme.fg("accent", `[${details.mode}]`)}\n  ${theme.fg("dim", preview)}`;
}

export function renderSubagentCall(
	args: { task?: string; mode?: unknown },
	theme: any,
) {
	const previewText = typeof args.task === "string" ? args.task : "";
	const preview =
		previewText.length > 90 ? `${previewText.slice(0, 90)}...` : previewText;
	const modeBadge =
		typeof args.mode === "string"
			? ` ${theme.fg("accent", `[${args.mode}]`)}`
			: "";
	return new Text(
		`${theme.fg("toolTitle", theme.bold(TOOL_NAME))}${modeBadge}\n  ${theme.fg("dim", preview)}`,
		0,
		0,
	);
}

export function renderSubagentResultBlock(
	details: ChildRunDetails,
	resultText: string,
	options: {
		expanded: boolean;
		isPartial: boolean;
		showIdentity: boolean;
		statusOverride?: string;
		errorText?: string;
	},
	theme: any,
) {
	const failed = options.statusOverride
		? options.statusOverride === "failed"
		: isSubagentFailure(details);
	const finalOutput = resultText || "(no output)";
	const modelLabel = details.thinking
		? `${details.model}:${details.thinking}`
		: details.model;
	const usage = formatUsage(details.usage);
	const toolCalls = getToolCalls(details.messages);
	const status =
		options.statusOverride === "running"
			? theme.fg("warning", "… Running")
			: options.statusOverride === "failed"
				? theme.fg("error", "✗ Failed")
				: options.isPartial
					? theme.fg("warning", "… Running")
					: failed
						? theme.fg("error", "✗ Failed")
						: theme.fg("success", "✓ Done");
	const header = `${status} ${theme.fg("accent", modelLabel)}`;
	const identity = options.showIdentity
		? getSubagentCallPreview(details, theme)
		: undefined;

	if (!options.expanded) {
		const previewSource =
			finalOutput !== "(no output)"
				? finalOutput
				: toolCalls.at(-1)
					? `→ ${formatToolCall(toolCalls.at(-1)!.name, toolCalls.at(-1)!.args)}`
					: finalOutput;
		const preview = previewSource.split("\n").slice(0, 8).join("\n");
		const footer = usage ? `\n${theme.fg("dim", usage)}` : "";
		const container = new Container();
		if (identity) container.addChild(new Text(identity, 0, 0));
		container.addChild(new Text(header, 0, 0));
		container.addChild(new Markdown(preview, 0, 0, getMarkdownTheme()));
		if (footer) container.addChild(new Text(footer, 0, 0));
		return container;
	}

	const container = new Container();
	if (identity) {
		container.addChild(new Text(identity, 0, 0));
		container.addChild(new Spacer(1));
	}
	container.addChild(new Text(header, 0, 0));
	container.addChild(
		new Text(
			theme.fg(
				"dim",
				`${MODE_SPECS[details.mode].label} subagent · ${details.cwd}`,
			),
			0,
			0,
		),
	);
	container.addChild(
		new Text(theme.fg("dim", MODE_SPECS[details.mode].shortDescription), 0, 0),
	);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "Task"), 0, 0));
	container.addChild(new Text(details.task, 0, 0));
	if (toolCalls.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "Tool calls"), 0, 0));
		for (const call of toolCalls) {
			container.addChild(
				new Text(
					theme.fg("dim", `• ${formatToolCall(call.name, call.args)}`),
					0,
					0,
				),
			);
		}
	}
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "Output"), 0, 0));
	container.addChild(
		new Markdown(finalOutput.trim() || "(no output)", 0, 0, getMarkdownTheme()),
	);
	const stderr = options.errorText?.trim() || details.stderr.trim();
	if (stderr) {
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(theme.fg(failed ? "error" : "dim", stderr), 0, 0),
		);
	}
	if (usage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usage), 0, 0));
	}
	return container;
}
