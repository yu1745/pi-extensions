import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isSubagentFailure } from "./config.js";
import {
	DONE_MESSAGE_TYPE,
	SPAWN_TOOL_LABEL,
	SPAWN_TOOL_NAME,
	SubagentParams,
	TOOL_LABEL,
	TOOL_NAME,
	WAIT_TOOL_LABEL,
	WAIT_TOOL_NAME,
} from "./constants.js";
import { getFinalOutput, getMode } from "./messages.js";
import { renderSubagentCall, renderSubagentResultBlock } from "./render.js";
import {
	getSubagentRun,
	getSubagentRuns,
	runSubagent,
	startSubagent,
	waitForSubagent,
} from "./subagent.js";
import type {
	ChildRunDetails,
	PersistedChildRunDetails,
	SubagentMode,
} from "./types.js";
import { refreshSubagentStatus } from "./view.js";

function persistedDetails(details: ChildRunDetails): PersistedChildRunDetails {
	return {
		mode: details.mode,
		cwd: details.cwd,
	};
}

function notifyCompletion(
	pi: ExtensionAPI,
	state: {
		taskId: string;
		mode: SubagentMode;
		task: string;
		status: "completed" | "failed";
		messages: ChildRunDetails["messages"];
		logFile: string;
		errorMessage?: string;
	},
) {
	const output = getFinalOutput(state.messages).trim();
	const icon = state.status === "completed" ? "✅" : "❌";
	const preview =
		output.length > 500 ? `${output.slice(0, 500)}…` : output || "(no output)";
	const errorLine = state.errorMessage
		? `\n\n**Error:** ${state.errorMessage.slice(0, 200)}`
		: "";
	pi.sendMessage(
		{
			customType: DONE_MESSAGE_TYPE,
			content: [
				`${icon} Subagent **${state.taskId}** [${state.mode}] ${state.status}.`,
				`**Task:** ${state.task}`,
				`**Log:** \`${state.logFile}\``,
				"",
				"**Output:**",
				preview,
				errorLine,
			]
				.filter(Boolean)
				.join("\n"),
			display: true,
		},
		{ deliverAs: "steer", triggerTurn: true },
	);
}

const SPAWN_PARAMS = Type.Object({
	task: Type.String({
		description:
			"Self-contained task brief. The subagent has no access to this conversation, so include: background and context, the exact goal, scope and boundaries (what to touch and what NOT to touch), constraints, cwd, and precisely what to return in its final message (e.g. file paths with line ranges, findings, or a changed-files list).",
	}),
	mode: Type.Union(
		[Type.Literal("shallow"), Type.Literal("deep"), Type.Literal("task")],
		{
			description:
				"shallow | deep | task — `shallow`: narrow, bounded recon; `deep`: broad surveys / triage / compare-rank; `task`: general work that may edit files and run commands.",
		},
	),
	cwd: Type.Optional(
		Type.String({ description: "Working directory. Defaults to current cwd." }),
	),
	notify: Type.Optional(
		Type.Boolean({
			description:
				"Whether to inject a completion notification when done (default: true).",
			default: true,
		}),
	),
}) as any;

const WAIT_PARAMS = Type.Object({
	taskId: Type.Optional(
		Type.String({
			description:
				"Task id from spawn_subagent. Omit to collect the most recent subagent.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				"Maximum time to wait in milliseconds. Omit to wait indefinitely.",
		}),
	),
}) as any;

const SPAWN_DESCRIPTION = [
	"Launch a subagent in the background and return immediately with a task id. The subagent keeps working while you continue with other work.",
	"Completion: you receive a notification message when it finishes; use wait_subagent to collect the full result, or read the log file for details.",
	"Modes: `shallow`/`deep` are read-only recon; `task` may edit files and run commands and must return a changed-files manifest.",
].join("\n");

const WAIT_DESCRIPTION = [
	"Wait for a background subagent (from spawn_subagent) to finish and return its full result. If still running after timeout_ms, returns its current status so you can continue other work and wait again later.",
	"Omit taskId to collect the most recent background subagent. If it times out, do other work and wait again later.",
].join("\n");

