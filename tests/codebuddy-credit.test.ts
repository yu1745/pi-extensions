import assert from "node:assert/strict";
import test from "node:test";
import { CREDIT_ENTRY_TYPE, creditFromProviderData, formatCredit, registerCreditUsage } from "../extensions/codebuddy-fp/credit.ts";

test("从腾讯原始 usage 提取 credit", () => {
	assert.equal(creditFromProviderData({ usage: { credit: 0.0123, total_tokens: 410 } }), 0.0123);
	assert.equal(creditFromProviderData({ usage: { credit: "0.03" } }), 0.03);
	assert.equal(creditFromProviderData({ usage: { credit: 0 } }), 0);
	assert.equal(creditFromProviderData({ choices: [] }), undefined);
	assert.equal(creditFromProviderData({ usage: { credit: null } }), undefined);
	assert.equal(creditFromProviderData({ usage: { credit: "unknown" } }), undefined);
	assert.equal(creditFromProviderData(null), undefined);
});

test("积分格式不把小数吞成 0，也不使用科学计数法", () => {
	assert.equal(formatCredit(0), "0");
	assert.equal(formatCredit(12), "12");
	assert.equal(formatCredit(0.0123), "0.0123");
	assert.equal(formatCredit(1e-8), "0.00000001");
});

function harness() {
	const handlers = new Map<string, (event: any) => void>();
	const entries: any[] = [];
	let renderer: any;
	const pi = {
		registerEntryRenderer(type: string, fn: any) {
			assert.equal(type, CREDIT_ENTRY_TYPE);
			renderer = fn;
		},
		on(type: string, fn: any) { handlers.set(type, fn); },
		appendEntry(type: string, data: any) { entries.push({ type, data }); },
	};
	registerCreditUsage(pi as any);
	return { handlers, entries, getRenderer: () => renderer };
}

test("每个 CodeBuddy assistant turn 在 turn_end 显示一次积分", () => {
	const { handlers, entries } = harness();
	handlers.get("turn_start")!({});
	handlers.get("provider_stream_event")!({
		provider: "codebuddy", model: "deepseek-v4.1-flash", data: { usage: { credit: 0.03 } },
	});
	handlers.get("message_end")!({ message: { role: "assistant", provider: "codebuddy" } });
	assert.equal(entries.length, 0, "不能插在工具调用和工具结果之间");
	handlers.get("turn_end")!({});
	assert.deepEqual(entries, [{
		type: CREDIT_ENTRY_TYPE, data: { credit: 0.03, model: "deepseek-v4.1-flash" },
	}]);
});

test("没有 credit、非 CodeBuddy 或异常中断的响应不显示推算积分", () => {
	const { handlers, entries } = harness();
	handlers.get("turn_start")!({});
	handlers.get("provider_stream_event")!({ provider: "other", data: { usage: { credit: 8 } } });
	handlers.get("message_end")!({ message: { role: "assistant", provider: "codebuddy" } });
	handlers.get("turn_end")!({});
	assert.equal(entries.length, 0);
});

test("新 turn 会清除上一轮状态，不会重复显示积分", () => {
	const { handlers, entries } = harness();
	handlers.get("provider_stream_event")!({ provider: "codebuddy", model: "m", data: { usage: { credit: 1 } } });
	handlers.get("turn_start")!({});
	handlers.get("message_end")!({ message: { role: "assistant", provider: "codebuddy" } });
	handlers.get("turn_end")!({});
	assert.equal(entries.length, 0);
});
