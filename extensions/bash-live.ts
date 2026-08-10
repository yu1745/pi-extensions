/**
 * bash-live.ts — 独立 bash 变体工具：专用于执行时间长、输出量大的命令
 *
 * 为什么存在：
 *   模型执行 `gradle build | tail -n 10` 这类命令时，管道会把原本流式的
 *   输出变成"结束时一次性吐出"。执行过程中人在 TUI 里看不到任何动静，
 *   无法判断是卡住了还是健康推进。
 *
 * 本工具的思路：
 *   0. 一条 bash-live 调用 = 一个长命令：不要用 &&/; 拼接多条长命令，
 *      每个长步骤单独执行一次 bash-live（各自独立进度/退出码/日志）；
 *      快速的非流式步骤用内建 bash 串行即可。
 *   1. 命令【原样执行，禁止模型写管道】；完整输出【始终流式】捕获：
 *      - 实时写入日志文件（全量，永不丢失）
 *      - 节流推送 partial 给 TUI —— 人实时看到滚动输出（与内建 bash 相同，
 *        ctrl+o 展开可见）
 *   2. "只看尾部 / 只看开头 / 过滤"全部用【工具参数】实现：
 *      tailLines / headLines / grep / grepV / grepContext
 *      —— 命令本体里绝不执行任何过滤，过滤全部放到后面的 filter 片段里
 *   3. 返回给模型的只是参数过滤后的结果（上下文友好），人看到的永远是完整实时流。
 *
 * 建议：gradle 等构建工具在非 tty 下无彩色/进度输出，可在命令里加
 *   --console=plain（gradle）或 -B（maven）以获得稳定的流式文本。
 *
 * 注册为独立工具（不动内建 bash）。使用：放入 ~/.pi/agent/extensions/ 后 /reload。
 */

import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const LOG_DIR = join(homedir(), ".pi", "agent", "state", "bash-live-logs");
const TAIL_DISPLAY_LINES = 1000; // TUI 实时显示的滚动窗口行数
const TAIL_DISPLAY_BYTES = 256 * 1024; // TUI 实时显示的滚动窗口字节上限（UTF-8 安全截断）
const MAX_RETURN_BYTES = 100 * 1024; // 返回给模型的结果字节上限
const LINE_DISPLAY_CAP = 8 * 1024; // 单行显示截断（防超长单行刷爆上下文）

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const bashLiveSchema = Type.Object({
	command: Type.String({
		description:
			"要执行的完整命令（原样执行、完整流式输出）。gradle 建议加 --console=plain。",
	}),
	filter: Type.Optional(
		Type.String({
			description:
				"bash 风格过滤片段，语义 = 完整输出 | filter，支持级联管道（任意 bash 片段），如 \"tail -n 10\"、\"head -n 100 | tail -n 10\"（前 100 行中的最后 10 行）、\"grep -E 'BUILD (SUCCESS|FAILED)' | head -n 20\"。对结束后的完整日志执行，不影响实时输出。不传 = 默认 tail -n 30。grep 无匹配返回 1 视为正常空结果。不要用 tail -f（会挂起）。",
		}),
	),
	timeout: Type.Optional(
		Type.Number({ description: "硬超时秒数，到点终止整个进程树（不传 = 不限时，适合长构建）" }),
	),
});

type BashLiveInput = Static<typeof bashLiveSchema>;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 与内建 bash 一致的时长格式（Elapsed/Took X.Xs） */
function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function capLine(line: string): string {
	return Buffer.byteLength(line, "utf8") > LINE_DISPLAY_CAP
		? line.slice(0, LINE_DISPLAY_CAP) + `… (line ${formatBytes(Buffer.byteLength(line, "utf8"))})`
		: line;
}

/** UTF-8 安全截断到 n 字节 */
function utf8Truncate(s: string, n: number): string {
	let buf = Buffer.from(s, "utf8");
	if (buf.length <= n) return s;
	buf = buf.subarray(0, n);
	while (buf.length > 0 && (buf[buf.length - 1] & 0xc0) === 0x80) buf = buf.subarray(0, buf.length - 1);
	return buf.toString("utf8") + "\n… (truncated)";
}

