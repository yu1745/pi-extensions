/**
 * Working Bell + Title Status Extension
 *
 * 两件事：
 *  1. 终端标题实时显示工作状态（spinner = 工作中 / ✓ = 已停止）
 *  2. 活儿真正干完（且不会自动续跑）时，触发终端振铃 BEL + 系统通知
 *
 * 关键：用 `agent_settled` 而不是 `agent_end`。
 * 文档："agent_end ... but Pi may still auto-retry, auto-compact and retry,
 *        or continue with queued follow-up messages. Use `agent_settled`
 *        for status integrations that need to know Pi will not continue running automatically."
 *
 * 放在 ~/.pi/agent/extensions/ 自动加载，或 pi -e ./working-bell.ts 临时测试。重载：/reload
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const IDLE_ICON = "✓";

function idleTitle(): string {
	return `π ${IDLE_ICON} ${path.basename(process.cwd())}`;
}

// ---------- 通知后端 ----------
function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	const { execFile } = require("node:child_process");
	const type = "Windows.UI.Notifications";
	const script = [
		`[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime] > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent([${type}.ToastTemplateType]::ToastText01)`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body.replace(/'/g, "''")}')\") > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show([${type}.ToastNotification]::new($xml))`,
	].join("; ");
	execFile("powershell.exe", ["-NoProfile", "-Command", script], () => {
		/* 忽略错误 */
	});
}

function ringBell(): void {
	process.stdout.write("\x07");
}

function notify(title: string, body: string): void {
	ringBell();
	if (process.env.WT_SESSION) notifyWindows(title, body);
	else if (process.env.KITTY_WINDOW_ID) notifyOSC99(title, body);
	else notifyOSC777(title, body);
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		ctx.ui.setTitle(idleTitle());
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			ctx.ui.setTitle(`${frame} π · ${path.basename(process.cwd())}`);
			frameIndex++;
		}, 80);
	}

	pi.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		stopAnimation(ctx);
		notify("Pi", "Ready for input");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
