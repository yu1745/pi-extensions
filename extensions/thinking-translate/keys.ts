/**
 * 快捷键冲突检查。
 *
 * pi 的扩展快捷键和内置 keybinding 争用同一批按键（`ExtensionRunner.getShortcuts`）：
 *  - 撞上「保留」内置动作（`tui.editor.deleteToLineEnd`、`app.clear` 之类）时，
 *    扩展快捷键会被**直接丢弃**，只在启动时打一条 warning；
 *  - 撞上普通内置动作时扩展能生效，但那个内置按键就废了（同样是 warning）。
 *
 * 所以注册前先自己算一遍有效键位表：拿 pi 内置默认值 + 用户 keybindings.json
 * 覆盖（用户配置替换默认，空数组表示禁用）得出「某个键归谁」，只挑没被占用的。
 * 内置默认值抄自 pi 1.5.0 的 docs/keybindings.md，改动需同步。
 */

export type KeybindingConfig = Record<string, string | string[] | undefined>;

/** 用户按 `platform=win32` 时的差异项（其余与 Linux/macOS 相同） */
const WINDOWS_OVERRIDES: Record<string, readonly string[]> = {
	"tui.editor.undo": ["ctrl+z"],
	"tui.altScreen.previousPrompt": ["ctrl+up"],
	"tui.altScreen.nextPrompt": ["ctrl+down"],
	"tui.altScreen.search": ["ctrl+f"],
	"app.suspend": [],
	"app.clipboard.pasteImage": ["alt+v"],
	"app.message.followUp": ["ctrl+q"],
	"app.message.dequeue": ["alt+q"],
	"app.model.cycleBackward": ["alt+p"],
};

const DEFAULT_KEYBINDINGS: Record<string, readonly string[]> = {
	// 编辑器
	"tui.editor.cursorUp": ["up"],
	"tui.editor.cursorDown": ["down"],
	"tui.editor.cursorLeft": ["left", "ctrl+b"],
	"tui.editor.cursorRight": ["right", "ctrl+f"],
	"tui.editor.cursorWordLeft": ["alt+left", "ctrl+left", "alt+b"],
	"tui.editor.cursorWordRight": ["alt+right", "ctrl+right", "alt+f"],
	"tui.editor.cursorLineStart": ["home", "ctrl+a"],
	"tui.editor.cursorLineEnd": ["end", "ctrl+e"],
	"tui.editor.jumpForward": ["ctrl+]"],
	"tui.editor.jumpBackward": ["ctrl+alt+]"],
	"tui.editor.pageUp": ["pageUp", "ctrl+pageUp"],
	"tui.editor.pageDown": ["pageDown", "ctrl+pageDown"],
	"tui.editor.deleteCharBackward": ["backspace"],
	"tui.editor.deleteCharForward": ["delete", "ctrl+d"],
	"tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace"],
	"tui.editor.deleteWordForward": ["alt+d", "alt+delete"],
	"tui.editor.deleteToLineStart": ["ctrl+u"],
	"tui.editor.deleteToLineEnd": ["ctrl+k"],
	"tui.editor.yank": ["ctrl+y"],
	"tui.editor.yankPop": ["alt+y"],
	"tui.editor.undo": ["ctrl+-"],
	// 输入 / 选择
	"tui.input.newLine": ["shift+enter", "ctrl+j"],
	"tui.input.submit": ["enter"],
	"tui.input.tab": ["tab"],
	"tui.input.copy": ["ctrl+c"],
	"tui.select.up": ["up"],
	"tui.select.down": ["down"],
	"tui.select.pageUp": ["pageUp"],
	"tui.select.pageDown": ["pageDown"],
	"tui.select.confirm": ["enter"],
	"tui.select.cancel": ["escape", "ctrl+c"],
	// 全屏
	"tui.altScreen.pageUp": ["pageUp"],
	"tui.altScreen.pageDown": ["pageDown"],
	"tui.altScreen.previousPrompt": ["ctrl+shift+up"],
	"tui.altScreen.nextPrompt": ["ctrl+shift+down"],
	"tui.altScreen.search": ["ctrl+shift+f"],
	"tui.altScreen.searchNext": ["enter", "ctrl+g"],
	"tui.altScreen.searchPrevious": ["shift+enter", "ctrl+shift+g"],
	"tui.altScreen.searchClose": ["escape"],
	"tui.altScreen.top": ["ctrl+home"],
	"tui.altScreen.bottom": ["ctrl+end"],
	// 应用
	"app.interrupt": ["escape"],
	"app.clear": ["ctrl+c"],
	"app.exit": ["ctrl+d"],
	"app.suspend": ["ctrl+z"],
	"app.editor.external": ["ctrl+g"],
	"app.clipboard.pasteImage": ["ctrl+v"],
	"app.session.togglePath": ["ctrl+p"],
	"app.session.toggleSort": ["ctrl+s"],
	"app.session.toggleNamedFilter": ["ctrl+n"],
	"app.session.rename": ["ctrl+r"],
	"app.session.delete": ["ctrl+d"],
	"app.session.deleteNoninvasive": ["ctrl+backspace"],
	"app.model.select": ["ctrl+l"],
	"app.model.cycleForward": ["ctrl+p"],
	"app.model.cycleBackward": ["shift+ctrl+p"],
	"app.models.save": ["ctrl+s"],
	"app.thinking.cycle": ["shift+tab"],
	"app.thinking.save": ["ctrl+s"],
	"app.thinking.toggle": ["ctrl+t"],
	"app.tools.expand": ["ctrl+o"],
	"app.message.copy": ["ctrl+x"],
	"app.message.followUp": ["alt+enter"],
	"app.message.dequeue": ["alt+up"],
	"app.tree.foldOrUp": ["ctrl+left", "alt+left"],
	"app.tree.unfoldOrDown": ["ctrl+right", "alt+right"],
	"app.tree.editLabel": ["shift+l"],
	"app.tree.toggleLabelTimestamp": ["shift+t"],
};

