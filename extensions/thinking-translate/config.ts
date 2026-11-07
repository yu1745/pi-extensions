/**
 * 配置文件：`<agent-dir>/thinking-translate.json`，缺字段用默认值。
 * 文件不存在也能跑（默认关闭）。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { MARKER_STYLES, type MarkerStyle } from "./marker.ts";
import { join } from "node:path";

export const CONFIG_FILE = "thinking-translate.json";

export interface ThinkingTranslateConfig {
	/** 启动时是否已开启（默认 false，用快捷键或 /thinking-translate on 开） */
	enabled: boolean;
	/**
	 * 候选快捷键，按顺序取第一个没被占用的。
	 * ctrl+k 默认被 `tui.editor.deleteToLineEnd` 占着（而且是保留键，扩展抢了会被丢弃），
	 * 所以默认顺位是 ctrl+k → alt+k → ctrl+alt+k。
	 */
	shortcuts: string[];
	/** 拉丁字母占「字母总数」的比例 ≥ 该值就算英文，需要翻译 */
	englishRatio: number;
	/** 拉丁字母少于这个数量不翻译（"OK"、"TODO" 这类） */
	minLatinLetters: number;
	/** 单次请求最大字符数，超过按段落分块 */
	maxChars: number;
	/** 翻译模型，`provider/modelId` 或纯 modelId；留空自动挑便宜的 */
	model: string;
	/** 目标语言 */
	targetLanguage: string;
	/** message_end 里最多等译文多久（毫秒），超时就让后续重绘补上 */
	finalizeWaitMs: number;
	/** 开启时是否在状态栏显示标记 */
	showStatus: boolean;
	/**
	 * 是否把译文落盘到会话 jsonl 旁边的 `<session>.thinking-translate.txt`
	 * （jsonl 格式，一行一条）。关掉就是纯内存，重启/恢复后历史思考变回英文。
	 */
	persist: boolean;
	/** 单次翻译请求的超时（毫秒）；超时换下一个候选模型，不会把后面的翻译堵死 */
	requestTimeoutMs: number;
	/** 翻译彻底失败时是否提示一次（不提示就只在 status 里可见） */
	notifyFailure: boolean;
	/** 译文块顶部的标记文字（空字符串 = 不标记） */
	markerLabel: string;
	/** 标记的 Markdown 形态，决定它用什么主题色 */
	markerStyle: MarkerStyle;
}

export const CONFIG_DEFAULTS: ThinkingTranslateConfig = {
	enabled: false,
	shortcuts: ["ctrl+k", "alt+k", "ctrl+alt+k"],
	englishRatio: 0.5,
	minLatinLetters: 40,
	maxChars: 6000,
	model: "",
	targetLanguage: "简体中文",
	finalizeWaitMs: 1500,
	showStatus: true,
	persist: true,
	requestTimeoutMs: 25000,
	notifyFailure: true,
	markerLabel: "🀄 译",
	markerStyle: "code",
};

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** 容错归一化：类型不对的字段回退默认值，阈值裁剪到合法区间 */
export function normalizeConfig(raw: unknown): ThinkingTranslateConfig {
	const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const shortcuts = Array.isArray(input.shortcuts)
		? input.shortcuts.filter((key): key is string => typeof key === "string" && key.trim() !== "")
		: typeof input.shortcuts === "string" && input.shortcuts.trim() !== ""
			? [input.shortcuts]
			: CONFIG_DEFAULTS.shortcuts;
	const ratio = isFiniteNumber(input.englishRatio)
		? Math.min(1, Math.max(0, input.englishRatio))
		: CONFIG_DEFAULTS.englishRatio;
	const minLatin = isFiniteNumber(input.minLatinLetters)
		? Math.max(0, Math.floor(input.minLatinLetters))
		: CONFIG_DEFAULTS.minLatinLetters;
	const maxChars = isFiniteNumber(input.maxChars) && input.maxChars > 0
		? Math.floor(input.maxChars)
		: CONFIG_DEFAULTS.maxChars;
	const finalizeWait = isFiniteNumber(input.finalizeWaitMs) && input.finalizeWaitMs >= 0
		? Math.floor(input.finalizeWaitMs)
		: CONFIG_DEFAULTS.finalizeWaitMs;
	return {
		enabled: typeof input.enabled === "boolean" ? input.enabled : CONFIG_DEFAULTS.enabled,
		shortcuts: shortcuts.length > 0 ? shortcuts : CONFIG_DEFAULTS.shortcuts,
		englishRatio: ratio,
		minLatinLetters: minLatin,
		maxChars,
		model: typeof input.model === "string" ? input.model.trim() : CONFIG_DEFAULTS.model,
		targetLanguage:
			typeof input.targetLanguage === "string" && input.targetLanguage.trim()
				? input.targetLanguage.trim()
				: CONFIG_DEFAULTS.targetLanguage,
		finalizeWaitMs: finalizeWait,
		showStatus: typeof input.showStatus === "boolean" ? input.showStatus : CONFIG_DEFAULTS.showStatus,
		persist: typeof input.persist === "boolean" ? input.persist : CONFIG_DEFAULTS.persist,
		requestTimeoutMs:
			isFiniteNumber(input.requestTimeoutMs) && input.requestTimeoutMs > 0
				? Math.floor(input.requestTimeoutMs)
				: CONFIG_DEFAULTS.requestTimeoutMs,
		notifyFailure:
			typeof input.notifyFailure === "boolean" ? input.notifyFailure : CONFIG_DEFAULTS.notifyFailure,
		markerLabel: typeof input.markerLabel === "string" ? input.markerLabel : CONFIG_DEFAULTS.markerLabel,
		markerStyle: MARKER_STYLES.includes(input.markerStyle as MarkerStyle)
			? (input.markerStyle as MarkerStyle)
			: CONFIG_DEFAULTS.markerStyle,
	};
}

export function configPath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE);
}

/** 读配置；文件缺失或 JSON 坏掉都回退默认值（并告诉调用方原因） */
export function loadConfig(agentDir: string): { config: ThinkingTranslateConfig; problem?: string } {
	let text: string;
	try {
		text = readFileSync(configPath(agentDir), "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { config: { ...CONFIG_DEFAULTS }, problem: code === "ENOENT" ? undefined : String(error) };
	}
	try {
		return { config: normalizeConfig(JSON.parse(text)) };
	} catch (error) {
		return { config: { ...CONFIG_DEFAULTS }, problem: `${CONFIG_FILE} 不是合法 JSON：${String(error)}` };
	}
}

/**
 * 把开关状态写回配置文件。
 *
 * 为什么必须写回去：`/reload`、重启 pi、`/new` 都会重建扩展实例，`enabled` 又会从
 * 配置里读一遍。如果只在内存里切，一次 reload 就悄悄变回关，表现是"突然不翻了"。
 */
export function persistEnabled(agentDir: string, enabled: boolean): void {
	let raw: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath(agentDir), "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
	} catch {
		/* 文件不存在/坏掉：新建一份 */
	}
	raw.enabled = enabled;
	try {
		writeFileSync(configPath(agentDir), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	} catch {
		/* 只读文件系统：忽略，开关仅本进程有效 */
	}
}
