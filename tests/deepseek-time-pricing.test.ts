import assert from "node:assert/strict";
import test from "node:test";
import extension, { isPeakAt, nextChange } from "../extensions/deepseek-time-pricing.ts";

// Mirrors the extension's own conversion so the test stays valid when
// DEEPSEEK_USD_PER_CNY is overridden.
const USD_PER_CNY = (() => {
	const parsed = Number(process.env.DEEPSEEK_USD_PER_CNY);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1 / 7;
})();

const CNY_PER_USD = 1 / USD_PER_CNY;

const MODEL = {
	id: "deepseek-flash",
	name: "DeepSeek V4.1 Flash",
	provider: "deepseek",
	api: "openai-completions",
	reasoning: true,
};

/** 2026-09-10 12:00 Beijing time (GMT+8) = 04:00 UTC. */
const V41_FLASH_FROM = Date.UTC(2026, 8, 10, 4, 0, 0);

const at = (iso: string) => new Date(iso).getTime();
const close = (actual: number, expected: number) =>
	assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} !== ${expected}`);

/**
 * Run a message through the extension's `message_end` handler.
 * `message.responseModel ?? message.model` is what the pricing rule matches.
 */
async function reprice(
	message: Record<string, unknown>,
	model: Record<string, unknown> = MODEL,
) {
	const handlers = new Map<string, Function>();
	extension({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerCommand: () => {},
	} as any);
	const ctx = { model, ui: { setStatus: () => {}, notify: () => {} } };
	const result = await handlers.get("message_end")!({ type: "message_end", message }, ctx);
	return (result as { message?: any } | undefined)?.message;
}

const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 };

/** CNY per 1M tokens -> total USD cost for `usage` above (one full unit each). */
const costOf = (cny: { input: number; output: number; cacheRead: number }) => ({
	input: cny.input / CNY_PER_USD,
	output: cny.output / CNY_PER_USD,
	cacheRead: cny.cacheRead / CNY_PER_USD,
});

test("official alias `deepseek-flash` is repriced (off-peak V4.1 tier)", async () => {
	// 2026-09-10 12:30 Beijing — Thursday, outside both peak windows.
	const patched = await reprice({
		role: "assistant",
		provider: "deepseek",
		model: "deepseek-flash",
		responseModel: "deepseek-flash",
		timestamp: at("2026-09-10T04:30:00Z"),
		usage: { ...usage },
	});

	assert.ok(patched, "deepseek-flash must match a pricing rule");
	const expected = costOf({ input: 1, output: 4, cacheRead: 0.02 });
	close(patched.usage.cost.input, expected.input);
	close(patched.usage.cost.output, expected.output);
	close(patched.usage.cost.cacheRead, expected.cacheRead);
	close(patched.usage.cost.total, expected.input + expected.output + expected.cacheRead);
});

test("`deepseek-flash` peak rates are 2x off-peak", async () => {
	// 2026-09-10 15:00 Beijing — Thursday, inside 14:00–18:00.
	const patched = await reprice({
		role: "assistant",
		provider: "deepseek",
		model: "deepseek-flash",
		timestamp: at("2026-09-10T07:00:00Z"),
		usage: { ...usage },
	});

	const expected = costOf({ input: 2, output: 8, cacheRead: 0.04 });
	close(patched.usage.cost.input, expected.input);
	close(patched.usage.cost.output, expected.output);
	close(patched.usage.cost.cacheRead, expected.cacheRead);
});

test("catalog IDs `deepseek-v4-flash` / `deepseek-v4.1-flash-*` still match", async () => {
	for (const id of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4.1-flash-expires-on-0910"]) {
		const patched = await reprice({
			role: "assistant",
			provider: "deepseek",
			model: id,
			timestamp: at("2026-09-10T04:30:00Z"),
			usage: { ...usage },
		});
		assert.ok(patched, `${id} must be repriced`);
		close(patched.usage.cost.input, 1 / CNY_PER_USD);
	}
});

test("pre-2026-09-10 tiers survive for both aliases", async () => {
	for (const id of ["deepseek-flash", "deepseek-v4-flash"]) {
		const patched = await reprice({
			role: "assistant",
			provider: "deepseek",
			model: id,
			timestamp: at("2026-09-09T07:00:00Z"), // 15:00 Beijing, Thursday, peak
			usage: { ...usage },
		});
		const expected = costOf({ input: 3, output: 9, cacheRead: 0.1 });
		close(patched.usage.cost.input, expected.input);
		close(patched.usage.cost.cacheRead, expected.cacheRead);
	}
});

test("`deepseek-pro` alias bills at V4.1 Flash prices after the switch", async () => {
	const patched = await reprice({
		role: "assistant",
		provider: "deepseek",
		model: "deepseek-pro",
		timestamp: at("2026-09-10T04:30:00Z"),
		usage: { ...usage },
	});
	assert.ok(patched, "deepseek-pro must match a pricing rule");
	close(patched.usage.cost.input, 1 / CNY_PER_USD);
	close(patched.usage.cost.output, 4 / CNY_PER_USD);
});

test("non-deepseek providers and non-assistant messages are left alone", async () => {
	const other = await reprice({
		role: "assistant",
		provider: "openai-codex",
		model: "deepseek-flash",
		timestamp: at("2026-09-10T04:30:00Z"),
		usage: { ...usage },
	});
	assert.equal(other, undefined);

	const user = await reprice({
		role: "user",
		provider: "deepseek",
		model: "deepseek-flash",
		timestamp: at("2026-09-10T04:30:00Z"),
		usage: { ...usage },
	});
	assert.equal(user, undefined);
});

test("peak detection: weekday windows only, half-open at the end", () => {
	assert.equal(isPeakAt(new Date("2026-09-10T01:00:00Z")), true); // Thu 09:00
	assert.equal(isPeakAt(new Date("2026-09-10T03:59:00Z")), true); // Thu 11:59
	assert.equal(isPeakAt(new Date("2026-09-10T04:00:00Z")), false); // Thu 12:00
	assert.equal(isPeakAt(new Date("2026-09-10T06:00:00Z")), true); // Thu 14:00
	assert.equal(isPeakAt(new Date("2026-09-10T10:00:00Z")), false); // Thu 18:00
	assert.equal(isPeakAt(new Date("2026-09-12T07:00:00Z")), false); // Sat 15:00
});

test("nextChange returns the next Beijing boundary", () => {
	assert.deepEqual(nextChange(new Date("2026-09-10T04:30:00Z")), { weekday: "Thu", minutes: 14 * 60 });
	assert.deepEqual(nextChange(new Date("2026-09-10T10:30:00Z")), { weekday: "Fri", minutes: 9 * 60 });
	assert.deepEqual(nextChange(new Date("2026-09-12T07:00:00Z")), { weekday: "Mon", minutes: 9 * 60 });
});

test("V41_FLASH_FROM boundary is exclusive of the old tier", async () => {
	assert.equal(V41_FLASH_FROM, at("2026-09-10T04:00:00Z"));
	const before = await reprice({
		role: "assistant",
		provider: "deepseek",
		model: "deepseek-flash",
		timestamp: V41_FLASH_FROM - 1,
		usage: { ...usage },
	});
	close(before.usage.cost.output, 9 / CNY_PER_USD); // Thu 11:59, peak, old tier

	const after = await reprice({
		role: "assistant",
		provider: "deepseek",
		model: "deepseek-flash",
		timestamp: V41_FLASH_FROM,
		usage: { ...usage },
	});
	close(after.usage.cost.output, 4 / CNY_PER_USD); // Thu 12:00, off-peak (12–14), new tier
});
