import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createChildRunDetails, readConfig } from "./config.js";
import {
	CHILD_ENV,
	getAgentDir,
	MODE_SPECS,
	RPC_READY_TIMEOUT_MS,
	RPC_RESPONSE_TIMEOUT_MS,
	TOOL_LABEL,
} from "./constants.js";
import { getFinalOutput, getToolCalls } from "./messages.js";
import type {
	ChildRunDetails,
	SubagentMode,
	SubagentRunState,
	SubagentStatus,
} from "./types.js";

export interface ParentModel {
	provider: string;
	id: string;
}

export interface StartSubagentOptions {
	mode: SubagentMode;
	task: string;
	cwd: string;
	parentModel?: ParentModel;
	/** Called whenever the run's live state changes (new message, tool call, completion). */
	onStateChange?: (state: SubagentRunState) => void;
	/** Called once when the run reaches a final state. */
	onSettled?: (state: SubagentRunState) => void;
}

export interface StartedSubagent {
	taskId: string;
	/** Live state — mutated in place as events arrive. */
	state: SubagentRunState;
	/** Resolves with the full run details when the subagent settles. */
	settled: Promise<ChildRunDetails>;
	cancel: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory registry of all runs (including finished ones) for the current
// session. Read by the live panel, wait_subagent, and cleanup.
// ---------------------------------------------------------------------------

const runs = new Map<string, SubagentRunState>();
const settledWaiters = new Map<string, (details: ChildRunDetails) => void>();
const processes = new Map<string, { stop: () => Promise<void> }>();

let taskCounter = 0;
let stateListener: ((state: SubagentRunState) => void) | undefined;

function generateTaskId(): string {
	return `sa-${++taskCounter}-${Date.now().toString(36)}`;
}

export function getSubagentRuns(): SubagentRunState[] {
	return Array.from(runs.values());
}

export function getSubagentRun(taskId: string): SubagentRunState | undefined {
	return runs.get(taskId);
}

/** Subscribe to any registry/state change (used by the live panel + status bar). */
export function onSubagentStateChange(
	listener: (state: SubagentRunState) => void,
): void {
	stateListener = listener;
}

function notifyStateChange(state: SubagentRunState): void {
	stateListener?.(state);
}

function settleRun(taskId: string, details: ChildRunDetails): void {
	const waiter = settledWaiters.get(taskId);
	if (waiter) {
		settledWaiters.delete(taskId);
		waiter(details);
	}
}

/**
 * The subagent always follows the parent session's current model.
 * There is no model configuration: "inherit" is the only behavior.
 */
function requireParentModel(parentModel: ParentModel | undefined): string {
	if (parentModel?.provider && parentModel?.id) {
		return `${parentModel.provider}/${parentModel.id}`;
	}
	throw new Error(
		"subagent inherits the parent session model, but no active model was available. " +
			"Switch to a model with /model before running an explore subagent.",
	);
}

function logDir(): string {
	return path.join(getAgentDir(), "subagent-runs");
}

function logFileFor(taskId: string): string {
	return path.join(logDir(), `${taskId}.jsonl`);
}

/**
 * Start a subagent in the background and return immediately. The child `pi
 * --mode rpc` process keeps streaming JSON events; each event line is parsed
 * into the live state and also appended to a jsonl log file. Resolve
 * `started.settled` (or pass `onSettled`) to collect the final result.
 */
export function startSubagent(
	options: StartSubagentOptions,
	signal?: AbortSignal,
	onUpdate?: ((value: any) => void) | undefined,
): StartedSubagent {
	const { mode, task, cwd, parentModel } = options;
	const config = readConfig()[mode];
	const model = requireParentModel(parentModel);
	const spec = MODE_SPECS[mode];
	const taskId = generateTaskId();
	const details = createChildRunDetails(mode, task, cwd, model, config);

	fs.mkdirSync(logDir(), { recursive: true });
	const logStream = fs.createWriteStream(logFileFor(taskId), {
		flags: "a",
		encoding: "utf-8",
	});
	const logLine = (line: string) => {
		logStream.write(`${line}\n`);
	};

	const state: SubagentRunState = {
		taskId,
		mode,
		task,
		cwd,
		model,
		status: "running",
		startedAt: Date.now(),
		messages: details.messages,
		usage: details.usage,
		logFile: logFileFor(taskId),
	};
	runs.set(taskId, state);

	const args = [
		"--mode",
		"rpc",
		"--no-session",
		"--no-skills",
		"--model",
		model,
		"--thinking",
		config.thinking,
		"--append-system-prompt",
		spec.promptPath,
	];
	const promptText = [
		`Run as the ${spec.label} Subagent in ${mode} mode inside an isolated no-session RPC subprocess.`,
		spec.systemPreamble,
		`Mode: ${mode}`,
		`Task: ${task}`,
	].join("\n\n");

	let wasAborted = false;
	let processClosed = false;
	let processExitCode: number | undefined;
	let requestId = 0;
	let stoppedAfterCompletion = false;
	let stdoutBuffer = "";
	const stdoutDecoder = new StringDecoder("utf8");
	let resolveSettled!: (details: ChildRunDetails) => void;
	let rejectSettled!: (error: Error) => void;
	const settledPromise = new Promise<ChildRunDetails>((resolve, reject) => {
		resolveSettled = resolve;
		rejectSettled = reject;
	});
	void settledPromise.catch(() => undefined);
	const pendingRequests = new Map<
		string,
		{
			resolve: (value: any) => void;
			reject: (error: Error) => void;
		}
	>();

	const emitUpdate = () => {
		state.lastToolCall = getToolCalls(state.messages).at(-1);
		notifyStateChange(state);
		if (!onUpdate) return;
		const output = getFinalOutput(state.messages).trim();
		if (!output && getToolCalls(state.messages).length === 0) return;
		onUpdate({
			content: output ? [{ type: "text", text: output }] : [],
			details,
		});
	};

	const isWin = process.platform === "win32";
	const proc = spawn(isWin ? "pi.cmd" : "pi", args, {
		cwd,
		shell: isWin,
		detached: !isWin,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, [CHILD_ENV]: "1" },
	});