/**
 * pi 里被标为「保留」的 keybinding：扩展快捷键撞上它们会被静默丢弃。
 * 与 pi 源码 `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` 一致。
 */
export const RESERVED_KEYBINDINGS: ReadonlySet<string> = new Set([
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.message.copy",
	"app.message.followUp",
	"tui.input.submit",
	"tui.select.confirm",
	"tui.select.cancel",
	"tui.input.copy",
	"tui.editor.deleteToLineEnd",
]);

/** `Ctrl+Shift+K` / `shift+ctrl+k` → `ctrl+shift+k`；修饰键排序后比较才可靠 */
export function normalizeKey(key: string): string {
	const parts = key
		.trim()
		.toLowerCase()
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean);
	const name = parts.pop() ?? "";
	const mods = [...new Set(parts)].sort();
	return [...mods, name].join("+");
}

export type KeyOwner = { binding: string; reserved: boolean };

/**
 * 有效键位表：内置默认 + 用户覆盖。用户值替换该动作的默认列表，空数组表示禁用。
 */
export function effectiveBindings(
	userConfig: KeybindingConfig = {},
	platform: NodeJS.Platform = process.platform,
): Map<string, KeyOwner> {
	const table = new Map<string, KeyOwner>();
	const overrides = platform === "win32" ? WINDOWS_OVERRIDES : {};
	const defaults = new Map<string, readonly string[]>();
	for (const [binding, keys] of Object.entries(DEFAULT_KEYBINDINGS)) defaults.set(binding, keys);
	for (const [binding, keys] of Object.entries(overrides)) defaults.set(binding, keys);

	for (const [binding, keys] of defaults) {
		const override = userConfig[binding];
		const resolved = override === undefined ? keys : Array.isArray(override) ? override : [override];
		for (const key of resolved) {
			const normalized = normalizeKey(key);
			if (!normalized) continue;
			const reserved = RESERVED_KEYBINDINGS.has(binding);
			const existing = table.get(normalized);
			// 保留动作优先登记，扩展才不会被「非保留」项抢占判断
			if (existing?.reserved && !reserved) continue;
			table.set(normalized, { binding, reserved });
		}
	}
	return table;
}

export interface ShortcutPick {
	/** 最终可用的键，undefined 表示所有候选都被占了 */
	key?: string;
	/** 被跳过的候选及占用者 */
	rejected: { key: string; owner: string; reserved: boolean }[];
}

/**
 * 从候选里挑第一个没冲突的键。
 * 只要撞上任何内置/用户键位就跳过——不抢内置按键是这里的硬要求。
 */
export function pickShortcut(
	candidates: readonly string[],
	userConfig: KeybindingConfig = {},
	platform: NodeJS.Platform = process.platform,
): ShortcutPick {
	const table = effectiveBindings(userConfig, platform);
	const rejected: ShortcutPick["rejected"] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const normalized = normalizeKey(candidate);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		const owner = table.get(normalized);
		if (owner) {
			rejected.push({ key: normalized, owner: owner.binding, reserved: owner.reserved });
			continue;
		}
		return { key: normalized, rejected };
	}
	return { rejected };
}
