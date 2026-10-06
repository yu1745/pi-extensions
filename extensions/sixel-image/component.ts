/**
 * Sixel 图片组件（同步渲染）。
 *
 * 现在只作为 image-view 的兜底分支使用：Kitty/iTerm2 可用时不会走到这里。
 *
 * pi-tui 目前只用 Kitty / iTerm2 图形协议渲染图片，不认 Sixel，所以沿用
 * quota-footer 的做法：
 *   - 用 DECSC/DECRC(\x1b7 \x1b8) 把光标包在 Sixel 前后，Sixel 终端落点
 *     不一致也不会串行；
 *   - 发一个零宽的 Kitty 占位块 \x1b_Gq=2,r=<rows>;\x1b\\，让 tui 知道这
 *     几行被占了（必须零宽，空格会触发 main-screen 的预清屏）；
 *   - renderer 只清不擦，擦除交给 tui，避免滚动残影。
 *
 * Component.render() 是同步的，所以 Sixel 负载在事件处理器里提前生成好，
 * 放进模块级缓存（不进 session，避免把几十 KB 图形写进会话文件）。
 */

import { getCellDimensions, type Component } from "@earendil-works/pi-tui";
import { renderSixel, stampOf, type Raster } from "./sixel.ts";

/**
 * Sixel 负载的宽度预算。
 *
 * 关键事实（实测）：pi 的 visibleWidth() 把 Sixel 负载的**每个字符**都当成一列
 * 可见宽度，而负载字符数 ≈ 宽 × (高/6) 条带（例如 268×125 的图 = 2208 字符，
 * 900×420 = 8896 字符）。一旦这一行走进 layout 的 compositeTuiLine() 分支
 * （聊天区因为滚动条占掉一列、盒子比终端窄时必然如此），末尾的
 * sliceByColumn(line, 0, 内容列宽) 就会把负载切断，连结尾的 \x1b\\ 都没了 ——
 * 终端拿到未终止的 DCS，整段丢弃，屏幕上只留下切断点之前的部分（"上半截"）。
 * 聊天区内容列宽只有 269，所以六像素图在聊天流里**没有可用宽度**。
 *
 * 结论：六像素图必须走**根级 widget**（盒子全宽，不走那条切片路径）。
 * 那里按终端像素宽渲染即可，仍然给 1600px 封顶以控制 convert 开销与负载体积。
 */
export function sixelPixelBudget(columns: number, forWidget = false): number {
	if (!forWidget) return Math.max(64, Math.min(400, Math.round(columns - 2)));
	const cell = getCellDimensions();
	return Math.max(200, Math.min(1600, Math.round(columns * cell.widthPx)));
}

/** 最多占多少行，避免一张长图糊满屏幕 */
export const MAX_ROWS = 40;

/** path|widthPx → 已生成的 Sixel */
const cache = new Map<string, Raster>();

/**
 * 光栅的**实际**像素宽（path → 已生成宽度）。
 *
 * 为什么需要：convert 的 `-resize Wx>` 里 `>` 表示"只缩不放"，所以请求 1600px、
 * 源图只有 900px 时，光栅仍然是 900px —— 图不会变宽。任何按"请求宽度"算出来的
 * 位置（按钮、列数、百分比）都会漂到图外去，必须按实际宽度算。
 */
const actualWidth = new Map<string, number>();

export function knownActualWidth(path: string): number | undefined {
	return actualWidth.get(path);
}
const inFlight = new Set<string>();

export function rasterKey(path: string, widthPx: number) {
	return `${path}|${widthPx}`;
}

/** 目标像素宽度（见 sixelPixelBudget 的注释） */
export function targetWidthPx(columns: number, forWidget = false): number {
	return sixelPixelBudget(Math.max(20, columns), forWidget);
}

