/**
 * Inject-Resume-on-Exit（pi 端 · 通用版，用于 Linux/bash 服务器，如 ssh mc）
 *
 * 与本地 PowerShell 版等价，只是消费端不同：
 *   - 本地(Windows/PowerShell)：退出后由 PS 包装函数 AddToHistory 注入。
 *   - 远程(Linux/bash)：退出后由 ~/.bashrc 里的 pi 包装函数读取此文件，
 *     用 `history -s` 注入父 shell 历史，按 ↑ 即可回到本 session。
 *
 * 机制：
 *   - pi 在 TUI 正常退出（Ctrl+C/Ctrl+D//quit）时触发 session_shutdown，
 *     event.reason === "quit"。
 *   - 本扩展把 `pi --session <sessionId>` 写进邮箱文件（os.tmpdir() 即 /tmp）。
 *   - 不依赖 process.stdout/TTY（formatResumeCommand 要求在真 TTY 才打印
 *     "To resume..."，任何 wrapper 捕获输出都会掐断它）。这里用
 *     sessionManager.getSessionId() 程序化取 id，TTY 无关，最可靠。
 *
 * 注意：只在 reason==="quit" 写；"/resume /new /fork" 等会话内切换跳过。
 */

import { promises as fsPromises } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 邮箱文件路径 —— 与 ~/.bashrc 里的 pi 包装函数读取路径保持一致
const MAILBOX = join(tmpdir(), "pi_session_last.txt");

export default function (pi: ExtensionAPI): void {
	pi.on("session_shutdown", async (event, ctx): Promise<void> => {
		// 只在真正退出进程时注入（reason 含 "quit"），会话内切换一律跳过
		if (event.reason !== "quit") return;

		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) return;

			const line = `pi --session ${sessionId}`;
			await fsPromises.writeFile(MAILBOX, line.trim() + "\n", "utf8");
		} catch {
			// 忽略文件系统错误，避免影响退出流程
		}
	});
}
