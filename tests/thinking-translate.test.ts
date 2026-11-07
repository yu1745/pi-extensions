import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";

// 扩展在每次实例化时读 <agent-dir> 下的配置和 keybindings.json；
// 每个用例换一个空目录，保证「默认关闭」等断言可重复。
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "thinking-translate-"));

/** 新建一个隔离的 agent 目录（可带初始配置）并指向它 */
function useAgentDir(config?: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "tt-agent-"));
	if (config) writeFileSync(join(dir, "thinking-translate.json"), JSON.stringify(config));
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}
import { CONFIG_DEFAULTS, normalizeConfig } from "../extensions/thinking-translate/config.ts";
import { chunkMarkdown, decideTranslate, englishStats, stripVerbatim } from "../extensions/thinking-translate/detect.ts";
import { effectiveBindings, normalizeKey, pickShortcut } from "../extensions/thinking-translate/keys.ts";
import { markerLine, withMarker } from "../extensions/thinking-translate/marker.ts";
import { thinkingRuns } from "../extensions/thinking-translate/runs.ts";
import {
	CACHE_SUFFIX,
	TranslationStore,
	cachePathFor,
	parseCache,
	translationKey,
} from "../extensions/thinking-translate/store.ts";
import {
	assistantText,
	chooseTranslateModel,
	cleanTranslation,
	rankTranslateModels,
	parseModelRef,
	translateMarkdown,
} from "../extensions/thinking-translate/translate.ts";

const model = (provider: string, id: string, input = 1): Model<Api> =>
	({ provider, id, cost: { input, output: 1 } }) as unknown as Model<Api>;

// ---------------------------------------------------------------- detect

test("stripVerbatim drops fenced code, inline code, URLs and paths", () => {
	const text = [
		"先看一下 `src/foo/bar.ts` 里的实现。",
		"```ts",
		"const englishWordsLiveHere = true; // 这里整段都是代码",
		"```",
		"参考 https://example.com/some/deep/path 和 ./a/b/c.yaml",
	].join("\n");
	const stripped = stripVerbatim(text);
	assert.ok(!stripped.includes("englishWordsLiveHere"));
	assert.ok(!stripped.includes("src/foo/bar.ts"));
	assert.ok(!stripped.includes("https://example.com"));
	assert.ok(!stripped.includes("./a/b/c.yaml"));
	assert.ok(stripped.includes("先看一下"));
});

test("englishStats counts han and latin letters only from natural language", () => {
	const stats = englishStats("先看 `const fooBarBaz = 1;` 然后 the model should call the tool");
	assert.equal(stats.han, 4, "只统计自然语言里的汉字");
	assert.equal(stats.latin, "themodelshouldcallthetool".length);
	assert.ok(stats.latinShare > 0.8);
});

test("decideTranslate needs both enough latin letters and a high share", () => {
	const options = { ratio: 0.5, minLatin: 20 };
	assert.equal(decideTranslate("OK", options).reason, "too-short");
	assert.equal(decideTranslate("我先想一下这个改动会影响哪些调用点，然后再动手。", options).reason, "already-chinese");
	const english = "I need to check how the streaming renderer handles cached markdown lines first.";
	assert.equal(decideTranslate(english, options).translate, true);
	const mixed = "我先想一下 the thin";
	assert.equal(decideTranslate(mixed, options).translate, false);
	// 全代码的思考不该被翻译
	assert.equal(decideTranslate("```ts\nconst aLongEnglishIdentifier = 1;\n```", options).reason, "empty");
});

test("chunkMarkdown keeps paragraphs intact and never loses text", () => {
	const paragraphs = Array.from({ length: 6 }, (_, i) => `段落${i}`.repeat(30));
	const text = paragraphs.join("\n\n");
	const chunks = chunkMarkdown(text, 200);
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) assert.ok(chunk.length <= 400, "允许单段超限，但不该无限膨胀");
	assert.deepEqual(chunks.join("").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
	assert.deepEqual(chunkMarkdown("短文本", 200), ["短文本"]);
});

// ---------------------------------------------------------------- keys