/** 提前生成并缓存；已缓存时立即返回 */
export async function prepare(path: string, widthPx: number): Promise<Raster | null> {
	const key = rasterKey(path, widthPx);
	const hit = cache.get(key);
	if (hit) return hit;
	if (inFlight.has(key)) return null;
	inFlight.add(key);
	try {
		const stamp = await stampOf(path);
		const raster = await renderSixel(path, widthPx, stamp);
		cache.set(key, raster);
		actualWidth.set(path, raster.widthPx);
		return raster;
	} catch {
		return null;
	} finally {
		inFlight.delete(key);
	}
}

export interface SixelImageData {
	path: string;
	alt?: string;
	/** 生成时使用的目标像素宽度，render 时按它取缓存 */
	widthPx: number;
}

export class SixelImageComponent implements Component {
	private data: SixelImageData;
	private footerStyle: (text: string) => string;

	constructor(data: SixelImageData, footerStyle: (text: string) => string) {
		this.data = data;
		this.footerStyle = footerStyle;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const cell = getCellDimensions();
		const raster = cache.get(rasterKey(this.data.path, this.data.widthPx));
		if (!raster) {
			// 缓存缺失（换了宽度、或会话恢复后重放）：异步补生成，下一次渲染生效
			void prepare(this.data.path, this.data.widthPx);
			return [
				this.footerStyle(`🖼 ${this.data.alt ?? ""} ${this.data.path} · 正在生成 Sixel…`),
			];
		}

		// Sixel 以 6 像素为一带，补齐到 6 的倍数再换算成终端行
		const pixelRows = Math.ceil(raster.heightPx / 6) * 6;
		const rowsNeeded = Math.max(1, Math.min(MAX_ROWS * 4, Math.ceil(pixelRows / cell.heightPx)));

		// ── 为什么这行必须每帧"看起来变了" ─────────────────────────────────
		// 实测：这台终端的 EL([2K) 会把 Sixel 图形一起擦掉，而 pi 重写任何
		// 一行都是 `[<row>;1H[2K` + 内容。于是流程是：
		//   写图片行（图画出来）→ 紧接着写下面那些预留行（每行都带 EL）→ 图被擦。
		// 图片行内容没变，pi 就认为"这行没变"、不再重发 → 图永远回不来。
		// 所以挂一个每 ~400ms 变化的零宽序列，逼 pi 重发整段 Sixel（图自愈）：
		// 首次画完后那次擦除，最多 400ms 后就被重发修回来。400ms 分桶而不是
		// 每帧都变，是为了 spinner 那种高频重绘下不把 9KB 负载每次都推一遍。
		const bucket = Math.floor(Date.now() / 400);
		const heartbeat = `\x1b]8;;pi-image-view:${bucket}\x07\x1b]8;;\x07`;

		// 顺序很关键：先输出 rowsNeeded-1 个空行，最后才是图片行，并且图片行用
		// 行内上移（\x1b[<n>A）回到这些空行的顶部再画。这样同一帧里 pi 在图片
		// 之后不会再对这些行发 EL(\x1b[2K)——而实测这台终端的 EL 会把 Sixel
		// 图形一起擦掉。倒过来写（图片行在前、空行在后）就必然被擦。
		const lift = rowsNeeded - 1;
		const lines: string[] = [];
		for (let i = 0; i < lift; i++) lines.push("");
		lines.push(
			`${lift > 0 ? `\x1b[${lift}A` : ""}\x1b7${raster.sixel}\x1b8` +
				`\x1b_Gq=2,r=${rowsNeeded};\x1b\\${heartbeat}${lift > 0 ? `\x1b[${lift}B` : ""}`,
		);
		const label = this.data.alt?.trim();
		lines.push(
			this.footerStyle(
				`🖼 ${label ? `${label} · ` : ""}${this.data.path} · ` +
					`${raster.sourceWidth}×${raster.sourceHeight} → ${rowsNeeded} 行 (${width} 列)`,
			),
		);
		return lines;
	}
}