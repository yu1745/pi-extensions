/**
 * Chinese Bang Bash Extension
 *
 * 支持使用中文感叹号（！和！！）触发 Bash 模式及命令执行：
 * 1. 按键输入中文叹号“！”或“！！”时，立刻变色（同步激活原生 isBashMode 并触发边框变色）
 * 2. 回车提交时，将“！”转换为“!”、“！！”转换为“!!”进入原生 handleBashCommand 执行
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		// 仅在交互模式下生效
		if (!ctx.hasUI) return;

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true } as any);

			// 拦截 onChange：当用户输入中文感叹号时，传递给原生 onChange 的文本将开头的“！”转为“!”
			// 原生 onChange 的逻辑是：this.isBashMode = text.trimStart().startsWith("!")
			// 这样按下“！”的瞬间，原生系统就会立刻将 isBashMode 置为 true 并调用 updateEditorBorderColor() 立即变色！
			let nativeOnChange: ((text: string) => void) | undefined;
			Object.defineProperty(editor, "onChange", {
				get() {
					return (text: string) => {
						const trimmed = text.trimStart();
						let normalized = text;
						if (trimmed.startsWith("！")) {
							normalized = text.replace(/^[ \t]*！/, (m) => m.slice(0, -1) + "!");
						}
						nativeOnChange?.(normalized);
					};
				},
				set(fn: ((text: string) => void) | undefined) {
					nativeOnChange = fn;
				},
				configurable: true,
				enumerable: true,
			});

			// 拦截 onSubmit：回车提交时，将开头的“！”/“！！”转为“!”/“!!”
			// 原生 onSubmit 就会命中 `if (text.startsWith("!"))` 进入 Bash 命令执行
			let nativeOnSubmit: ((text: string) => void) | undefined;
			Object.defineProperty(editor, "onSubmit", {
				get() {
					return (text: string) => {
						let normalized = text.trim();
						if (normalized.startsWith("！！")) {
							normalized = `!!${normalized.slice(2)}`;
						} else if (normalized.startsWith("！")) {
							normalized = `!${normalized.slice(1)}`;
						}
						nativeOnSubmit?.(normalized);
					};
				},
				set(fn: ((text: string) => void) | undefined) {
					nativeOnSubmit = fn;
				},
				configurable: true,
				enumerable: true,
			});

			return editor;
		});
	});
}
