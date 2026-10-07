/**
 * 图片组件：只走 Sixel（\x1bP）。
 *
 * 为什么不做 Kitty/iTerm2：都试过，在这个 pi + 本终端的组合下不可用 ——
 * Kitty 序列能完整写出（原始字节流确认），但画出来只剩顶上一条；本终端的
 * EL(\x1b[2K) 会连图形一起擦掉，而 pi 逐行重写预留行必然发 EL，重发序列
 * 也救不回来（同一 image id 不会重画）。Sixel 这条路已验证可用，就只留它。
 *
 * 参考：../sixel-image 里 quota-footer 验证过的那套「DECSC 包裹 + 零宽 Kitty
 * 占位 + 预留行 + 心跳标记」手法。
 */

import {
	getCellDimensions,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	knownActualWidth,
	prepare,
	SixelImageComponent,
	targetWidthPx,
} from "../sixel-image/component.ts";

/**
 * pi 的 Theme 类型在 coding-agent 内部，pi-tui 只导出渲染器真正用到的最小面。
 * 这里只声明用到的方法，pi 传进来的 Theme 天然兼容。
 */
export interface ImageViewTheme {
	fg(color: string, text: string): string;
}

export interface ImageViewData {
	path: string;
	alt?: string;
	/**
	 * 是否挂在根级 widget 里。
	 * 只有根级 widget 的盒子是全宽的、不经过会被 sliceByColumn 切断的那条路径；
	 * 聊天流 entry 里六像素负载必然被切（详见 sixelPixelBudget 注释）。
	 */
	widget?: boolean;
	/** 只对 widget 生效：相对"铺满宽度"的缩放倍率（1 = 铺满） */
	scale?: number;
}

/**
 * 每张图选定（已生成）的负载宽度。
 *
 * prewarm() 与 Component.render() 是两处独立的代码，各自"按终端列宽算一遍"
 * 很容易算出不同值（widget 传入的 width 与 process.stdout.columns 未必相等），
 * 结果缓存未命中、图上只出现"正在生成 Sixel…"占位。所以宽度由 prewarm 定下、
 * render 复用同一个值。
 */
const pinnedPx = new Map<string, number>();

function pxFor(path: string, compute: () => number): number {
	const pinned = pinnedPx.get(path);
	if (pinned !== undefined) return pinned;
	const px = compute();
	pinnedPx.set(path, px);
	return px;
}

/**
 * widget 里默认铺满可用宽度。
 *
 * 这里曾经是 1/3 —— 那是一次意外产物：六像素图还在聊天流里时，为了躲开
 * sliceByColumn 的截断，宽度预算被压成"内容列数 × 1 像素"（约屏宽 1/3），
 * 后来图改到 widget 显示、不再受那个限制，却把当时的宽度固化成了默认值。
 * 默认就该是"能多宽就多宽"，嫌大再缩小。
 */
export const DEFAULT_WIDGET_SCALE = 1;
export const MIN_WIDGET_SCALE = 1 / 8;
export const MAX_WIDGET_SCALE = 1;
export const WIDGET_SCALE_STEP = 1.5;

/**
 * widget 里图片的像素宽。
 *
 * 语义要清楚：scale=1 表示"铺满可用宽度"，而可用宽度本身有 MAX_IMAGE_PX 上限
 * （控制 convert 开销与 Sixel 负载体积）。所以先把可用宽度钉到上限内（maxPx），
 * 再乘比例——顺序颠倒（先乘再截断）会做出"75% 和 100% 一样宽、点 + 没反应"
 * 的假缩放。
 *
 * 另外 pixel → 列的换算必须用同一个函数（见 contentCells），否则按钮位置和
 * 图片实际宽度会分叉。
 */
/**
 * 可用宽度上限。
 *
 * 直接铺满终端像素宽（270 列 × 9px ≈ 2430px）会让每帧重发的 Sixel 负载过大：
 * 500ms 心跳每次都把整段负载推给终端，大图能到 MB 级。2000px 是"够清晰"与
 * "心跳别太贵"之间的折中；源图小于它就按源图（convert 的 `-resize Wx>` 只缩不放）。
 */
export const MAX_IMAGE_PX = 2000;

export function availablePixelWidth(columns: number): number {
	const cell = getCellDimensions();
	return Math.max(64, Math.min(MAX_IMAGE_PX, Math.round(Math.max(20, columns) * cell.widthPx)));
}

export function widgetPixelWidth(scale: number, columns: number): number {
	return Math.max(64, Math.round(availablePixelWidth(columns) * scale));
}

