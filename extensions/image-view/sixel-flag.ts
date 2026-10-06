/**
 * Sixel 兜底开关（默认开）。
 *
 * 只有 Kitty/iTerm2 都不可用时才轮到 Sixel，所以「开」不会和更好的协议
 * 抢；`/img-sixel off` 留给那种吞掉 Sixel 又不报错、导致十几行空白的终端。
 *
 * 判定顺序：会话内 `/img-sixel` 的即时设置 > 环境变量 > 状态文件 > 默认开。
 */

import { readFileSync, writeFileSync } from "node:fs";

const FLAG = `${process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.cache`}/pi-image-view-sixel`;

let override: boolean | null = null;

function readFlag(): boolean | null {
	try {
		const v = readFileSync(FLAG, "utf8").trim();
		if (v === "on") return true;
		if (v === "off") return false;
	} catch {
		/* 没写过：走默认 */
	}
	return null;
}

export function sixelEnabled(): boolean {
	if (override !== null) return override;
	const env = process.env.PI_IMAGE_VIEW_SIXEL;
	if (env === "1" || env === "on") return true;
	if (env === "0" || env === "off") return false;
	return readFlag() ?? true;
}

export function setSixelEnabled(on: boolean): void {
	override = on;
	try {
		writeFileSync(FLAG, on ? "on" : "off");
	} catch {
		/* 只读文件系统：会话内仍然生效 */
	}
}