test("normalizeKey sorts modifiers so shift+ctrl+p equals ctrl+shift+p", () => {
	assert.equal(normalizeKey("Shift+Ctrl+P"), "ctrl+shift+p");
	assert.equal(normalizeKey("ctrl + k"), "ctrl+k");
	assert.equal(normalizeKey("pageUp"), "pageup");
});

test("ctrl+k is taken by the reserved deleteToLineEnd binding", () => {
	const owner = effectiveBindings({}).get("ctrl+k");
	assert.equal(owner?.binding, "tui.editor.deleteToLineEnd");
	assert.equal(owner?.reserved, true);
});

test("pickShortcut skips ctrl+k and lands on alt+k", () => {
	const pick = pickShortcut(["ctrl+k", "alt+k"], {});
	assert.equal(pick.key, "alt+k");
	assert.deepEqual(pick.rejected.map((item) => item.owner), ["tui.editor.deleteToLineEnd"]);
});

test("pickShortcut takes ctrl+k once the user frees the builtin binding", () => {
	const pick = pickShortcut(["ctrl+k", "alt+k"], { "tui.editor.deleteToLineEnd": [] });
	assert.equal(pick.key, "ctrl+k");
	assert.equal(pick.rejected.length, 0);
});

test("user overrides replace defaults, and non-editor app keys count as conflicts", () => {
	// 用户把 deleteToLineEnd 改成 ctrl+shift+k，那么 ctrl+k 空出来、ctrl+shift+k 反而被占
	assert.equal(pickShortcut(["ctrl+k"], { "tui.editor.deleteToLineEnd": "ctrl+shift+k" }).key, "ctrl+k");
	const shifted = pickShortcut(["ctrl+shift+k", "alt+k"], { "tui.editor.deleteToLineEnd": "ctrl+shift+k" });
	assert.equal(shifted.key, "alt+k");
	assert.equal(shifted.rejected[0]?.owner, "tui.editor.deleteToLineEnd");
	// 用户把折叠思考换成 ctrl+shift+t，那它就不可用（保留键，扩展会被丢弃）
	const withThinking = pickShortcut(["ctrl+shift+t"], { "app.thinking.toggle": ["ctrl+shift+t"] });
	assert.equal(withThinking.key, undefined);
	assert.equal(withThinking.rejected[0]?.reserved, true);
});

test("windows-specific defaults are honoured for conflict detection", () => {
	assert.equal(effectiveBindings({}, "win32").get("alt+p")?.binding, "app.model.cycleBackward");
	assert.equal(effectiveBindings({}, "linux").get("alt+p"), undefined);
});

// ---------------------------------------------------------------- runs

test("thinkingRuns joins consecutive blocks the way pi renders them", () => {
	const content = [
		{ type: "thinking", thinking: "  first block  " },
		{ type: "thinking", thinking: "second block" },
		{ type: "text", text: "answer" },
		{ type: "thinking", thinking: "trailing block" },
	];
	assert.deepEqual(thinkingRuns(content, false), ["first block\n\nsecond block"]);
	assert.deepEqual(thinkingRuns(content, true), ["first block\n\nsecond block", "trailing block"]);
	assert.deepEqual(thinkingRuns([{ type: "thinking", thinking: "   " }], true), []);
});

// ---------------------------------------------------------------- translate

test("parseModelRef splits provider/model and rejects nonsense", () => {
	assert.deepEqual(parseModelRef("deepseek/deepseek-flash"), { provider: "deepseek", id: "deepseek-flash" });
	assert.deepEqual(parseModelRef("openai/deepseek/chat"), { provider: "openai", id: "deepseek/chat" });
	assert.equal(parseModelRef("no-slash"), null);
	assert.equal(parseModelRef("/leading"), null);
});

test("chooseTranslateModel prefers config, then a cheap model, then the session model", () => {
	const available = [model("zai", "glm-5.3", 3), model("deepseek", "deepseek-flash", 0.2), model("x", "opus", 15)];
	assert.equal(chooseTranslateModel(available, { preferred: "x/opus" })?.id, "opus");
	assert.equal(chooseTranslateModel(available, { preferred: "opus" })?.id, "opus");
	assert.equal(chooseTranslateModel(available)?.id, "deepseek-flash", "没配置时自动挑便宜的 flash 类");
	const fallback = model("s", "session-model", 9);
	assert.equal(chooseTranslateModel([], { fallback })?.id, "session-model");
	assert.equal(chooseTranslateModel([], { fallback: null }), null);
});