export function forgetPinnedPx(path?: string) {
	if (path) pinnedPx.delete(path);
	else pinnedPx.clear();
}

/**
 * 这个终端能不能画图。
 *
 * 能力判定**只依赖当前进程的环境**（也就是终端自己），所以按 client 隔离：
 * 同一台机器上开多个终端各自独立，不存在互相污染。
 *
 * 这里曾经有一个自定义的持久开关（~/.cache/pi-image-view-sixel）。那是错的：
 * 它把"终端能力"存成了跨终端共享的全局状态（A 里关掉，B 也一起关）。
 *
 * 判定顺序：
 *   1. `PI_IMAGE_VIEW_SIXEL=0`（按终端声明）→ 不画；
 *   2. `PI_IMAGE_PROTOCOL=none`（pi 官方按进程开关）→ 不画；
 *   3. 其余情况都当这台终端认 Sixel。
 *
 * Sixel 没法可靠探测（终端不回、或干脆默默吞掉整段序列都有），所以用"按终端
 * 声明"而不是探测；开关走环境变量，随终端进程走，同机多开终端互不影响。
 */
export function canDrawImages(): boolean {
	try {
		if (process.env.PI_IMAGE_PROTOCOL?.toLowerCase() === "none") return false;
		const flag = process.env.PI_IMAGE_VIEW_SIXEL?.toLowerCase();
		return !(flag === "0" || flag === "off" || flag === "false");
	} catch {
		return true;
	}
}

/**
 * 当前生效的分支，供 /img-info 显示。
 *
 * 注意：这里的转义序列必须写成可读文本（`ESC _G` 而不是真的 ESC 字节），
 * 否则提示框自己会被当成转义序列解析、整行断掉（之前的 bug）。
 */
export function describeBranch(): string {
	if (process.env.PI_IMAGE_PROTOCOL?.toLowerCase() === "none") return "已禁用（PI_IMAGE_PROTOCOL=none）";
	const flag = process.env.PI_IMAGE_VIEW_SIXEL?.toLowerCase();
	if (flag === "0" || flag === "off" || flag === "false") return "已禁用（PI_IMAGE_VIEW_SIXEL=0）";
	return "Sixel（ESC P）";
}

/** 事件处理器里提前备好 Sixel；返回是否可用 */
export async function prewarm(
	path: string,
	forWidget = false,
	scale = DEFAULT_WIDGET_SCALE,
): Promise<boolean> {
	const columns = process.stdout.columns ?? 100;
	const target = forWidget ? widgetPixelWidth(scale, columns) : targetWidthPx(columns, false);
	pinnedPx.set(path, target);
	return Boolean(await prepare(path, target));
}

export class ImageViewComponent implements Component {
	private data: ImageViewData;
	private theme: ImageViewTheme;

	constructor(data: ImageViewData, theme: ImageViewTheme) {
		this.data = data;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { path } = this.data;
		const dim = (t: string) => this.theme.fg("muted", t);
		// 宽度必须由 prewarm() 钉住，render 复用同一个值：两处各自"按终端列宽
		// 算一遍"会算出不同结果（widget 传入的 width 与 process.stdout.columns
		// 未必相等），导致缓存未命中、图上只剩"正在生成 Sixel…"占位行。
		const widthPx = pxFor(path, () =>
			this.data.widget
				? widgetPixelWidth(this.data.scale ?? DEFAULT_WIDGET_SCALE, process.stdout.columns ?? width)
				: targetWidthPx(process.stdout.columns ?? width, false),
		);
		return new SixelImageComponent({ path, alt: this.data.alt, widthPx }, dim).render(width);
	}

	private label(): string {
		const alt = this.data.alt?.trim();
		return alt ? `${alt} · ` : "";
	}
}

/**
 * 多张图的 widget 画廊。
 *
 * 为什么 Sixel 走 widget 而不是聊天流 entry：
 *   - 聊天区盒子比终端窄（滚动条占一列），行会走 compositeTuiLine()，其末尾的
 *     sliceByColumn(line, 0, 内容列宽) 会把六像素负载切断（负载字符数远超内容
 *     列宽），终端拿到未终止的 DCS 直接丢弃 → 只剩"上半截"；
 *   - widget 挂根级、盒子全宽，不走那条切片路径，负载能完整写出（本地实测
 *     8896 字节全写出，且每帧重发）。
 *
 * widget 只能显示"最新若干张"：它是编辑器上方的固定区域，不参与聊天流滚动。
 * 这是 Sixel 在这套渲染模型下的取舍：要么图被切，要么不随聊天流滚动。
 */
export interface GalleryItem {
	path: string;
	alt?: string;
}

