import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	commandCodeBaseUrl,
	commandCodeTtlFor,
	parseCommandCodeQuota,
	renderCommandCode,
} from "../extensions/quota-footer.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

/** Captured verbatim from GET /alpha/billing/credits on a real `individual-go` account. */
const CREDITS_BODY = {
	credits: {
		belowThreshold: false,
		creditThreshold: 0,
		monthlyCredits: 9.988082446,
		purchasedCredits: 0,
		freeCredits: 0,
	},
	windowLimits: {
		limited: true,
		exceeded: null,
		fiveHour: { used: 0.011917554, cap: 3, exceeded: false, resetAt: 1789059546961 },
		weekly: { used: 0.011917554, cap: 6, exceeded: false, resetAt: 1789646346961 },
	},
};

/** Captured verbatim from GET /alpha/billing/subscriptions. */
const SUBSCRIPTION = {
	planId: "individual-go",
	status: "active",
	currentPeriodStart: "2026-09-10T11:56:39.000Z",
	currentPeriodEnd: "2026-10-10T11:56:39.000Z",
};

const fakeCtx = { ui: { theme: { fg: (_color: string, text: string) => text } } } as unknown as ExtensionContext;

const parseOk = (body: unknown, subscription: unknown = SUBSCRIPTION) => {
	const result = parseCommandCodeQuota(body, subscription);
	assert.equal(result.kind, "success", `expected success, got ${JSON.stringify(result)}`);
	return (result as { payload: any }).payload;
};

test("parses live credits + window limits + plan", () => {
	const payload = parseOk(CREDITS_BODY);

	assert.equal(payload.plan, "go");
	assert.equal(payload.status, "active");
	assert.ok(Math.abs(payload.remaining - 9.988082446) < 1e-9);

	assert.equal(payload.fiveHour.cap, 3);
	assert.equal(payload.fiveHour.cycleMs, FIVE_HOUR_MS);
	assert.equal(payload.fiveHour.resetAt, 1789059546961);
	assert.equal(payload.fiveHour.exceeded, false);
	// 0.0119 / 3 = 0.4% used → rounds to 0% used, 100% left.
	assert.equal(payload.fiveHour.usedPercent, 0);
	assert.equal(payload.fiveHour.leftPercent, 100);

	assert.equal(payload.weekly.cap, 6);
	assert.equal(payload.weekly.cycleMs, WEEK_MS);
	assert.equal(payload.weekly.leftPercent, 100);
});

test("normalizes second-based and ISO reset timestamps to ms", () => {
	const seconds = parseOk({
		credits: { monthlyCredits: 1 },
		windowLimits: { fiveHour: { used: 1, cap: 4, resetAt: 1789059547 } },
	});
	assert.equal(seconds.fiveHour.resetAt, 1789059547000);

	const iso = parseOk({
		credits: { monthlyCredits: 1 },
		windowLimits: { fiveHour: { used: 1, cap: 4, resetAt: "2026-09-12T00:00:00.000Z" } },
	});
	assert.equal(iso.fiveHour.resetAt, Date.parse("2026-09-12T00:00:00.000Z"));
});

test("sums monthly, purchased and free credits", () => {
	const payload = parseOk({
		credits: { monthlyCredits: 2.5, purchasedCredits: 1.25, freeCredits: 0.25 },
	});
	assert.ok(Math.abs(payload.remaining - 4) < 1e-9);
	assert.equal(payload.fiveHour, undefined);
	assert.equal(payload.weekly, undefined);
	// No windows at all still renders a credits-only widget.
	assert.match(renderCommandCode(payload, fakeCtx), /\$4\.00/);
});

test("treats a zero cap as 'no such window' and keeps the rest", () => {
	const payload = parseOk({
		credits: { monthlyCredits: 1 },
		windowLimits: { fiveHour: { used: 0, cap: 0 }, weekly: { used: 3, cap: 6 } },
	});
	assert.equal(payload.fiveHour, undefined);
	assert.equal(payload.weekly.leftPercent, 50);
});