test("rankTranslateModels orders preferred, cheap, then session model", () => {
	const available = [model("zai", "glm-5.3", 3), model("deepseek", "deepseek-flash", 0.2), model("x", "opus", 15)];
	const fallback = model("s", "session-model", 9);
	const ranked = rankTranslateModels(available, { preferred: "x/opus", fallback });
	assert.deepEqual(ranked.map((item) => item.id), ["opus", "deepseek-flash", "session-model"]);
	// 不重复堆叠
	assert.equal(new Set(ranked.map((item) => `${item.provider}/${item.id}`)).size, ranked.length);
});

test("cleanTranslation strips wrapper shells the model likes to add", () => {
	assert.equal(cleanTranslation("以下是译文：\n我想先看一下。"), "我想先看一下。");
	assert.equal(cleanTranslation("```markdown\n我想先看一下。\n```"), "我想先看一下。");
	assert.equal(cleanTranslation("  原样  "), "原样");
});

test("assistantText collects text blocks and ignores thinking/tool calls", () => {
	assert.equal(
		assistantText({
			content: [
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: "第一段" },
				{ type: "text", text: "第二段" },
			],
		}),
		"第一段第二段",
	);
	assert.equal(assistantText({ content: "direct" }), "direct");
});

test("translateMarkdown chunks long input and keeps the chunk order", async () => {
	const calls: { system: string; user: string }[] = [];
	const text = [`A${"x".repeat(80)}`, `B${"y".repeat(80)}`].join("\n\n");
	const translated = await translateMarkdown(text, {
		targetLanguage: "简体中文",
		maxChars: 100,
		complete: async (system, user) => {
			calls.push({ system, user });
			return `譯${calls.length}`;
		},
	});
	assert.equal(calls.length, 2);
	assert.equal(translated, "譯1\n\n譯2");
	assert.ok(calls[0].system.includes("简体中文"));
	assert.ok(calls[0].system.includes("代码块"));
});

// ---------------------------------------------------------------- config

test("normalizeConfig falls back per field and clamps thresholds", () => {
	const config = normalizeConfig({ enabled: true, englishRatio: 3, minLatinLetters: -5, shortcuts: "ctrl+j" });
	assert.equal(config.enabled, true);
	assert.equal(config.englishRatio, 1);
	assert.equal(config.minLatinLetters, 0);
	assert.deepEqual(config.shortcuts, ["ctrl+j"]);
	const empty = normalizeConfig(null);
	assert.deepEqual(empty, CONFIG_DEFAULTS);
	// 空数组回退默认候选，避免用户写错导致永久没有快捷键
	assert.deepEqual(normalizeConfig({ shortcuts: [] }).shortcuts, CONFIG_DEFAULTS.shortcuts);
});

// ---------------------------------------------------------------- marker

test("markerLine uses theme-colored markdown constructs", () => {
	assert.equal(markerLine("🀄 译", "code"), "`🀄 译`");
	assert.equal(markerLine("🀄 译", "heading"), "#### 🀄 译");
	assert.equal(markerLine("🀄 译", "quote"), "> 🀄 译");
	assert.equal(markerLine("🀄 译", "none"), "");
});

test("withMarker prefixes the translation and is a no-op when disabled", () => {
	assert.equal(withMarker("正文", "译", "code"), "`译`\n\n正文");
	assert.equal(withMarker("正文", "", "code"), "正文");
	assert.equal(withMarker("正文", "译", "none"), "正文");
});

// ---------------------------------------------------------------- store

test("translationKey is stable and text-dependent", () => {
	assert.equal(translationKey("hello"), translationKey("hello"));
	assert.notEqual(translationKey("hello"), translationKey("hello "));
	assert.match(translationKey("hello"), /^[0-9a-f]{40}$/);
});