/**
 * 图片画廊 widget（编辑器上方）。交互：
 *   - 点击右上角 ✕ → 关闭（清空 widget）；
 *   - 点击其它任何位置 → 折叠 / 展开。
 *
 * 为什么需要它是"多行"的：Sixel 图只会画在写入它的那一行往下、覆盖若干行，
 * 那些行若归别的组件所有（编辑器每帧都在重写自己），图就会被 EL(\x1b[2K)
 * 擦掉。所以 widget 必须自己占住这些行 —— header + 每张图的图片行 + 预留空行。
 */
interface GalleryHandlers {
	onClose: () => void;
	onToggle: () => void;
	/** delta 为倍率（>1 放大，<1 缩小） */
	onZoom: (factor: number) => void;
	onResetZoom: () => void;
}

/**
 * 画廊的可变状态。
 *
 * 必须是**共享对象**而不是构造参数快照：pi 重绘时用的是同一个组件实例
 * （setWidget 只在重新挂载时才造新组件），所以折叠/缩放如果按值传进构造函数，
 * 回调里改了状态、实例里还是旧值 —— 表现就是"点了折叠没反应"。
 */
export interface GalleryState {
	/** 是否展开显示图片本体。默认 false —— 只有用户点了"展开图片"才真正绘制。 */
	expanded: boolean;
	scale: number;
}

export class ImageGalleryComponent implements Component {
	private items: GalleryItem[];
	private theme: ImageViewTheme;
	private state: GalleryState;
	private handlers: GalleryHandlers;
	/** header 上各按钮的列区间，render 时回填，供鼠标命中测试 */
	private buttonRanges: { start: number; end: number; action: keyof GalleryHandlers }[] = [];
	/** 每张图占的行数，render 时回填 */
	private rowSpans: number[] = [];

	constructor(items: GalleryItem[], theme: ImageViewTheme, state: GalleryState, handlers: GalleryHandlers) {
		this.items = items;
		this.theme = theme;
		this.state = state;
		this.handlers = handlers;
	}

	invalidate(): void {}

	/**
	 * 图片在当前缩放下占用的列数（控件对齐到它的右边缘）。
	 *
	 * 必须和 widgetPixelWidth() 同源：图片宽度是"像素宽"（且有 1600px 上限），
	 * 若这里按 `列数 × scale` 线性算，一旦缩放把像素宽顶到上限，两者就分叉
	 * ——图片实际没那么宽，按钮却被推到更右边（放大一次后按钮跑飞的 bug）。
	 */
	private contentCells(width: number): number {
		const cell = getCellDimensions();
		const columns = process.stdout.columns ?? width;
		const px = widgetPixelWidth(this.state.scale, columns);
		return Math.max(24, Math.min(width, Math.round(px / Math.max(1, cell.widthPx))));
	}

	/** 右侧按钮串 + 每个按钮的列区间（相对串首） */
	private buildButtons(): { text: string; ranges: { offset: number; length: number; action: keyof GalleryHandlers }[] } {
		const dim = (t: string) => this.theme.fg("muted", t);
		const hot = (t: string) => this.theme.fg("accent", t);
		const parts: { label: string; action: keyof GalleryHandlers; accent?: boolean }[] = [
			{ label: " − ", action: "onZoom" }, // 缩小由 index 侧按 factor 处理
			{ label: " + ", action: "onZoom" },
			{ label: ` ${Math.round(this.state.scale * 100)}% `, action: "onResetZoom" },
			{ label: " ✕ ", action: "onClose", accent: true },
		];
		let offset = 0;
		let text = "";
		const ranges: { offset: number; length: number; action: keyof GalleryHandlers }[] = [];
		for (const [i, part] of parts.entries()) {
			if (i > 0) {
				text += " ";
				offset += 1;
			}
			const rendered = part.accent ? hot(part.label) : dim(part.label);
			text += rendered;
			ranges.push({ offset, length: part.label.length, action: part.action });
			offset += part.label.length;
		}
		return { text, ranges };
	}

