import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import codexTimer from "../extensions/codex-timer.ts";
import statusFooter from "../extensions/status-footer.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => void | Promise<void>;
type Footer = { render(width: number): string[] };

function harness() {
	const handlers = new Map<string, Handler[]>();
	const statuses = new Map<string, string>([["quota", "QUOTA"], ["tokenspeed", "SPEED"]]);
	const entries: { type: string; data: unknown }[] = [];
	let footer: Footer | undefined;
	const theme = { fg: (_color: string, text: string) => text };
	const footerData = {
		getGitBranch: () => undefined,
		getAvailableProviderCount: () => 0,
		getExtensionStatuses: () => statuses,
		onBranchChange: () => () => {},
	};
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerEntryRenderer() {},
		appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		ui: {
			theme,
			setStatus(key: string, text?: string) {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			setFooter(factory: (tui: { requestRender(): void }, currentTheme: typeof theme, data: typeof footerData) => Footer) {
				footer = factory({ requestRender() {} }, theme, footerData);
			},
		},
		sessionManager: { getBranch: () => [], getCwd: () => "/tmp", getSessionName: () => undefined },
		getContextUsage: () => ({ contextWindow: 100_000, percent: 0 }),
	} as unknown as ExtensionContext;
	codexTimer(pi);
	statusFooter(pi);
	return {
		entries,
		async emit(event: string, data: Record<string, unknown> = {}) {
			for (const handler of handlers.get(event) ?? []) await handler(data, ctx);
		},
		lines: () => footer!.render(100),
	};
}

test("timer changes keep the quota column fixed from idle through digits, units and settlement", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
	const h = harness();
	await h.emit("session_start");
	assert.ok(h.lines()[2].startsWith("Ready"));
	const initialColumn = h.lines()[2].indexOf("QUOTA");
	assert.ok(initialColumn > 0, "idle footer must reserve a timer slot");
	await h.emit("agent_start");
	await h.emit("message_start", { message: { role: "assistant" } });
	for (const [elapsed, label] of [[9000, "Thinking 9s"], [1000, "Thinking 10s"], [49000, "Thinking 59s"], [1000, "Thinking 1m 00s"], [3540000, "Thinking 1h 00m 00s"]] as const) {
		t.mock.timers.tick(elapsed);
		const lines = h.lines();
		assert.equal(lines.length, 3);
		assert.ok(lines[2].startsWith(label), lines[2]);
		assert.equal(lines[2].indexOf("QUOTA"), initialColumn);
	}
	await h.emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta" } });
	const thought = h.lines()[2];
	assert.ok(thought.startsWith("Thought 1h 00m 00s"));
	assert.equal(thought.indexOf("QUOTA"), initialColumn);
	await h.emit("message_end", { message: { role: "assistant" } });
	await h.emit("agent_settled");
	assert.equal(h.lines()[2], thought, "final thinking duration must survive settlement");
	assert.equal(h.entries[0]?.type, "worked-for");
	await h.emit("session_shutdown");
});

test("tool-only responses keep their duration, while a new session resets to Ready in the same slot", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
	const h = harness();
	await h.emit("session_start");
	const idle = h.lines()[2];
	await h.emit("agent_start");
	await h.emit("message_start", { message: { role: "assistant" } });
	t.mock.timers.tick(10000);
	await h.emit("message_end", { message: { role: "assistant" } });
	await h.emit("agent_settled");
	assert.ok(h.lines()[2].startsWith("Thought 10s"));
	assert.equal(h.lines()[2].indexOf("QUOTA"), idle.indexOf("QUOTA"));
	await h.emit("session_start");
	assert.equal(h.lines()[2], idle);
	await h.emit("session_shutdown");
});