test("cachePathFor puts one sidecar file next to the session jsonl", () => {
	assert.equal(
		cachePathFor("/a/sessions/--home-x--/2026-11-06T00-00-00-000Z_uuid.jsonl"),
		"/a/sessions/--home-x--/2026-11-06T00-00-00-000Z_uuid.thinking-translate.txt",
	);
	// pi 靠 file.endsWith(".jsonl") 发现会话，缓存文件必须不满足它
	assert.ok(!cachePathFor("/a/b.jsonl").endsWith(".jsonl"));
	assert.equal(CACHE_SUFFIX, ".thinking-translate.txt");
});

test("parseCache skips corrupt lines and lets later records win", () => {
	const text = [
		'{"k":"a","t":"一"}',
		"not json at all",
		'{"k":"a","t":"二"}',
		'{"t":"missing key"}',
		'{"k":"b","t":"   "}',
		"",
	].join("\n");
	assert.deepEqual([...parseCache(text)], [["a", "二"]]);
});

test("TranslationStore persists to one jsonl per session and reloads it", () => {
	const dir = mkdtempSync(join(tmpdir(), "tt-store-"));
	const sessionFile = join(dir, "2026-11-06T00-00-00-000Z_uuid.jsonl");
	const key = translationKey("some english thinking");

	const writer = new TranslationStore();
	writer.attach(sessionFile);
	writer.set(key, "某段英文思考", true);
	assert.equal(writer.cachePath, cachePathFor(sessionFile));
	assert.ok(readFileSync(cachePathFor(sessionFile), "utf8").includes(key));
	// 一行一条，追加写
	writer.set(translationKey("another"), "第二段", true);
	assert.equal(readFileSync(cachePathFor(sessionFile), "utf8").trim().split("\n").length, 2);

	// 「重启」：新实例从同一会话文件恢复
	const reader = new TranslationStore();
	reader.attach(sessionFile);
	assert.equal(reader.get(key), "某段英文思考");

	// 别的会话互不影响
	const other = new TranslationStore();
	other.attach(join(dir, "another.jsonl"));
	assert.equal(other.get(key), undefined);

	// persist=false 只进内存
	const noPersist = new TranslationStore();
	noPersist.attach(join(dir, "volatile.jsonl"));
	noPersist.set(translationKey("x"), "仅内存", false);
	assert.equal(noPersist.get(translationKey("x")), "仅内存");
	assert.equal(new TranslationStore().cachePath, null);
});

// ---------------------------------------------------------------- 接线

/** 假的 pi：只实现本扩展用到的注册入口 */
function fakePi() {
	const transformers: ((markdown: string, context: any) => string)[] = [];
	const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
	const shortcuts = new Map<string, { description?: string; handler: (ctx: any) => any }>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const pi = {
		registerMarkdownTransformer: (fn: any) => {
			transformers.push(fn);
		},
		on: (event: string, fn: any) => {
			handlers.set(event, [...(handlers.get(event) ?? []), fn]);
		},
		registerShortcut: (key: string, options: any) => {
			shortcuts.set(key, options);
		},
		registerCommand: (name: string, options: any) => {
			commands.set(name, options);
		},
	};
	const emit = async (event: string, payload: any, ctx: any) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	const transform = (markdown: string) =>
		transformers.reduce((text, fn) => fn(text, { messageType: "assistant-thinking", isStreaming: false }), markdown);
	return { pi: pi as any, emit, transform, shortcuts, commands };
}

/** 假 ctx：只实现 handler 用到的部分 */
function fakeCtx(reply: string) {
	const calls: { system: string; user: string }[] = [];
	const ctx = {
		hasUI: false,
		model: { provider: "fake", id: "fake-session" },
		modelRegistry: {
			getAvailable: () => [model("fake", "fake-session", 9)],
			hasConfiguredAuth: () => true,
			complete: async (_model: any, context: any) => {
				calls.push({ system: context.systemPrompt, user: context.messages[0].content });
				return { content: [{ type: "text", text: reply }] };
			},
		},
	};
	return { ctx: ctx as any, calls };
}

const ENGLISH_THINKING =
	"I should first check how the renderer caches markdown lines, then decide whether the transform hook can refresh an already rendered block.";

