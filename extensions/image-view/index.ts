/**
 * image-view —— 在 pi 里显示本地图片（claude-code image-view mod 的 pi 版）。
 *
 * 只走 Sixel（\x1bP）。Kitty / iTerm2 都试过，在这个 pi 版本 + 实测终端下不可用，
 * 详见 component.ts 顶部说明。
 *
 * 形态：聊天流里留一行可点开的入口，图片本体画在编辑器上方的 widget 里。
 *   - 聊天流 entry 里画不进图：那行会被 sliceByColumn 按内容列宽切断；
 *   - widget 是根级全宽、且能自己占住图覆盖的行，是唯一可靠的载体。
 *
 * 触发方式：
 *   1. read 了一张图片 → 留一行入口；
 *   2. 助手回复里的 Markdown 图片 ![alt](/abs/path.png) → 留一行入口
 *      （pi 自己不会去读本地文件）；
 *   3. 手动 /img <path>，路径前缀 ! 表示强制重新生成。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCellDimensions, Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	DEFAULT_WIDGET_SCALE,
	ImageEntryComponent,
	ImageGalleryComponent,
	ImageViewComponent,
	MAX_WIDGET_SCALE,
	MIN_WIDGET_SCALE,
	canDrawImages,
	describeBranch,
	forgetPinnedPx,
	prewarm,
	type GalleryItem,
	type GalleryState,
} from "./component.ts";


const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|avif|heic|ico)$/i;
const MD_IMAGE = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/g;
const ENTRY_TYPE = "image-view";
const WIDGET_KEY = "image-view-gallery";
/** widget 里最多同时留几张图（它固定在编辑器上方，太多会把编辑器顶出去） */
const MAX_GALLERY = 2;

/** 同一张图只自动出一次（/img 手动不算） */
const shown = new Set<string>();

function resolveLocal(cwd: string, raw: string): string | null {
	let p = raw.replace(/^file:\/\//, "");
	try {
		p = decodeURI(p);
	} catch {
		/* 保持原样 */
	}
	if (/^(https?|data):/i.test(p)) return null;
	const abs = isAbsolute(p) ? p : resolve(cwd, p.replace(/^\.\//, ""));
	return IMAGE_EXT.test(abs) ? abs : null;
}

/** AgentMessage.content 是块数组，也可能是一条纯字符串 */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
				return String((part as { text?: unknown }).text ?? "");
			}
			return "";
		})
		.join("\n");
}

/**
 * 把本地图片的 Markdown 语法换成一行纯文本。
 *
 * pi 的 Markdown 渲染器不会去读本地文件，只会画一个「坏掉的图片图标 +
 * alt 文本」（看着像 bug）。图由我们在下面单独画，所以这里只留一行
 * `🖼 alt · path`，两份信息都在，但不重复、不误导。
 * http(s) 与 data: 图片不动，交给 pi 自己处理。
 */
function stripLocalImageMarkdown(markdown: string, cwd: string): string {
	if (!markdown.includes("![")) return markdown;
	return markdown.replace(MD_IMAGE, (full, alt: string, angled?: string, plain?: string) => {
		const raw = angled ?? plain ?? "";
		if (/^(https?|data):/i.test(raw)) return full;
		const abs = resolveLocal(cwd, raw);
		if (!abs) return full;
		const label = (alt ?? "").trim() || abs.split("/").pop();
		return `\n🖼 ${label} · ${abs}\n`;
	});
}

