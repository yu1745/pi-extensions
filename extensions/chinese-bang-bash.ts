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

			// 拦截 onChange：把中文全角“！”/“／”归一化成半角，编辑器状态与补全都能立即跟上。
			// 1) “！”→“!”：按下瞬间原生 isBashMode 置 true 并立即变色
			// 2) 中文输入法下的“/”→"/"：中文输入法会把 / 变成“／”或“、”，
			//    原生只有输入半角 “/” 时才会触发斜杠命令补全，所以我们在插入层
			//    把字符换掉，再手动触发一次补全。只在输入框为空时换，正文里的
			//    全角符号保留，不会误伤中文标点。
			const IME_SLASH_CHARS = /[／、∕⁄]/;
			let nativeOnChange: ((text: string) => void) | undefined;
			// 输入框（光标前）为空时，落在 lookalike 集合里的字符按 “/” 处理
			const mapSlashLookalike = (editor: any, text: string): string => {
				if (!text || !IME_SLASH_CHARS.test(text)) return text;
				const cursor = editor.getCursor?.();
				const currentLine = editor.state?.lines?.[cursor?.line ?? 0] ?? "";
				const before = currentLine.slice(0, cursor?.col ?? 0);
				const atStart = before.trim() === "";
				if (!atStart) return text;
				const replaced = text.replace(new RegExp(IME_SLASH_CHARS.source, "g"), "/");
				return replaced;
			};
			const triggerSlashMenu = (editor: any) => {
				try {
					if (editor.isAtStartOfMessage?.()) editor.tryTriggerAutocomplete?.();
				} catch {}
			};
			// 包住所有真正写入字符的入口：按键输入 / IME 提交（走粘贴通道）
			for (const method of ["insertCharacter", "insertTextAtCursor", "insertTextAtCursorInternal"]) {
				const original = (editor as any)[method];
				if (typeof original !== "function") continue;
				Object.defineProperty(editor, method, {
					value: function (text: string, ...rest: any[]) {
						const mapped = mapSlashLookalike(editor, text);
						const result = original.call(this, mapped, ...rest);
						if (mapped !== text) triggerSlashMenu(editor);
						return result;
					},
					writable: true,
					configurable: true,
				});
			}
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
						// 全角符号已在空输入时替换；这里再兜底一次以防粘贴进来
						if (normalized.startsWith("／")) {
							normalized = normalized.replace(/^[／]+/, (m) => "/".repeat(m.length));
						} else if (normalized.startsWith("、")) {
							normalized = `/${normalized.slice(1)}`;
						}
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