test("英文思考在 message_end 之前翻好，transformer 返回译文", async () => {
	useAgentDir();
	const harness = fakePi();
	const thinkingTranslate = (await import("../extensions/thinking-translate/index.ts")).default;
	thinkingTranslate(harness.pi);
	const { ctx, calls } = fakeCtx("我先看一下渲染器怎么缓存 Markdown 行。");

	// 默认关闭：transformer 直通
	assert.equal(harness.transform(ENGLISH_THINKING), ENGLISH_THINKING);

	// 用命令打开（hasUI=false 时不发通知，只是切状态）
	await harness.commands.get("thinking-translate")!.handler("on", ctx);

	const message = {
		role: "assistant",
		content: [{ type: "thinking", thinking: ENGLISH_THINKING }, { type: "text", text: "done" }],
	};
	await harness.emit("message_update", {
		message,
		assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
	}, ctx);
	await harness.emit("message_end", { message }, ctx);

	assert.equal(calls.length, 1, "只发一次翻译请求");
	assert.ok(calls[0].system.includes("简体中文"));
	assert.equal(harness.transform(ENGLISH_THINKING), "`🀄 译`\n\n我先看一下渲染器怎么缓存 Markdown 行。");
	// 其它块 / 关闭后保持原样
	assert.equal(harness.transform("unrelated markdown"), "unrelated markdown");
	await harness.commands.get("thinking-translate")!.handler("off", ctx);
	assert.equal(harness.transform(ENGLISH_THINKING), ENGLISH_THINKING);
});

test("会话重启后译文还在：新实例从 sidecar jsonl 直接命中，零请求", async () => {
	useAgentDir();
	const dir = mkdtempSync(join(tmpdir(), "tt-resume-"));
	const sessionFile = join(dir, "2026-11-06T00-00-00-000Z_uuid.jsonl");
	const thinkingTranslate = (await import("../extensions/thinking-translate/index.ts")).default;

	const withSession = (reply: string) => {
		const base = fakeCtx(reply);
		return { ...base, ctx: { ...base.ctx, sessionManager: { getSessionFile: () => sessionFile } } };
	};

	// 第一次运行：翻完并落盘
	const first = fakePi();
	thinkingTranslate(first.pi);
	const a = withSession("我先看一下渲染器怎么缓存 Markdown 行。");
	await first.emit("session_start", {}, a.ctx);
	await first.commands.get("thinking-translate")!.handler("on", a.ctx);
	const message = { role: "assistant", content: [{ type: "thinking", thinking: ENGLISH_THINKING }] };
	await first.emit("message_end", { message }, a.ctx);
	assert.equal(a.calls.length, 1);
	assert.equal(first.transform(ENGLISH_THINKING), "`🀄 译`\n\n我先看一下渲染器怎么缓存 Markdown 行。");

	// 第二次运行（新实例 = pi 重启/续会话）：不发请求也能显示译文
	const second = fakePi();
	thinkingTranslate(second.pi);
	const b = withSession("不该被调用");
	await second.emit("session_start", {}, b.ctx);
	await second.commands.get("thinking-translate")!.handler("on", b.ctx);
	await second.emit("message_end", { message }, b.ctx);
	assert.equal(b.calls.length, 0, "命中磁盘缓存就不该再调模型");
	assert.equal(second.transform(ENGLISH_THINKING), "`🀄 译`\n\n我先看一下渲染器怎么缓存 Markdown 行。");
});

test("译文就绪后用 tui.invalidate() 清渲染缓存，否则会一直停在英文", async () => {
	useAgentDir();
	const harness = fakePi();
	const thinkingTranslate = (await import("../extensions/thinking-translate/index.ts")).default;
	thinkingTranslate(harness.pi);
	const repaint: string[] = [];
	const tui = {
		requestRender: () => repaint.push("render"),
		invalidate: () => repaint.push("invalidate"),
	};
	const base = fakeCtx("我先看一下渲染器怎么缓存 Markdown 行。");
	const ctx: any = {
		...base.ctx,
		hasUI: true,
		ui: {
			setStatus: () => undefined,
			notify: () => undefined,
			// 扩展靠 setWidget 的 factory 拿 TUI 实例
			setWidget: (key: string, factory: unknown) => {
				if (key === "thinking-translate-probe" && typeof factory === "function") factory(tui, {});
			},
		},
	};
	await harness.emit("session_start", {}, ctx);
	await harness.commands.get("thinking-translate")!.handler("on", ctx);
	repaint.length = 0;

	await harness.emit("message_end", {
		message: { role: "assistant", content: [{ type: "thinking", thinking: ENGLISH_THINKING }] },
	}, ctx);

	assert.equal(harness.transform(ENGLISH_THINKING), "`🀄 译`\n\n我先看一下渲染器怎么缓存 Markdown 行。");
	assert.ok(repaint.includes("invalidate"), "必须 invalidate，否则 Markdown 缓存会挡住译文");
	assert.ok(repaint.includes("render"));
});