test("reports exceeded windows in the rendered widget", () => {
	const payload = parseOk({
		credits: { monthlyCredits: 1 },
		windowLimits: { fiveHour: { used: 4, cap: 3, exceeded: true, resetAt: 1789059546961 } },
	});
	assert.equal(payload.fiveHour.leftPercent, 0);
	const rendered = renderCommandCode(payload, fakeCtx);
	assert.match(rendered, /exceeded/);
	assert.match(rendered, /5h ░{10} 0%/);
});

test("suppresses the pace delta while one percent still spans more time than has elapsed", () => {
	const now = Date.now();
	const freshWindow = parseOk({
		credits: { monthlyCredits: 9 },
		// A weekly window that started one second ago: 1% of it is ~1.7h, so any
		// delta would be rounding noise rather than pacing information.
		windowLimits: { weekly: { used: 0.06, cap: 6, resetAt: now + WEEK_MS - 1000 } },
	});
	assert.equal(renderCommandCode(freshWindow, fakeCtx), "CC go | W ██████ 99% | $9.00");

	// Two days into the same window the resolution is real, so the delta shows.
	const runningWindow = parseOk({
		credits: { monthlyCredits: 9 },
		windowLimits: { weekly: { used: 1.2, cap: 6, resetAt: now + 5 * 24 * 60 * 60 * 1000 } },
	});
	assert.match(renderCommandCode(runningWindow, fakeCtx), /W █{5}░ 80% -\d+h/);
});

test("falls back to unavailable when no section carries data", () => {
	assert.equal(parseCommandCodeQuota(null, null).kind, "unavailable");
	assert.equal(parseCommandCodeQuota({}, {}).kind, "unavailable");
	assert.equal(parseCommandCodeQuota({ credits: {} }, null).kind, "unavailable");
});

test("ignores a malformed subscription instead of failing the fetch", () => {
	const payload = parseOk(CREDITS_BODY, null);
	assert.equal(payload.plan, undefined);
	assert.equal(payload.status, undefined);
	assert.equal(renderCommandCode(payload, fakeCtx).includes("individual"), false);
});

test("ttl shortens as the tightest window drains", () => {
	assert.equal(commandCodeTtlFor(parseOk(CREDITS_BODY)), 120_000);
	assert.equal(
		commandCodeTtlFor(parseOk({ windowLimits: { fiveHour: { used: 2.25, cap: 3 } } })),
		60_000,
	);
	assert.equal(
		commandCodeTtlFor(parseOk({ windowLimits: { fiveHour: { used: 2.85, cap: 3 } } })),
		30_000,
	);
	// The weekly window can be the tighter one.
	assert.equal(commandCodeTtlFor(parseOk({ windowLimits: { weekly: { used: 6, cap: 6 } } })), 30_000);
});

test("derives the API base from COMMANDCODE_API_BASE like the provider does", () => {
	const previous = process.env.COMMANDCODE_API_BASE;
	try {
		delete process.env.COMMANDCODE_API_BASE;
		assert.equal(commandCodeBaseUrl(), "https://api.commandcode.ai");

		process.env.COMMANDCODE_API_BASE = "https://api.commandcode.ai/provider/v1";
		assert.equal(commandCodeBaseUrl(), "https://api.commandcode.ai");

		process.env.COMMANDCODE_API_BASE = "https://staging.example.com/provider/v1/";
		assert.equal(commandCodeBaseUrl(), "https://staging.example.com");

		process.env.COMMANDCODE_API_BASE = "http://localhost:8080";
		assert.equal(commandCodeBaseUrl(), "http://localhost:8080");
	} finally {
		if (previous === undefined) delete process.env.COMMANDCODE_API_BASE;
		else process.env.COMMANDCODE_API_BASE = previous;
	}
});