	private headerLines(width: number): string[] {
		const count = this.items.length;
		const action = this.state.expanded ? "点击折叠" : "点击展开";
		const left = `🖼 图片 ${count} 张 · ${action}`;
		const { text, ranges } = this.buildButtons();
		// 必须用 visibleWidth 而不是 .length：theme.fg() 会插入 ANSI 转义序列，
		// 用 .length 会把颜色码算成列宽，padding 偏短 → 按钮停不到图片右边缘，
		// 同时命中区也随之偏移（点 ✕ 打不开、点空白却关闭）。
		const textW = visibleWidth(text);
		const contentW = this.contentCells(width);
		// 按钮贴的是**图片的右边缘**，不是终端右边缘：图只占 1/3 宽时，把按钮
		// 甩到终端最右边会隔着两百多列，操作对象和操作控件分离。
		// 空间不够就逐级降级：完整说明 → 只留图标 → 只留按钮。
		let label = left;
		let leftW = visibleWidth(label);
		if (leftW + textW + 1 > contentW) {
			label = "🖼";
			leftW = visibleWidth(label);
		}
		if (leftW + textW + 1 > contentW) {
			label = "";
			leftW = 0;
		}
		const pad = Math.max(0, contentW - leftW - textW);
		const line = (label ? this.theme.fg("muted", label) : "") + " ".repeat(pad) + text;
		// 命中区换算成绝对列：按钮串右对齐
		const startCol = leftW + pad;
		this.buttonRanges = ranges.map((r) => ({
			start: startCol + r.offset,
			end: startCol + r.offset + r.length,
			action: r.action,
		}));
		return [line];
	}

	render(width: number): string[] {
		const lines = this.headerLines(width);
		this.rowSpans = [];
		// 默认只出这一行 header；用户点了"展开图片"才真正绘制图片本体。
		if (this.state.expanded) {
			for (const item of this.items) {
				const start = lines.length;
				const img = new ImageViewComponent(
					{ path: item.path, alt: item.alt, widget: true, scale: this.state.scale },
					this.theme,
				);
				lines.push(...img.render(width));
				this.rowSpans.push(lines.length - start);
			}
		}
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// 只认 "click"。pi 一次点击会先发 "press" 再发 "click"，两个都处理等于
		// 执行两遍 —— 折叠会被自己抵消（表现为"展开只闪一下就回去"），缩放会
		// 一步跳两级，✕ 也会被连续触发。
		if (event.type !== "click") return undefined;
		if (event.y === 0) {
			for (const r of this.buttonRanges) {
				if (event.x >= r.start && event.x < r.end) {
					if (r.action === "onZoom") {
						// − 在 + 左边：以按钮位置区分放大/缩小
						this.handlers.onZoom(r.start === this.buttonRanges[0]?.start ? 1 / WIDGET_SCALE_STEP : WIDGET_SCALE_STEP);
					} else {
						this.handlers[r.action]();
					}
					return { handled: true, render: true };
				}
			}
			// 按钮串内部的空隙：不响应，避免点偏一点就误折叠
			const btnStart = this.buttonRanges[0]?.start ?? Number.POSITIVE_INFINITY;
			if (event.x >= btnStart) return { handled: true };
			// header 左侧空白：折叠 / 展开
			this.handlers.onToggle();
			return { handled: true, render: true };
		}
		this.handlers.onToggle();
		return { handled: true, render: true };
	}
}


/**
 * 对话流里的「展开图片」入口。
 *
 * 为什么展开后不在原位画图：聊天区盒子比终端窄一列（滚动条占一列），那行会走
 * layout 的 compositeTuiLine()，末尾 sliceByColumn(line, 0, 内容列宽) 会把 Sixel
 * 负载切断（pi 的 visibleWidth 把负载每个字符都算一列，实测 8896 字符 → 只剩
 * ~270），终端拿到未终止的 DCS 就整段丢弃。而展开必然占十几行、必然把内容顶到
 * 超出视口，所以聊天流内绘制没有可用宽度。widget 是根级全宽，唯一可靠的位置。
 *
 * 入口本身只有一行，且会保持在这个位置随聊天滚动 —— 这是对话流该有的样子。
 */
export class ImageEntryComponent implements Component {
	private data: { path: string; alt?: string };
	private expanded: { value: boolean };
	private handlers: { onToggle: () => void };

	constructor(
		data: { path: string; alt?: string },
		expanded: { value: boolean },
		handlers: { onToggle: () => void },
	) {
		this.data = data;
		this.expanded = expanded;
		this.handlers = handlers;
	}

	invalidate(): void {}

	render(width: number): string[] {
		// 用 visibleWidth 截断（不是 .length）：路径里可能有宽字符
		const prefix = this.expanded.value ? "🖼 收起图片" : "🖼 展开图片";
		const label = this.data.alt?.trim();
		const text = `${prefix} · ${label ? `${label} · ` : ""}${this.data.path}`;
		return [truncateToWidth(text, Math.max(1, width), "")];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// 只认 click：pi 一次点击会先发 press 再发 click，两个都处理会执行两遍
		if (event.type !== "click") return undefined;
		this.handlers.onToggle();
		return { handled: true, render: true };
	}
}