function newLogPath(): string {
	mkdirSync(LOG_DIR, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(LOG_DIR, `${stamp}-${randomBytes(4).toString("hex")}.log`);
}

/** shell 单引号安全引用：' → '\\'' （用于把路径等拼进 sh -c 字符串） */
function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 流式行拆分器：处理跨 chunk 的半行 */
class LineSplitter {
	private pending = "";
	/** 消费一块数据，产出完整行（不含 \n） */
	feed(chunk: string): string[] {
		const all = this.pending + chunk;
		const lines = all.split("\n");
		this.pending = lines.pop() ?? "";
		return lines;
	}
	/** 结束：吐出最后的半行（若有） */
	finish(): string[] {
		if (this.pending.length === 0) return [];
		const last = this.pending;
		this.pending = "";
		return [last];
	}
}

// ---------------------------------------------------------------------------
// 核心执行
// ---------------------------------------------------------------------------

function buildEnv(ctx: ExtensionContext | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (ctx) {
		try {
			env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		} catch {
			/* ignore */
		}
		try {
			const sf = ctx.sessionManager.getSessionFile();
			if (sf) env.PI_SESSION_FILE = sf;
		} catch {
			/* ignore */
		}
		if (ctx.model) {
			env.PI_PROVIDER = ctx.model.provider;
			env.PI_MODEL = ctx.model.id;
		}
		if (ctx.thinkingLevel !== undefined) env.PI_REASONING_LEVEL = String(ctx.thinkingLevel);
	}
	return env;
}

function killProcessGroup(pid: number, sig: NodeJS.Signals = "SIGTERM"): void {
	if (!pid) return;
	try {
		process.kill(-pid, sig);
	} catch {
		/* ignore */
	}
	try {
		process.kill(pid, sig);
	} catch {
		/* ignore */
	}
}

/** 基于日志文件的最终过滤：grep/grepV [+grepContext] → headLines/tailLines */
function filterOutput(
	logFile: string,
	params: BashLiveInput,
): { text: string; stats: { totalLines: number; totalBytes: number }; filterDesc: string } {
	let totalBytes = 0;
	try {
		totalBytes = statSync(logFile).size;
	} catch {
		/* ignore */
	}

	const filter = params.filter?.trim();
	let result: string;
	let filterDesc: string;

	if (filter) {
		filterDesc = filter;
		// 片段对【结束后的完整日志】执行，绝不经过主命令管道 → 实时输出不受影响。
		// 安全传值：日志内容只通过 stdin 重定向进入片段（内容中的引号/$/反引号均为数据，
		// 不经过 shell 解析）；只有 filter 片段本身与日志路径（shq 引用）会被拼进 shell。
		// 关键：重定向必须放在管道【最前】（< file cmd | cmd2），放在后面会绑定到最后一个命令。
		// 用 bash 而非 sh：dash 不支持 `set -o pipefail`。
		const r = spawnSync("bash", ["-c", `set -o pipefail; < ${shq(logFile)} ${filter}`], {
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 64 * 1024 * 1024,
		});
		const stdout = (r.stdout ?? "") as string;
		const stderr = (r.stderr ?? "") as string;
		if (r.error) {
			result = `⚠️ filter 片段执行失败：${r.error.message}`;
		} else if (r.status === 0) {
			result = stdout;
		} else if (r.status === 1 && !stderr.trim()) {
			result = ""; // grep 无匹配的正常空结果
		} else {
			result = `⚠️ filter 片段执行失败 (exit ${r.status})\n${stderr.trim() || "(无 stderr)"}\n\n片段 stdout（如有）:\n${stdout}`;
		}
	} else {
		filterDesc = "tail -n 30 (default)";
		const r = spawnSync("tail", ["-n", "30", logFile], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
		result = (r.stdout ?? "") as string;
	}

	return {
		text: utf8Truncate(result.trimEnd(), MAX_RETURN_BYTES),
		stats: { totalLines: countLines(logFile), totalBytes },
		filterDesc,
	};
}

function countLines(logFile: string): number {
	const r = spawnSync("wc", ["-l", logFile], { encoding: "utf8", timeout: 10_000 });
	if (r.error || r.status !== 0) {
		try {
			const data = readFileSync(logFile, "utf8");
			return data.split("\n").length - (data.endsWith("\n") ? 1 : 0);
		} catch {
			return 0;
		}
	}
	return parseInt((r.stdout ?? "").trim().split(/\s+/)[0] ?? "0", 10) || 0;
}

async function bashLiveExecute(
	_toolCallId: string,
	params: BashLiveInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<any> | undefined,
	ctx: ExtensionContext | undefined,
): Promise<AgentToolResult<any>> {
	const command = params.command ?? "";
	const displayCmd = command.replace(/\n+/g, " ⏎ ").trim().slice(0, 300);
	const cwd = ctx?.cwd ?? process.cwd();

	const logFile = newLogPath();
	const startedAt = Date.now();
	const shell = process.env.SHELL || "/bin/bash";
	const child = spawn(shell, ["-c", command], {
		cwd,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
		env: buildEnv(ctx),
		windowsHide: true,
	});

	const splitter = new LineSplitter();
	const displayTail: string[] = []; // TUI 实时显示的滚动窗口
	let displayBytes = 0;
	let totalLines = 0;
	let totalBytes = 0;
	let lastUpdateAt = 0;
	let lastFlush = 0;

	const pushDisplay = (line: string) => {
		const b = Buffer.byteLength(line, "utf8");
		displayTail.push(line);
		displayBytes += b;
		while (displayTail.length > TAIL_DISPLAY_LINES || displayBytes > TAIL_DISPLAY_BYTES) {
			const dropped = displayTail.shift();
			if (dropped !== undefined) displayBytes -= Buffer.byteLength(dropped, "utf8");
		}
	};

	const pushProgress = () => {
		if (!onUpdate || childDone) return;
		const now = Date.now();
		if (now - lastUpdateAt < 150) return; // 节流 150ms
		lastUpdateAt = now;
		const head = `▶ 实时输出 · $ ${displayCmd}\n已 ${totalLines} 行 / ${formatBytes(totalBytes)} · 完整: ${logFile}\nElapsed ${formatDuration(Date.now() - startedAt)}`;
		const body = utf8Truncate(displayTail.join("\n"), TAIL_DISPLAY_BYTES);
		onUpdate({ content: [{ type: "text", text: `${head}\n${body}` }], details: { stage: "progress" } });
	};

	const handleData = (data: Buffer) => {
		appendFileSync(logFile, data); // 全量实时落盘
		totalBytes += data.length;
		const lines = splitter.feed(data.toString("utf8"));
		for (const line of lines) {
			totalLines++;
			pushDisplay(capLine(line));
		}
		pushProgress();
	};
	child.stdout?.on("data", handleData);
	child.stderr?.on("data", handleData);
	if (onUpdate)
		onUpdate({
			content: [{ type: "text", text: `▶ 已启动 · $ ${displayCmd}\n完整输出: ${logFile}` }],
			details: { stage: "start" },
		});

	// 无输出时（如纯 sleep）也定期推进度，让 Elapsed 实时增长（与内建 bash 观感一致）
	const progressTimer = setInterval(pushProgress, 1000);
	let childDone = false;
	let killedBy: "timeout" | "abort" | null = null;
	const outcome = await new Promise<{ exitCode: number | null }>((resolve, reject) => {
		let settled = false;
		const finish = (v: { exitCode: number | null }) => {
			if (!settled) {
				settled = true;
				resolve(v);
			}
		};
		const fail = (e: Error) => {
			if (!settled) {
				settled = true;
				reject(e);
			}
		};

		child.once("error", (err) => {
			childDone = true;
			clearInterval(progressTimer);
			fail(new Error(`Failed to spawn: ${err.message}`));
		});
		child.once("close", (code) => {
			childDone = true;
			clearInterval(progressTimer);
			if (signal) signal.removeEventListener("abort", onAbort);
			// 进程已完全退出、pipe 已 drain → 此刻组装错误能带上完整已输出
			if (killedBy === "timeout") {
				const { text } = filterOutput(logFile, params);
				fail(new Error(`Command timed out after ${params.timeout} seconds\n\n${text}\n\n完整输出: ${logFile}`));
				return;
			}
			if (killedBy === "abort") {
				const { text } = filterOutput(logFile, params);
				fail(new Error(`Command aborted\n\n${text}\n\n完整输出: ${logFile}`));
				return;
			}
			finish({ exitCode: code ?? null });
		});

		const onAbort = () => {
			killedBy = "abort";
			killProcessGroup(child.pid ?? 0, "SIGTERM");
			setTimeout(() => killProcessGroup(child.pid ?? 0, "SIGKILL"), 2000);
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		if (params.timeout !== undefined) {
			const ms = params.timeout * 1000;
			setTimeout(() => {
				if (settled) return;
				killedBy = "timeout";
				killProcessGroup(child.pid ?? 0, "SIGTERM");
				setTimeout(() => killProcessGroup(child.pid ?? 0, "SIGKILL"), 2000);
				// 兜底：SIGKILL 后仍无 close 则强制失败
				setTimeout(() => fail(new Error(`Command timed out after ${params.timeout} seconds`)), 5000);
			}, ms);
		}
	});

	// 收尾半行
	for (const line of splitter.finish()) {
		totalLines++;
		pushDisplay(capLine(line));
	}

	const { text, stats, filterDesc } = filterOutput(logFile, params);
	const fullNote = `完整输出: ${logFile}（${stats.totalLines} 行 / ${formatBytes(stats.totalBytes)}）`;

	// 最终一次 partial：让 TUI 显示与内建 bash 一致的 "Took X.Xs"
	const pushFinal = (exitCode: number | null) => {
		if (!onUpdate) return;
		const status = exitCode === 0 ? "✅ 完成" : `⚠️ exit ${exitCode ?? "?"}`;
		onUpdate({
			content: [
				{
					type: "text",
					text: `▶ 完成 · $ ${displayCmd}\n${status} · ${stats.totalLines} 行 / ${formatBytes(stats.totalBytes)} · 完整: ${logFile}\nTook ${formatDuration(Date.now() - startedAt)}`,
				},
			],
			details: { stage: "done", exitCode },
		});
	};

	const exitCode = outcome.exitCode;
	if (exitCode !== 0 && exitCode !== null) {
		pushFinal(exitCode);
		throw new Error(`Command exited with code ${exitCode}\n\n${text}\n\n${fullNote}`);
	}

	pushFinal(exitCode);

	return {
		content: [
			{
				type: "text",
				text: `✅ 完成：exit ${exitCode}，Took ${formatDuration(Date.now() - startedAt)}，共 ${stats.totalLines} 行 / ${formatBytes(stats.totalBytes)}（返回 ${filterDesc}）\n\n${text}\n\n${fullNote}`,
			},
		],
		details: { exitCode, stats, filterDesc },
	};
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "bash-live",
		label: "bash-live",
		description:
			"Execute long-running / large-output commands (builds like gradle/maven/npm, tests, installs, downloads, servers) with REAL-TIME streaming output. The command runs as-is: full output is streamed live to the TUI (expand with ctrl+o) and written in full to a log file under ~/.pi/agent/state/bash-live-logs/. The filter parameter is a bash-style fragment (e.g. \"tail -n 10\", \"head -n 100 | tail -n 10\", \"grep -E 'BUILD (SUCCESS|FAILED)' | head -n 20\") applied to the finished log only, selecting what is returned to the model; omit it for a default tail -n 30. Optional timeout=N kills the process tree at N seconds (omit for unbounded, e.g. long builds). For gradle add --console=plain for stable text output.",
		promptSnippet: "long-running/large-output commands (live streaming; filter fragment instead of pipes)",
		promptGuidelines: [
			"Any command that may run long or produce lots of output (builds, tests, installs, downloads, servers, migrations) MUST use the bash-live tool instead of bash.",
			"bash-live: NEVER run any filter inside the command body: no `| tail -n 10`, `| head`, `| grep` pipes within the command itself — they buffer output and hide live progress. All filtering goes into the filter parameter (a fragment applied to the finished log only, never affecting live streaming).",
			"bash-live: one call = ONE long-running command — do not chain multiple long commands together with `&&`/`;`; run each long step as its own separate bash-live call (independent progress, exit code, and log). Chain quick non-streaming steps in plain bash instead.",
		],
		parameters: bashLiveSchema,
		execute: bashLiveExecute,
	});
}