export default function imageView(pi: ExtensionAPI): void {
	let cwd = process.cwd();
	// 拿到 TUI 实例，唯一用途：插入图片后主动催几次重绘（见 show() 里的注释）
	let tui: { requestRender?: (force?: boolean) => void } | null = null;

	/**
	 * 请求重绘。
	 *
	 * 必须用 Reflect.apply 带上接收者：写成 `rerender(t)` 是把方法
	 * 摘下来裸调用，`this` 变 undefined，而 TuiAltScreen.requestRender 内部要用
	 * `this.scheduleRender()` → 每次调用都抛 TypeError。它发生在 setInterval /
	 * async 里，异常被吞掉，表现为"点了没反应、心跳形同虚设"。
	 */
	function rerender(t?: { requestRender?: (force?: boolean) => void } | null) {
		const target = t ?? tui;
		const fn = target?.requestRender;
		if (!fn || !target) return;
		try {
			Reflect.apply(fn, target, [true]);
		} catch {
			/* 重绘失败不该影响交互本身 */
		}
	}
	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		lastCtx = ctx;
		// setWidget 的 factory 拿到当前 TUI 实例：这是拿到渲染状态的唯一途径
		ctx.ui.setWidget("image-view-probe", (t) => {
			tui = t;
			return { render: () => [], invalidate: () => {} };
		});
		ctx.ui.setWidget("image-view-probe", undefined);
	});

	// pi 不会加载本地图片，Markdown 里那份只留文字说明
	pi.registerMarkdownTransformer((markdown) => stripLocalImageMarkdown(markdown, cwd));

	pi.registerEntryRenderer<{ path: string; alt?: string }>(ENTRY_TYPE, (entry, _opts, theme) => {
		const data = entry.data;
		if (!data?.path) return new Text(theme.fg("muted", "🖼 (image-view: 数据缺失)"), 0, 0);
		// 只留一行入口，图片本体在 widget 里画（聊天流 entry 里负载会被
		// sliceByColumn 按内容列宽切断，见 sixelPixelBudget 的注释）。
		const state = entryExpanded.get(data.path) ?? { value: false };
		entryExpanded.set(data.path, state);
		return new ImageEntryComponent({ path: data.path, alt: data.alt }, state, {
			onToggle: () => {
				state.value = !state.value;
				galleryState.expanded = state.value;
				const ctx = lastCtx;
				if (!ctx) return;
				if (state.value) {
					gallery = [{ path: data.path, alt: data.alt }];
					galleryClosed = false;
					mountGallery(ctx);
					void expandAndRender(ctx, tui ?? undefined);
				} else {
					gallery = [];
					ctx.ui.setWidget(WIDGET_KEY, undefined);
					stopImageHeartbeat();
				}
				rerender();
			},
		});
	});

	let gallery: GalleryItem[] = [];
	/** 折叠状态与"手动关掉"状态都留在闭包里，重绘时复用 */
	let galleryClosed = false;
	/** 折叠 / 缩放状态：与组件共享同一个对象，回调改这里，重绘立刻生效 */
	const galleryState: GalleryState = { expanded: false, scale: DEFAULT_WIDGET_SCALE };
	/** 对话流入口的展开状态：path → 共享状态对象（组件重绘复用同一实例，必须共享） */
	const entryExpanded = new Map<string, { value: boolean }>();
	/** 最近一次会话上下文：entry 渲染器是同步的，拿不到 ctx，需要留一份 */
	let lastCtx: ExtensionContext | null = null;

	/** 展开时才生成 Sixel，然后开启心跳并重绘 */
	async function expandAndRender(
		ctx: ExtensionContext,
		t: { requestRender?: (f?: boolean) => void } | undefined,
	) {
		for (const item of gallery) {
			forgetPinnedPx(item.path);
			await prewarm(item.path, true, galleryState.scale);
		}
		startImageHeartbeat();
		rerender(t);
	}

	/**
	 * 改变缩放：像素宽变了就必须按新宽度重新生成 Sixel，并清掉 pinnedPx
	 * （它缓存的是"这张图用哪个宽度"的决定，不重新钉住的话 render 会拿旧值）。
	 */
	async function applyScale(ctx: ExtensionContext, t: { requestRender?: (f?: boolean) => void }, next: number) {
		const clamped = Math.max(MIN_WIDGET_SCALE, Math.min(MAX_WIDGET_SCALE, next));
		if (clamped === galleryState.scale) return;
		galleryState.scale = clamped;
		if (galleryState.expanded) {
			for (const item of gallery) {
				forgetPinnedPx(item.path);
				await prewarm(item.path, true, clamped);
			}
		}
		mountGallery(ctx);
		rerender(t);
	}

	/** 重建 widget；关闭后不再重挂，直到 /img 再次插入 */
	function mountGallery(ctx: ExtensionContext) {
		if (galleryClosed || gallery.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, (t, theme) => {
			tui = t;
			return new ImageGalleryComponent(gallery, theme, galleryState, {
				onZoom: (factor) => {
					void applyScale(ctx, t, galleryState.scale * factor);
				},
				onResetZoom: () => {
					void applyScale(ctx, t, DEFAULT_WIDGET_SCALE);
				},
				onClose: () => {
					galleryClosed = true;
					gallery = [];
					galleryState.expanded = false;
					ctx.ui.setWidget(WIDGET_KEY, undefined);
					stopImageHeartbeat();
					rerender(t);
				},
				onToggle: () => {
					// 共享状态：直接改，实例下次 render 就读到新值
					galleryState.expanded = !galleryState.expanded;
					if (galleryState.expanded) {
						// 展开：这时才开始生成 Sixel，并启动心跳（图形需要周期重发）
						void expandAndRender(ctx, t);
					} else {
						stopImageHeartbeat();
						rerender(t);
					}
				},
			});
		});
	}

	async function show(ctx: ExtensionContext, path: string, alt: string, refresh = false) {
		if (!existsSync(path)) {
			ctx.ui.notify(`image-view: 文件不存在 ${path}`, "warning");
			return false;
		}
		if (!canDrawImages()) {
			ctx.ui.notify("image-view: 本终端无法显示图片", "warning");
			return false;
		}

		// 投递方式：聊天流里只留一行入口（点开才在 widget 中绘制）。
		// 聊天流 entry 里画不进图 —— 那行会被 sliceByColumn 按内容列宽切断
		// （见 sixelPixelBudget 的注释），只有根级全宽的 widget 能完整写出。
		forgetPinnedPx(path);
		pi.appendEntry(ENTRY_TYPE, { path, alt: alt || undefined });
		return true;
	}

	/**
	 * 常驻心跳：让 pi 定期重绘，把被 EL 擦掉的图刷回来。
	 *
	 * 为什么必须常驻而不是只在插入后催几次：实测这台终端的 EL(\x1b[2K) 会把
	 * Sixel 图形一起擦掉，而 pi 重写任何一行都是 `\x1b[<row>;1H\x1b[2K` + 内容。
	 * 图先被正常画出来，之后任意一帧（滚动、聊天区刷新、窗口变化）重写它覆盖
	 * 的行就把它擦掉；而图片行内容没变，pi 判定"没变"就不重发 → 图停在空白。
	 * 组件那边给图片行挂了每 400ms 变化的零宽标记（heartbeat），只要 pi 渲染
	 * 一次就会重发整段 Sixel；这里负责"让 pi 渲染"这件事，周期取 500ms：
	 * 擦除后最多半秒就自愈，而重发 9KB 负载的频率仍远低于 spinner。
	 */
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	function startImageHeartbeat() {
		if (heartbeat) return;
		heartbeat = setInterval(() => rerender(), 500);
	}
	function stopImageHeartbeat() {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
	}
	pi.on("session_shutdown", async () => {
		stopImageHeartbeat();
	});

	// 1) 回复里的 Markdown 图片：pi 不会去读本地文件，任何协议下都补画
	pi.on("message_end", async (event, ctx) => {
		const message = event.message as { role?: string; content?: unknown };
		if (message.role !== "assistant") return;
		const text = textOf(message.content);
		if (!text.includes("![")) return;
		const found = [...text.matchAll(MD_IMAGE)]
			.map((m) => ({ alt: (m[1] ?? "").trim(), path: resolveLocal(ctx.cwd, m[2] ?? m[3] ?? "") }))
			.filter((m): m is { alt: string; path: string } => Boolean(m.path));
		for (const m of found) {
			if (shown.has(m.path)) continue;
			shown.add(m.path);
			await show(ctx, m.path, m.alt);
		}
	});

	// 2) read 图片：在对话流里留一个展开入口
	//
	// 不再判断"pi 自己会不会画"：pi 只在 terminal.showImages 开启时才渲染工具
	// 结果里的图，而且画在工具卡片内部，与"对话流里留一行可点开的入口"不符。
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || event.toolName !== "read") return;
		const raw = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof raw !== "string") return;
		const abs = resolveLocal(ctx.cwd, raw);
		if (!abs || shown.has(abs)) return;
		shown.add(abs);
		await show(ctx, abs, "");
	});


	// Sixel 自检：同一张图、四种包装，一次定位问题层次
	// Sixel 兜底开关

	// 当前协议 / 判定依据
	pi.registerCommand("img-info", {
		description: "显示 image-view 当前使用的图片协议与判定依据：/img-info",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const env = (k: string) => process.env[k] ?? "—";
			const cell = getCellDimensions();
			ctx.ui.notify(
				[
					`协议: ${describeBranch()}`,
					`Sixel 声明(PI_IMAGE_VIEW_SIXEL): ${env("PI_IMAGE_VIEW_SIXEL")}`,
					`协议覆盖(PI_IMAGE_PROTOCOL): ${env("PI_IMAGE_PROTOCOL")}`,
					`TERM: ${env("TERM")} / TERM_PROGRAM: ${env("TERM_PROGRAM")}`,
					`WEBTERM_SESSION: ${env("WEBTERM_SESSION")} / TMUX: ${env("TMUX")} / STY: ${env("STY")}`,
					`尺寸: ${process.stdout.columns ?? "?"} 列, 单元格 ${cell.widthPx}×${cell.heightPx}px`,
				].join("\n"),
				"info",
			);
		},
	});

	// 3) 手动出图
	pi.registerCommand("img", {
		description: "在终端里显示本地图片：/img <path>（加 ! 前缀强制刷新）",
		handler: async (args: string, ctx: ExtensionContext) => {
			const arg = args.trim();
			const refresh = arg.startsWith("!");
			const tokens = (refresh ? arg.slice(1).trim() : arg).split(/\s+/);
			const raw = tokens[0] ?? "";
			// 可选第二个参数：目标像素宽（覆盖按终端列宽自动算出的值）
			const widthArg = tokens[1] !== undefined ? Number(tokens[1]) : undefined;
			if (!raw) {
				ctx.ui.notify("用法：/img <图片路径> [目标像素宽]", "warning");
				return;
			}

			const path = resolveLocal(ctx.cwd, raw);
			if (!path) {
				ctx.ui.notify(`image-view: 不支持的图片路径 ${raw}`, "warning");
				return;
			}
			await show(ctx, path, "", refresh);
		},
	});

	// 让模型知道交付图片的方式
	pi.on("before_agent_start", async (event) => {
		const hint =
			"\n\n# 图片交付（重要）\n\n" +
			"当你需要把本地图片交给用户看（自己画的图表、截图、生成的图片）时，在回复里用 Markdown 图片语法引用本地绝对路径，" +
			"例如 `![p95 latency](/abs/path/chart.png)`。终端会直接把这张图画在消息下方；" +
			"已经用 read 读过的图片会自动显示，不要重复内嵌。";
		if (event.systemPrompt.includes("# 图片交付")) return;
		return { systemPrompt: event.systemPrompt + hint };
	});
}