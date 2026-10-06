/**
 * image-view —— 在 pi 聊天流里直接显示本地图片（claude-code image-view mod 的 pi 版）。
 *
 * 协议优先级（终端支持谁就用谁）：
 *   Kitty (\x1b_G) → iTerm2 (\x1b]1337) → Sixel (\x1bP) → 文本占位
 * 前两种复用 pi-tui 的 `Image` 组件；Sixel 是自绘兜底（pi-tui 不认 sixel）。
 *
 * 触发方式：
 *   1. 助手回复里的 Markdown 图片 ![alt](/abs/path.png) → 消息下方出图
 *      （pi 自己不会去读本地文件，这条任何协议下都需要）；
 *   2. read 了一张图片 → 仅当 pi 没有原生图片协议时自动出图，否则会和
 *      pi 自带的渲染重复；
 *   3. 手动 /img <path>，加 ! 强制重新生成（图片被改写后用）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Text } from "@earendil-works/pi-tui";
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
	forgetPinnedPx,
	prewarm,
	type GalleryItem,
	type GalleryState,
} from "./component.ts";
import { invalidateImage } from "./prepare.ts";

import { setSixelEnabled, sixelEnabled } from "./sixel-flag.ts";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|avif|heic|ico)$/i;
const MD_IMAGE = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/g;
const ENTRY_TYPE = "image-view";
const WIDGET_KEY = "image-view-gallery";
/** widget 里最多同时留几张图（它固定在编辑器上方，太多会把编辑器顶出去） */
const MAX_GALLERY = 2;

/** 同一张图只自动出一次（/img 手动不算） */
const shown = new Set<string>();

/** pi 原生能画图（kitty/iTerm2）时为 true */
function nativeImageSupport(): boolean {
	try {
		return getCapabilities().images !== null;
	} catch {
		return false;
	}
}

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


	// 实验：把图挂在 widget 里（root 级挂载，x=0 全宽），验证「快路径」假设


	// pi 不会加载本地图片，Markdown 里那份只留文字说明
	pi.registerMarkdownTransformer((markdown) => stripLocalImageMarkdown(markdown, cwd));

	pi.registerEntryRenderer<{ path: string; alt?: string }>(ENTRY_TYPE, (entry, _opts, theme) => {
		const data = entry.data;
		if (!data?.path) return new Text(theme.fg("muted", "🖼 (image-view: 数据缺失)"), 0, 0);
		if (!usesSixel()) {
			// Kitty / iTerm2：直接在原位画（负载走协议本身，不吃列宽）
			return new ImageViewComponent({ path: data.path, alt: data.alt }, theme);
		}
		// Sixel：对话流里只放一行入口，展开状态按 path 记在闭包里，重绘时复用
		const state = entryExpanded.get(data.path) ?? { value: galleryState.expanded };
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

	/** 当前是否走 Sixel（无 Kitty/iTerm2 且 Sixel 兜底开着） */
	function usesSixel(): boolean {
		try {
			return getCapabilities().images === null;
		} catch {
			return false;
		}
	}

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
			// 不画就别占行：预占十几行空行会把页脚顶飞，比不显示更糟
			ctx.ui.notify(
				"image-view: 本终端无法显示图片（无 Kitty/iTerm2，且 Sixel 兜底已用 `/img-sixel off` 关闭）",
				"warning",
			);
			return false;
		}
		if (refresh) invalidateImage(path);

		// Sixel 走 widget：聊天流 entry 里负载必然被 sliceByColumn 切断（见
		// sixelPixelBudget 的注释），只有根级全宽的 widget 能完整写出。
		if (usesSixel()) {
			// 两步走：对话流里留一个「展开图片」入口（像 claude-code 的 image-view
			// mod），展开后图显示在 widget 里 —— 聊天流内没法完整画 Sixel（见
			// ImageEntryComponent 的注释）。
			forgetPinnedPx(path);
			pi.appendEntry(ENTRY_TYPE, { path, alt: alt || undefined });
			return true;
		}

		// Kitty / iTerm2 走聊天流 entry（它们的负载走协议本身，不吃列宽）
		const ok = await prewarm(path);
		if (!ok) {
			ctx.ui.notify(`image-view: 无法准备 ${path}`, "error");
			return false;
		}
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

	// 2) read 图片：仅在 pi 没有原生图片协议时自动补（否则重复）
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || event.toolName !== "read") return;
		if (nativeImageSupport()) return;
		const raw = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof raw !== "string") return;
		const abs = resolveLocal(ctx.cwd, raw);
		if (!abs || shown.has(abs)) return;
		shown.add(abs);
		await show(ctx, abs, "");
	});


	// Sixel 自检：同一张图、四种包装，一次定位问题层次
	// Sixel 兜底开关
	pi.registerCommand("img-sixel", {
		description: "开关 image-view 的 Sixel 兜底：/img-sixel on|off（默认 on）",
		handler: async (args: string, ctx: ExtensionContext) => {
			const arg = args.trim().toLowerCase();
			if (arg !== "on" && arg !== "off") {
				ctx.ui.notify(
					`image-view: Sixel 兜底当前 ${sixelEnabled() ? "开" : "关"}（/img-sixel on|off）`,
					"info",
				);
				return;
			}
			setSixelEnabled(arg === "on");
			ctx.ui.notify(
				arg === "on"
					? "image-view: Sixel 兜底已开"
					: "image-view: Sixel 兜底已关（Kitty/iTerm2 不可用时将不显示图片）",
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