/**
 * thinking-translate —— 思考内容自动翻译。
 *
 * 行为：模型吐出的 thinking（CoT）如果「英文占比」超过阈值，就送去一个便宜的
 * 模型翻成中文，然后把**显示**换成译文；会话上下文里的原文一个字都不改。
 *
 * 关键实现点：
 *  - 只走 `registerMarkdownTransformer`（display-only），不碰 message.content，
 *    所以不污染上下文、不影响缓存前缀、不改变后续 turn 的输入；
 *  - transformer 是同步的、每次渲染都会调用，所以译文必须**提前**算好放进
 *    「原文 → 译文」的 Map，transformer 只做一次 Map 查找（key 用 pi 渲染器
 *    的拼法：连续 thinking 块 trim 后用 "\n\n" 连接，见 runs.ts）；
 *  - 在 `thinking_end` / `message_end` 触发翻译。`message_end` 是扩展先跑、
 *    UI 后渲染，所以在这里有界等待（finalizeWaitMs）能保证最终那一帧就是译文。
 *
 * 默认关闭：按快捷键或 `/thinking-translate on` 打开。
 */

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, persistEnabled, type ThinkingTranslateConfig } from "./config.ts";
import { decideTranslate } from "./detect.ts";
import { pickShortcut, type KeybindingConfig, type ShortcutPick } from "./keys.ts";
import { withMarker } from "./marker.ts";
import { thinkingRuns } from "./runs.ts";
import { TranslationStore, translationKey } from "./store.ts";
import { assistantText, rankTranslateModels, translateMarkdown } from "./translate.ts";

const STATUS_KEY = "thinking-translate";
const PROBE_WIDGET = "thinking-translate-probe";
const COMMAND = "thinking-translate";

type RerenderTarget = {
	requestRender?: (force?: boolean) => void;
	invalidate?: () => void;
};

function agentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), CONFIG_DIR_NAME, "agent");
}

function readUserKeybindings(dir: string): KeybindingConfig {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, "keybindings.json"), "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as KeybindingConfig) : {};
	} catch {
		return {};
	}
}

