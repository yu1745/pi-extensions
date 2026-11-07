/**
 * 给译文加一个「这是翻译」的视觉标记。
 *
 * 为什么不能整块改色：pi 把 thinking 块整块用 `theme.fg("thinkingText", …)`（灰）包住，
 * 扩展没法换这个颜色。但 Markdown 内部的结构色是 theme 自己上的、会盖过外层灰：
 *   - 行内代码 `` `x` `` → mdCode（dark 主题是 violet）
 *   - 标题 `#### x`   → mdHeading（yellow）
 *   - 引用 `> x`       → mdQuote（muted，和正文灰几乎一样，仅作边框用）
 * 所以用一行带颜色的标记最稳，不改正文、不注入 ANSI、不会破坏 Markdown 结构。
 */

export type MarkerStyle = "code" | "heading" | "quote" | "none";

export const MARKER_STYLES: readonly MarkerStyle[] = ["code", "heading", "quote", "none"];

/** 把标记行渲染成某种 Markdown 结构，颜色由 pi 的主题决定 */
export function markerLine(label: string, style: MarkerStyle): string {
	if (!label.trim()) return ""; // 标记文字为空 = 关掉标记
	switch (style) {
		case "code":
			return `\`${label}\``;
		case "heading":
			return `#### ${label}`;
		case "quote":
			return `> ${label}`;
		case "none":
			return "";
	}
}

/** 译文 + 标记；标记为空时原样返回 */
export function withMarker(translation: string, label: string, style: MarkerStyle): string {
	const line = markerLine(label, style);
	if (!line) return translation;
	return `${line}\n\n${translation}`;
}