test("中文思考不触发翻译请求；同一段只翻一次", async () => {
	useAgentDir();
	const harness = fakePi();
	const thinkingTranslate = (await import("../extensions/thinking-translate/index.ts")).default;
	thinkingTranslate(harness.pi);
	const { ctx, calls } = fakeCtx("不该被调用");

	await harness.commands.get("thinking-translate")!.handler("on", ctx);
	await harness.emit("message_end", {
		message: { role: "assistant", content: [{ type: "thinking", thinking: "我先看下这个改动影响哪些调用点。" }] },
	}, ctx);
	assert.equal(calls.length, 0);

	const english = { role: "assistant", content: [{ type: "thinking", thinking: ENGLISH_THINKING }] };
	await harness.emit("message_update", { message: english, assistantMessageEvent: { type: "thinking_end" } }, ctx);
	await harness.emit("message_end", { message: english }, ctx);
	await harness.emit("message_end", { message: english }, ctx);
	assert.equal(calls.length, 1, "重复触发不重复花钱");
});

test("翻译失败时保持原文，不抛错", async () => {
	useAgentDir();
	const harness = fakePi();
	const thinkingTranslate = (await import("../extensions/thinking-translate/index.ts")).default;
	thinkingTranslate(harness.pi);
	const ctx = {
		hasUI: false,
		model: null,
		modelRegistry: {
			getAvailable: () => [model("fake", "fake-flash", 1)],
			hasConfiguredAuth: () => true,
			complete: async () => {
				throw new Error("provider down");
			},
		},
	};
	await harness.commands.get("thinking-translate")!.handler("on", ctx as any);
	await assert.doesNotReject(
		harness.emit("message_end", {
			message: { role: "assistant", content: [{ type: "thinking", thinking: ENGLISH_THINKING }] },
		}, ctx),
	);
	assert.equal(harness.transform(ENGLISH_THINKING), ENGLISH_THINKING);
});

test("开关写回配置：别的字段保留，/reload 后仍是开着", async () => {
	const dir = useAgentDir({ model: "x/y-flash", englishRatio: 0.6 });
	const thinkingTranslate = (await import("../extensions/thinking-translate/index.ts")).default;

	const first = fakePi();
	thinkingTranslate(first.pi);
	const a = fakeCtx("译文");
	await first.commands.get("thinking-translate")!.handler("on", a.ctx);
	const saved = JSON.parse(readFileSync(join(dir, "thinking-translate.json"), "utf8"));
	assert.equal(saved.enabled, true);
	assert.equal(saved.model, "x/y-flash", "不该冲掉用户其它配置");
	assert.equal(saved.englishRatio, 0.6);

	// 「reload」：新实例从配置读到 enabled=true，不用再按快捷键
	const second = fakePi();
	thinkingTranslate(second.pi);
	const b = fakeCtx("续用的译文");
	await second.emit("message_end", {
		message: { role: "assistant", content: [{ type: "thinking", thinking: ENGLISH_THINKING }] },
	}, b.ctx);
	assert.equal(b.calls.length, 1, "配置里 enabled=true 时新实例直接生效");
	assert.equal(second.transform(ENGLISH_THINKING), "`🀄 译`\n\n续用的译文");
});

test("注册的快捷键不会撞内置键位", async () => {
	useAgentDir();
	const harness = fakePi();
	const thinkingTranslate = (await import("../extensions/thinking-translate/index.ts")).default;
	thinkingTranslate(harness.pi);
	const keys = [...harness.shortcuts.keys()];
	assert.equal(keys.length, 1);
	assert.ok(!effectiveBindings({}).has(keys[0]), `快捷键 ${keys[0]} 撞上了内置键位`);
});