function boundedWait(tasks: Promise<unknown>, ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		void tasks.finally(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}

function describeRejections(pick: ShortcutPick): string {
	return pick.rejected.map((item) => `${item.key}（已被 ${item.owner} 占用）`).join("、");
}

export default function thinkingTranslate(pi: ExtensionAPI): void {
	const dir = agentDir();
	const { config, problem } = loadConfig(dir);
	const userKeys = readUserKeybindings(dir);
	const pick = pickShortcut(config.shortcuts, userKeys);

	let enabled = config.enabled;
	/**
	 * 译文缓存：key 是原文的 sha1，跟着会话 jsonl 旁边的 sidecar 文件夹走。
	 * `--no-session` 等没有 session 文件的场景退化成纯内存。
	 */
	const store = new TranslationStore();
	/** 判定为不需要翻译 / 翻译失败的 run（同样按 sha1），避免重复判定和重复花钱 */
	const skipped = new Set<string>();
	const inflight = new Map<string, Promise<void>>();
	/** 串行化模型调用：同一时刻只发一个翻译请求 */
	let queue: Promise<unknown> = Promise.resolve();
	let tui: RerenderTarget | null = null;
	let announced = false;
	/** 最近一次翻译失败的原因（静默失败太难查，status 里露出来） */
	let lastError: string | undefined;
	/** 每个会话只提示一次失败，不刷屏 */
	let failureNotified = false;

	/**
	 * 译文就绪后强制重绘。
	 *
	 * 只 requestRender 不够：Markdown 组件按 (text, width) 缓存渲染结果，
	 * 思考原文没变就命中缓存，transformer 根本不会再跑一次，屏幕会一直停在英文
	 * （译文晚于最后一帧渲染时就是这样）。所以必须先 `tui.invalidate()` 把
	 * 各组件的缓存清掉——Markdown.invalidate() 清的是 cachedLines 而不是
	 * this.text，于是下次渲染会带着同一个原文再走一遍 transform，这次就能命中译文。
	 */
	function rerender(): void {
		const target = tui;
		if (!target) return;
		try {
			if (target.invalidate) Reflect.apply(target.invalidate, target, []);
			if (target.requestRender) Reflect.apply(target.requestRender, target, [true]);
		} catch {
			/* 重绘失败不影响翻译本身 */
		}
	}

	function applyStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, enabled && config.showStatus ? "译" : undefined);
	}

	function toggle(ctx: ExtensionContext, next?: boolean): void {
		enabled = next ?? !enabled;
		// 写回配置：否则一次 /reload 就悄悄回到默认的「关」
		persistEnabled(dir, enabled);
		applyStatus(ctx);
		rerender();
		if (!ctx.hasUI) return;
		const keyHint = pick.key ? `（${pick.key}）` : "";
		ctx.ui.notify(
			enabled ? `思考翻译：已开启${keyHint}，英文思考会翻成${config.targetLanguage}` : "思考翻译：已关闭",
			"info",
		);
	}

	/** 会话文件可能是懒创建的，每次用到时再对一次（同一会话重复调用是空操作） */
	function bindSession(ctx: ExtensionContext): void {
		try {
			store.attach(ctx.sessionManager.getSessionFile());
		} catch {
			/* 拿不到 session 信息就用纯内存 */
		}
	}

	/** 起一个翻译任务（幂等：同一个 run 只跑一次） */
	function startTranslation(run: string, ctx: ExtensionContext): Promise<void> | undefined {
		if (!enabled) return undefined;
		bindSession(ctx);
		const key = translationKey(run);
		if (store.get(key) !== undefined || skipped.has(key)) return undefined;
		const running = inflight.get(key);
		if (running) return running;
		const task = (async () => {
			try {
				const decision = decideTranslate(run, {
					ratio: config.englishRatio,
					minLatin: config.minLatinLetters,
				});
				if (!decision.translate) {
					skipped.add(key);
					return;
				}
				const candidates = rankTranslateModels(
					ctx.modelRegistry
						.getAvailable()
						.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model)),
					{ preferred: config.model, fallback: ctx.model ?? null },
				);
				if (candidates.length === 0) {
					skipped.add(key);
					return;
				}
				const job = queue.then(async () =>
					// 候选模型从便宜到贵；一个报错就换下一个，全挂了才算失败
					translateMarkdown(run, {
						targetLanguage: config.targetLanguage,
						maxChars: config.maxChars,
						complete: async (systemPrompt, userText) => {
							let lastError: unknown;
							for (const model of candidates.slice(0, 3)) {
								let timedOut = false;
								for (let attempt = 0; attempt < 2; attempt++) {
									const controller = new AbortController();
									const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
									timer.unref?.();
									try {
										// pi 1.5.0 的 d.ts 把 options 类型压成了内部名 n，signal 在类型上丢了；
										// 运行时 provider 适配器是认 AbortSignal 的，所以这里断言一下。
										const message = await ctx.modelRegistry.complete(
											model,
											{
												systemPrompt,
												messages: [{ role: "user", content: userText, timestamp: Date.now() }],
											},
											{ signal: controller.signal } as never,
										);
										return assistantText(message);
									} catch (error) {
										lastError = error;
										timedOut = controller.signal.aborted;
									} finally {
										clearTimeout(timer);
									}
									// 超时/取消不重试同一个模型，直接换下一个
									if (timedOut) break;
								}
							}
							throw lastError instanceof Error ? lastError : new Error(String(lastError));
						},
					}),
				);
				queue = job.catch(() => undefined);
				const translated = await job;
				const cleaned = translated.trim();
				if (!cleaned) {
					skipped.add(key);
					return;
				}
				store.set(key, cleaned, config.persist);
				lastError = undefined;
				rerender();
			} catch (error) {
				// 模型/网络失败就当这条不翻，绝不影响正常输出
				lastError = error instanceof Error ? error.message : String(error);
				skipped.add(key);
				if (config.notifyFailure && !failureNotified && ctx.hasUI) {
					failureNotified = true;
					ctx.ui.notify(`思考翻译失败（不影响正文）：${lastError}`, "warning");
				}
			} finally {
				inflight.delete(key);
			}
		})();
		inflight.set(key, task);
		return task;
	}

	// ---- 显示层：同步、只查表 ----
	pi.registerMarkdownTransformer((markdown, context) => {
		if (!enabled) return markdown;
		if (context.messageType !== "assistant-thinking") return markdown;
		if (store.entries.size === 0) return markdown;
		const translated = store.get(translationKey(markdown));
		if (translated === undefined) return markdown;
		// 标记在渲染时加，不写进缓存：改 markerLabel/markerStyle 立刻生效
		return withMarker(translated, config.markerLabel, config.markerStyle);
	});

	// ---- 触发层 ----
	pi.on("message_update", (event, ctx) => {
		if (!enabled) return;
		const streamEvent = event.assistantMessageEvent;
		const type = streamEvent?.type;
		if (type !== "thinking_end" && type !== "text_start" && type !== "toolcall_start" && type !== "toolcall_end") {
			return;
		}
		if (event.message.role !== "assistant") return;
		// thinking_end 之后该块不会再变，可以立刻翻；其它事件只翻「后面还有别的内容」的已封口 run
		const running = type === "thinking_end";
		for (const run of thinkingRuns(event.message.content, running)) void startTranslation(run, ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!enabled) return;
		if (event.message.role !== "assistant") return;
		const tasks = thinkingRuns(event.message.content, true)
			.map((run) => startTranslation(run, ctx))
			.filter((task): task is Promise<void> => task !== undefined);
		if (tasks.length === 0) return;
		// 扩展事件先于 UI 渲染：这里等一会儿，最终帧就能直接是译文
		await boundedWait(Promise.all(tasks), config.finalizeWaitMs);
	});

	pi.on("session_start", (_event, ctx) => {
		// 恢复历史时先把该会话的 sidecar 译文读回来，历史思考直接就显示译文
		skipped.clear();
		failureNotified = false;
		bindSession(ctx);
		// 拿 TUI 实例，唯一用途是译文就绪后催重绘（同 image-view 的做法）
		if (ctx.hasUI) {
			ctx.ui.setWidget(PROBE_WIDGET, (t) => {
				tui = t as RerenderTarget;
				return { render: () => [], invalidate: () => {} };
			});
			ctx.ui.setWidget(PROBE_WIDGET, undefined);
		}
		applyStatus(ctx);
		if (announced || !ctx.hasUI) return;
		announced = true;
		// 只在真的有问题时才打扰：配置坏了，或者所有候选键都被占。
		// 正常情况下（比如 ctrl+k 被占、回退到 alt+k）保持安静，
		// 想知道用了哪个键就看 /thinking-translate status。
		const notes: string[] = [];
		if (problem) notes.push(problem);
		if (!pick.key) notes.push(`没有可用快捷键，改 ${join(dir, "thinking-translate.json")} 的 shortcuts`);
		if (notes.length > 0) ctx.ui.notify(`thinking-translate：${notes.join("；")}`, "warning");
	});

	pi.on("session_shutdown", () => {
		tui = null;
		store.attach(undefined);
	});

	if (pick.key) {
		pi.registerShortcut(pick.key as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "思考自动翻译：英文思考翻成中文（开/关）",
			handler: (ctx) => toggle(ctx),
		});
	}

	pi.registerCommand(COMMAND, {
		description: "思考自动翻译：/thinking-translate [on|off|status]",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "off") {
				toggle(ctx, action === "on");
				return;
			}
			reportStatus(ctx);
		},
	});

	function reportStatus(ctx: ExtensionContext): void {
		const lines = [
			`状态：${enabled ? "开" : "关"}（默认关闭）`,
			`快捷键：${pick.key ?? "无"}${pick.rejected.length ? `；已跳过 ${describeRejections(pick)}` : ""}`,
			`阈值：拉丁字母 ≥${config.minLatinLetters} 个且占比 ≥${config.englishRatio}`,
			`目标语言：${config.targetLanguage}；单块上限 ${config.maxChars} 字`,
			`译文标记：${config.markerLabel ? `${config.markerLabel}（${config.markerStyle}）` : "关闭"}`,
			`翻译模型：${config.model || "自动挑便宜的（flash/mini/fast 类）"}`,
			`已翻译 ${store.entries.size} 段，跳过 ${skipped.size} 段`,
			`译文缓存：${store.cachePath ?? "仅内存（当前会话还没有 session 文件）"}`,
			`配置：${join(dir, "thinking-translate.json")}`,
		];
		if (problem) lines.push(`配置问题：${problem}`);
		if (pick.rejected.length > 0) lines.push(`已跳过快捷键：${describeRejections(pick)}`);
		if (lastError) lines.push(`最近一次翻译失败：${lastError}`);
		if (!ctx.hasUI) return;
		ctx.ui.notify(`thinking-translate\n${lines.join("\n")}`, "info");
	}
}

/** 供 /thinking-translate status 之外的地方（测试、调试）复用 */
export type { ThinkingTranslateConfig };
