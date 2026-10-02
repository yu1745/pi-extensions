import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/openai-codex-fast.ts";

function harness(session = "main", provider = "openai-codex", manager?: SessionManager) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const ctx: any = {
		model: { provider, id: "gpt-5.6-sol" },
		sessionManager: manager ?? { getSessionId: () => session, getLeafId: () => "leaf" },
		ui: { setStatus() {}, notify() {}, theme: { fg: (_: string, text: string) => text } },
	};
	extension({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		appendEntry: (customType: string, data: any) => {
			entries.push({ customType, data });
			manager?.appendCustomEntry(customType, data);
		},
	} as any);
	return {
		ctx, entries, handlers,
		command: (name: string) => commands.get(name).handler("", ctx),
		emit: (name: string, data: any = {}) => handlers.get(name)?.({ type: name, ...data }, ctx),
		request: (payload: any) => handlers.get("before_provider_request")!({ payload }, ctx) ?? payload,
	};
}

// The real module intentionally keeps this object process-wide, including reloads.
test.beforeEach(() => { (globalThis as any).__piCodexFastState.serviceTier = "standard"; });

for (const [mode, command, tier] of [
	["standard", undefined, "default"], ["fast", "fast", "priority"], ["ultrafast", "ultrafast", "ultrafast"],
] as const) {
	test(`${mode}: persistent request snapshot, no content/cost mutation`, async () => {
		const h = harness();
		if (command) await h.command(command);
		const payload = { model: "wire-model", input: [{ role: "user", content: "private" }] };
		const original = structuredClone(payload);
		const next = h.request(payload);
		assert.deepEqual(payload, original);
		if (mode === "standard") assert.equal(next, payload);
		else assert.equal(next.service_tier, tier);
		assert.equal(h.entries.length, 1);
		const { request_id, ...data } = h.entries[0].data;
		assert.match(request_id, /^[0-9a-f-]{36}$/);
		assert.deepEqual(data, {
			version: 1, kind: "requested_service_tier", session_id: "main", parent_entry_id: "leaf",
			provider: "openai-codex", model: "wire-model", mode, service_tier: tier,
			service_tier_explicit: mode !== "standard",
		});
		assert.equal(h.entries[0].customType, "openai-codex-fast-request");
		assert.ok(!JSON.stringify(h.entries).includes("private"));
	});
}

test("non-target provider and malformed payloads produce no entries or rewrites", async () => {
	const h = harness("other", "openai");
	await h.command("fast");
	await h.command("ultrafast");
	const payload = { model: "gpt", input: [] };
	assert.equal(h.request(payload), payload);
	assert.equal((globalThis as any).__piCodexFastState.serviceTier, "standard");
	h.ctx.model.provider = "openai-codex";
	for (const payload of [undefined, null, "text", []]) assert.equal(h.request(payload), payload);
	assert.equal(h.entries.length, 0);
});

test("mode switches after a request cannot relabel it or attach guessed usage metadata", async () => {
	const h = harness();
	await h.command("fast");
	const next = h.request({ input: [] });
	const snapshot = structuredClone(h.entries);
	await h.command("ultrafast");
	const message = { role: "assistant", provider: "openai-codex", model: h.ctx.model.id,
		usage: { cost: { total: 123 } }, content: [] };
	assert.equal(h.emit("message_end", { message }), undefined);
	assert.deepEqual(h.entries, snapshot);
	assert.deepEqual(message.usage.cost, { total: 123 });
	assert.equal(next.service_tier, "priority");
	h.request({ input: [] });
	assert.equal(h.entries[1].data.service_tier, "ultrafast");
	assert.notEqual(h.entries[0].data.request_id, h.entries[1].data.request_id);
});

test("subagent factories inherit shared mode but write only their own session snapshots", async () => {
	const main = harness();
	await main.command("fast");
	const child = harness("child");
	child.emit("session_start");
	assert.equal(child.request({}).service_tier, "priority");
	await child.command("ultrafast");
	assert.equal(main.request({}).service_tier, "ultrafast");
	assert.equal(child.entries[0].data.session_id, "child");
	assert.equal(main.entries[0].data.session_id, "main");
	assert.equal(child.entries[0].data.service_tier, "priority");
	await main.command("ultrafast");
	const payload = {};
	assert.equal(child.request(payload), payload);
	assert.equal(child.entries[1].data.service_tier, "default");
});

test("each hook invocation is distinct, standard preserves explicit tiers and excludes arbitrary data", () => {
	const h = harness();
	for (const tier of ["priority", "ultrafast", "default", "auto", { secret: "private" }, null]) {
		const payload = { service_tier: tier };
		assert.equal(h.request(payload), payload);
		assert.equal(h.entries.at(-1).data.service_tier,
			typeof tier === "string" && tier !== "auto" ? tier : "unknown");
	}
	assert.equal(new Set(h.entries.map(e => e.data.request_id)).size, 6);
	assert.ok(!JSON.stringify(h.entries).includes("private"));
	assert.equal(h.handlers.has("message_end"), false);
});

test("real SessionManager persists snapshots to JSONL but excludes them from model context", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-fast-test-"));
	try {
		const manager = SessionManager.create(dir, dir);
		const assistant = { role: "assistant", provider: "openai-codex", api: "openai-codex-responses",
			model: "wire-model", content: [], stopReason: "stop", timestamp: 2,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as const;
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const leaf = manager.appendMessage({ ...assistant, content: [] });
		const h = harness("unused", "openai-codex", manager);
		await h.command("fast");
		h.request({ model: "wire-model", input: [] });
		const file = manager.getSessionFile()!;
		const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
		const entry = rows.find(row => row.customType === "openai-codex-fast-request");
		assert.equal(entry.type, "custom");
		assert.equal(entry.data.parent_entry_id, leaf);
		assert.equal(entry.data.session_id, manager.getSessionId());
		assert.deepEqual(entry.data, h.entries[0].data);
		const reopened = SessionManager.open(file, dir);
		assert.deepEqual(reopened.buildSessionContext().messages,
			[{ role: "user", content: "hello", timestamp: 1 }, assistant]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