export function registerSubagentTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Run an isolated subagent that works autonomously in its own context and reports back when done. Its output is reliable and can be trusted for integration. Modes: `shallow`/`deep` are read-only recon; `task` may edit files and run commands and must return a changed-files manifest.",
		promptSnippet:
			"Run an isolated subagent: prefer delegating bounded sidecar tasks; `shallow`/`deep` read-only recon, `task` can edit files.",
		promptGuidelines: [],
		parameters: SubagentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const input = params as {
				task: string;
				mode: SubagentMode;
				cwd?: string;
			};
			const mode = getMode(input.mode);
			if (!mode)
				throw new Error('subagent requires mode: "shallow", "deep", or "task"');
			const details = await runSubagent(
				mode,
				input.task,
				input.cwd ?? ctx.cwd,
				signal,
				onUpdate,
				ctx.model,
			);
			const finalOutput = getFinalOutput(details.messages) || "(no output)";
			if (isSubagentFailure(details)) {
				throw new Error(
					`${TOOL_LABEL} failed: ${details.errorMessage || details.stderr || finalOutput}`,
				);
			}
			return {
				content: [{ type: "text", text: finalOutput }],
				details: persistedDetails(details),
			};
		},
		renderCall(args, theme) {
			return renderSubagentCall(
				args as { task: string; mode?: SubagentMode },
				theme,
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as
				| ChildRunDetails
				| PersistedChildRunDetails
				| undefined;
			if (!details || !("messages" in details)) {
				const first = result.content[0];
				return new Text(
					first?.type === "text" ? first.text : "(no output)",
					0,
					0,
				);
			}

			const finalOutput =
				getFinalOutput(details.messages) ||
				(result.content[0]?.type === "text"
					? result.content[0].text
					: "(no output)");
			return renderSubagentResultBlock(
				details,
				finalOutput,
				{ expanded, isPartial, showIdentity: false },
				theme,
			);
		},
	});

	pi.registerTool({
		name: SPAWN_TOOL_NAME,
		label: SPAWN_TOOL_LABEL,
		description: SPAWN_DESCRIPTION,
		promptSnippet:
			"Launch background subagents that keep working while you continue; they notify on completion and results are collected with wait_subagent",
		promptGuidelines: [],
		parameters: SPAWN_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = params as {
				task: string;
				mode: SubagentMode;
				cwd?: string;
				notify?: boolean;
			};
			const mode = getMode(input.mode);
			if (!mode)
				throw new Error(
					'spawn_subagent requires mode: "shallow", "deep", or "task"',
				);
			const notify = input.notify !== false;
			const started = startSubagent(
				{
					mode,
					task: input.task,
					cwd: input.cwd ?? ctx.cwd,
					parentModel: ctx.model,
					onSettled: (state) => {
						if (!notify) return;
						notifyCompletion(pi, {
							taskId: state.taskId,
							mode: state.mode,
							task: state.task,
							status: state.status === "completed" ? "completed" : "failed",
							messages: state.messages,
							logFile: state.logFile,
							errorMessage: state.errorMessage,
						});
					},
				},
				ctx.signal,
				undefined,
			);
			refreshSubagentStatus(ctx);
			return {
				content: [
					{
						type: "text",
						text: [
							`Subagent launched: ${started.taskId} [${mode}]`,
							`Task: ${input.task}`,
							`Log: ${started.state.logFile}`,
							"",
							"Continue with other work — you will be notified when it completes.",
							"Use wait_subagent to collect the full result when needed.",
						].join("\n"),
					},
				],
				details: {
					taskId: started.taskId,
					mode,
					cwd: input.cwd ?? ctx.cwd,
				},
			};
		},
		renderCall(args, theme) {
			const callArgs = args as { task?: string; mode?: SubagentMode };
			const preview =
				typeof callArgs.task === "string" && callArgs.task.length > 60
					? `${callArgs.task.slice(0, 60)}…`
					: typeof callArgs.task === "string"
						? callArgs.task
						: "…";
			const modeBadge =
				typeof callArgs.mode === "string"
					? ` ${theme.fg("accent", `[${callArgs.mode}]`)}`
					: "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold(SPAWN_TOOL_NAME))}${modeBadge} ${theme.fg("dim", "→ background")}\n  ${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const first = result.content[0];
			return new Text(
				`${theme.fg("success", "⚡")} ${
					first?.type === "text" ? first.text : "(launched)"
				}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: WAIT_TOOL_NAME,
		label: WAIT_TOOL_LABEL,
		description: WAIT_DESCRIPTION,
		promptSnippet:
			"Collect the result of a background subagent; call sparingly — continue working while subagents run",
		promptGuidelines: [],
		parameters: WAIT_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = params as { taskId?: string; timeoutMs?: number };
			const state = input.taskId
				? getSubagentRun(input.taskId)
				: getSubagentRuns()
						.filter((r) => r.status === "running")
						.sort((a, b) => b.startedAt - a.startedAt)[0];
			if (!state) {
				const available = getSubagentRuns();
				if (available.length === 0) {
					return {
						content: [
							{ type: "text", text: "No subagents running or completed." },
						],
						details: {},
					};
				}
				const latest = [...available].sort(
					(a, b) => b.startedAt - a.startedAt,
				)[0];
				const output = getFinalOutput(latest.messages).trim() || "(no output)";
				return {
					content: [
						{
							type: "text",
							text: `Subagent ${latest.taskId} already ${latest.status}.\n${output}`,
						},
					],
					details: {
						taskId: latest.taskId,
						mode: latest.mode,
						cwd: latest.cwd,
					},
				};
			}

			const result = await waitForSubagent(state.taskId, input.timeoutMs);
			if (!result.done) {
				const preview = getFinalOutput(state.messages).trim();
				return {
					content: [
						{
							type: "text",
							text: [
								`Subagent ${state.taskId} [${state.mode}] still running after ${Math.round((input.timeoutMs ?? 0) / 1000)}s.`,
								preview
									? `Latest output:\n${preview.split("\n").slice(0, 8).join("\n")}`
									: "No output yet.",
								"",
								"Continue other work and wait again later, or use the log file for progress.",
							].join("\n"),
						},
					],
					details: { taskId: state.taskId, mode: state.mode, cwd: state.cwd },
				};
			}

			const details = result.details!;
			const finalOutput = getFinalOutput(details.messages) || "(no output)";
			if (isSubagentFailure(details)) {
				throw new Error(
					`${TOOL_LABEL} failed: ${details.errorMessage || details.stderr || finalOutput}`,
				);
			}
			return {
				content: [{ type: "text", text: finalOutput }],
				details: persistedDetails(details),
			};
		},
		renderCall(args, theme) {
			const callArgs = args as { taskId?: string };
			const target = callArgs?.taskId
				? theme.fg("accent", callArgs.taskId)
				: theme.fg("dim", "(latest)");
			return new Text(
				`${theme.fg("toolTitle", theme.bold(WAIT_TOOL_NAME))} ${target}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as
				| ChildRunDetails
				| PersistedChildRunDetails
				| undefined;
			if (!details || !("messages" in details)) {
				const first = result.content[0];
				return new Text(
					first?.type === "text" ? first.text : "(no result)",
					0,
					0,
				);
			}
			const finalOutput =
				getFinalOutput(details.messages) ||
				(result.content[0]?.type === "text"
					? result.content[0].text
					: "(no output)");
			return renderSubagentResultBlock(
				details,
				finalOutput,
				{ expanded, isPartial, showIdentity: false },
				theme,
			);
		},
	});

	pi.registerMessageRenderer(DONE_MESSAGE_TYPE, (message, _options, theme) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", "🔔"), 0, 0));
		container.addChild(
			new Markdown(message.content as string, 0, 0, getMarkdownTheme()),
		);
		return container;
	});
}