	const signalProcess = (signalName: NodeJS.Signals) => {
		if (processClosed) return;
		try {
			if (process.platform !== "win32" && proc.pid) {
				process.kill(-proc.pid, signalName);
			} else {
				proc.kill(signalName);
			}
		} catch {
			try {
				proc.kill(signalName);
			} catch {
				// Process may already be gone.
			}
		}
	};

	const rejectPendingRequests = (error: Error) => {
		for (const pending of pendingRequests.values()) {
			pending.reject(error);
		}
		pendingRequests.clear();
	};

	const sendCommand = <T = unknown>(
		command: Record<string, unknown>,
		timeoutMs = RPC_RESPONSE_TIMEOUT_MS,
	): Promise<T> => {
		if (processClosed || !proc.stdin.writable) {
			throw new Error(
				`Subagent RPC process is not available.${details.stderr ? ` Stderr: ${details.stderr.trim()}` : ""}`,
			);
		}

		const id = `req_${++requestId}`;
		const payload = JSON.stringify({ ...command, id }) + "\n";

		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				pendingRequests.delete(id);
				reject(
					new Error(
						`Timed out waiting for RPC response to ${String(command["type"])}.${details.stderr ? ` Stderr: ${details.stderr.trim()}` : ""}`,
					),
				);
			}, timeoutMs);
			pendingRequests.set(id, {
				resolve: (value) => {
					clearTimeout(timeout);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});
			proc.stdin.write(payload, (error) => {
				if (!error) return;
				const pending = pendingRequests.get(id);
				pendingRequests.delete(id);
				pending?.reject(
					error instanceof Error ? error : new Error(String(error)),
				);
			});
		});
	};

	const handleEvent = (event: any) => {
		if (event.type === "message_end" && event.message) {
			const message = event.message;
			state.messages.push(message);
			if (message.role === "assistant") {
				state.usage.turns++;
				const usage = message.usage;
				if (usage) {
					state.usage.input += usage.input || 0;
					state.usage.output += usage.output || 0;
					state.usage.cacheRead += usage.cacheRead || 0;
					state.usage.cacheWrite += usage.cacheWrite || 0;
					state.usage.cost += usage.cost?.total || 0;
					state.usage.contextTokens = usage.totalTokens || 0;
				}
				if (message.stopReason) state.stopReason = message.stopReason;
				if (message.errorMessage) state.errorMessage = message.errorMessage;
			}
			emitUpdate();
			return;
		}

		if (event.type === "agent_settled") {
			resolveSettled(details);
		}
	};

	const handleLine = (line: string) => {
		if (!line.trim()) return;
		let data: any;
		try {
			data = JSON.parse(line);
		} catch {
			return;
		}
		logLine(line);

		if (
			data.type === "response" &&
			typeof data.id === "string" &&
			pendingRequests.has(data.id)
		) {
			const pending = pendingRequests.get(data.id)!;
			pendingRequests.delete(data.id);
			if (data.success === false) {
				pending.reject(
					new Error(
						typeof data.error === "string"
							? data.error
							: `RPC ${data.command ?? "command"} failed`,
					),
				);
			} else {
				pending.resolve(data.data as unknown);
			}
			return;
		}

		handleEvent(data);
	};

	const stopProcess = async () => {
		if (processClosed) return;
		stoppedAfterCompletion = true;
		signalProcess("SIGTERM");
		await Promise.race([
			new Promise<void>((resolve) => proc.once("close", () => resolve())),
			new Promise<void>((resolve) =>
				setTimeout(() => {
					if (!processClosed) signalProcess("SIGKILL");
					resolve();
				}, 1_000),
			),
		]);
	};

	proc.stdout.on("data", (chunk) => {
		stdoutBuffer += stdoutDecoder.write(chunk);
		const lines = stdoutBuffer.split("\n");
		stdoutBuffer = lines.pop() || "";
		for (const line of lines)
			handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	});
	proc.stdout.on("end", () => {
		stdoutBuffer += stdoutDecoder.end();
	});

	proc.stderr.on("data", (chunk) => {
		details.stderr += chunk.toString();
	});

	const finalize = (status: SubagentStatus) => {
		state.status = status;
		state.completedAt = Date.now();
		state.exitCode = stoppedAfterCompletion ? 0 : (processExitCode ?? 0);
		state.lastToolCall = getToolCalls(state.messages).at(-1);
		notifyStateChange(state);
		logStream.end();
		processes.delete(taskId);
		options.onSettled?.(state);
	};

	proc.on("close", (code) => {
		processClosed = true;
		processExitCode = code ?? 0;
		if (stdoutBuffer.trim()) {
			handleLine(
				stdoutBuffer.endsWith("\r") ? stdoutBuffer.slice(0, -1) : stdoutBuffer,
			);
			stdoutBuffer = "";
		}
		rejectPendingRequests(
			new Error(
				`Subagent RPC process exited with code ${processExitCode}.${details.stderr ? ` Stderr: ${details.stderr.trim()}` : ""}`,
			),
		);
		if (!stoppedAfterCompletion) {
			if (state.status === "running") {
				finalize("failed");
				rejectSettled(
					new Error(
						`Subagent RPC process exited before agent_settled.${details.stderr ? ` Stderr: ${details.stderr.trim()}` : ""}`,
					),
				);
			}
		} else if (state.status === "running") {
			finalize("completed");
		}
	});

	proc.on("error", (error) => {
		const processError =
			error instanceof Error ? error : new Error(String(error));
		rejectPendingRequests(processError);
		if (state.status === "running") {
			finalize("failed");
			rejectSettled(processError);
		}
	});

	const cancel = async () => {
		if (wasAborted || state.status !== "running") return;
		wasAborted = true;
		const error = new Error(`${TOOL_LABEL} aborted`);
		rejectPendingRequests(error);

		if (!processClosed && proc.stdin.writable) {
			const id = `req_${++requestId}`;
			proc.stdin.write(
				JSON.stringify({ type: "abort", id }) + "\n",
				() => undefined,
			);
		}

		signalProcess("SIGTERM");
		signalProcess("SIGKILL");
		if (state.status === "running") {
			finalize("failed");
			rejectSettled(error);
		}
	};

	const handleAbort = () => {
		void cancel();
	};
	if (signal) {
		if (signal.aborted) void cancel();
		else signal.addEventListener("abort", handleAbort, { once: true });
	}

	void (async () => {
		try {
			if (wasAborted) throw new Error(`${TOOL_LABEL} aborted`);
			await sendCommand({ type: "get_state" }, RPC_READY_TIMEOUT_MS);
			await sendCommand({ type: "set_auto_compaction", enabled: true });
			await sendCommand({ type: "set_auto_retry", enabled: true });
			await sendCommand({ type: "prompt", message: promptText });
			await settledPromise;
		} catch (error) {
			if (state.status === "running") {
				finalize("failed");
				rejectSettled(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		} finally {
			signal?.removeEventListener("abort", handleAbort);
			await stopProcess();
			if (state.status === "running") finalize("completed");
			settleRun(taskId, details);
		}
	})();

	processes.set(taskId, { stop: stopProcess });
	return { taskId, state, settled: settledPromise, cancel };
}

/**
 * Synchronous (blocking) delegation: start a subagent and wait for it to
 * finish. Used by the `subagent` tool. Same behavior as before.
 */
export async function runSubagent(
	mode: SubagentMode,
	task: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate: ((value: any) => void) | undefined,
	parentModel?: ParentModel,
): Promise<ChildRunDetails> {
	const started = startSubagent(
		{ mode, task, cwd, parentModel },
		signal,
		onUpdate,
	);
	return started.settled;
}

/**
 * Wait for a background subagent to reach a final state. Resolves with
 * `{ done: false }` after `timeoutMs` when still running, or
 * `{ done: true, details }` when settled.
 */
export async function waitForSubagent(
	taskId: string,
	timeoutMs?: number,
): Promise<{ done: boolean; details?: ChildRunDetails }> {
	const state = runs.get(taskId);
	if (!state) {
		throw new Error(`Unknown subagent task id: ${taskId}`);
	}

	const details = createChildRunDetails(
		state.mode,
		state.task,
		state.cwd,
		state.model,
		readConfig()[state.mode],
	);
	details.messages = state.messages;
	details.usage = state.usage;
	details.stopReason = state.stopReason;
	details.errorMessage = state.errorMessage;
	details.exitCode = state.exitCode ?? 0;
	details.stderr = state.status === "failed" ? (state.errorMessage ?? "") : "";

	if (state.status !== "running") {
		return { done: true, details };
	}

	const settlePromise = new Promise<ChildRunDetails>((resolve) => {
		settledWaiters.set(taskId, resolve);
	});

	if (timeoutMs === undefined) {
		const details = await settlePromise;
		const updated = runs.get(taskId);
		if (updated) {
			details.messages = updated.messages;
			details.usage = updated.usage;
			details.stopReason = updated.stopReason;
			details.errorMessage = updated.errorMessage;
			details.exitCode = updated.exitCode ?? 0;
		}
		return { done: true, details };
	}

	const timeout = new Promise<"timeout">((resolve) =>
		setTimeout(() => resolve("timeout"), timeoutMs),
	);
	const result = await Promise.race([settlePromise, timeout]);
	if (result === "timeout") {
		settledWaiters.delete(taskId);
		return { done: false };
	}
	return { done: true, details: result as ChildRunDetails };
}

/** Kill a running background subagent. */
export async function cancelSubagent(taskId: string): Promise<void> {
	const proc = processes.get(taskId);
	if (proc) await proc.stop();
}

/** Kill all running subagents (called on session shutdown). */
export async function cleanupSubagents(): Promise<void> {
	const running = Array.from(processes.keys());
	await Promise.allSettled(running.map((id) => cancelSubagent(id)));
}
