import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	cbCycleMs,
	codeBuddyBaseUrl,
	codeBuddyTtlFor,
	parseCodeBuddyPackage,
	parseCodeBuddyQuota,
	parseCodeBuddyResetAt,
	renderCodeBuddy,
} from "../extensions/quota-footer.ts";

/** Captured verbatim from POST /billing/meter/get-user-resource-summary on a live 体验版 account. */
const SUMMARY = {
	code: 0,
	msg: "OK",
	requestId: "04ea4236-f796-414b-8f0c-3f26281cae2f",
	data: {
		Packages: [
			{
				PackageCode: "TCACA_code_007_nzdH5h4Nl0",
				CycleTotalCapacity: "908",
				CycleRemainCapacity: "702.78000015",
				CycleUsedCapacity: "205.21999985",
				CycleFrozenCapacity: "0",
				CapacityUnit: "credits",
				TotalCount: 10,
			},
			{
				PackageCode: "TCACA_code_008_cfWoLwvjU4",
				CycleTotalCapacity: "500",
				CycleRemainCapacity: "500",
				CycleUsedCapacity: "0",
				CycleFrozenCapacity: "0",
				CapacityUnit: "credits",
				TotalCount: 1,
			},
		],
		SubscriptionPackageCode: "",
		SubscriptionPackageName: "体验版",
		IsPaidUser: false,
		IsProtectedPriceUser: false,
	},
};

/** Captured verbatim from POST /billing/meter/get-user-resource (first row only). */
const DETAIL = {
	code: 0,
	data: {
		Response: {
			Data: {
				TotalCount: 11,
				TotalDosage: 1202,
				Accounts: [
					{
						PackageCode: "TCACA_code_008_cfWoLwvjU4",
						PackageName: "CodeBuddy个人体验版",
						CycleStartTime: "2026-10-01 00:00:00",
						CycleEndTime: "2026-10-31 23:59:59",
						ExpiredTime: "",
						CapacitySize: 500,
						CapacityRemain: 500,
						CapacityUsed: 0,
					},
				],
			},
		},
	},
};

const fakeCtx = { ui: { theme: { fg: (_color: string, text: string) => text } } } as unknown as ExtensionContext;

const parseOk = (summary: unknown = SUMMARY, detail?: unknown, now?: number) => {
	const result = parseCodeBuddyQuota(summary, detail, now);
	assert.equal(result.kind, "success", `expected success, got ${JSON.stringify(result)}`);
	return (result as { payload: any }).payload;
};

test("aggregates packages into a single credits balance", () => {
	const payload = parseOk();
	assert.equal(payload.total, 1408);
	assert.equal(Math.round(payload.remain * 100) / 100, 1202.78);
	assert.equal(Math.round(payload.used * 100) / 100, 205.22);
	assert.equal(payload.packages.length, 2);
	assert.equal(payload.unit, "credits");
	assert.equal(payload.plan, "体验版");
	assert.equal(payload.paid, false);
	// 1202.78 / 1408
	assert.equal(payload.leftPercent, 85);
});

test("reads cycle boundary from the detail endpoint as UTC+8", () => {
	// "2026-10-31 23:59:59" must be CST, not the process timezone. On a UTC+2
	// box Date.parse() would silently land 6h earlier.
	assert.equal(cbCycleMs("2026-10-31 23:59:59"), Date.parse("2026-10-31T23:59:59+08:00"));
	assert.equal(cbCycleMs("2026-10-01 00:00:00"), Date.parse("2026-10-01T00:00:00+08:00"));
	assert.equal(cbCycleMs("not-a-date"), undefined);
	assert.equal(cbCycleMs(12345), undefined);

	const before = Date.parse("2026-10-12T00:00:00Z");
	const payload = parseOk(SUMMARY, DETAIL, before);
	assert.equal(payload.resetAt, Date.parse("2026-10-31T23:59:59+08:00"));
});

test("prefers the subscription cycle over a nearer promo pack", () => {
	const mixed = structuredClone(DETAIL);
	// A referral pack that rolls over in two days — much nearer than the
	// monthly subscription, but not the reset worth showing.
	mixed.data.Response.Data.Accounts.push({
		PackageCode: "TCACA_code_007_nzdH5h4Nl0",
		PackageName: "CodeBuddy个人版国内运营裂变包",
		SubProductCode: "sp_tcaca_codebuddyide_bonus_pack",
		CycleStartTime: "2026-09-15 00:58:38",
		CycleEndTime: "2026-10-15 00:58:37",
		ExpiredTime: "2026-10-09 14:27:03",
		CapacitySize: 100,
		Status: 0,
	});
	const before = Date.parse("2026-10-12T00:00:00Z");
	const at = (p: any) => p.resetAt;
	assert.equal(at(parseOk(SUMMARY, mixed, before)), Date.parse("2026-10-31T23:59:59+08:00"));
	// ...even though the promo pack boundary is the nearest one in the payload.
	assert.ok(Date.parse("2026-10-15T00:58:37+08:00") < Date.parse("2026-10-31T23:59:59+08:00"));
});

test("uses SubscriptionPackageCode when the summary names one", () => {
	const detail = structuredClone(DETAIL);
	detail.data.Response.Data.Accounts[0].PackageCode = "TCACA_code_007_promo";
	const withCode = structuredClone(SUMMARY);
	withCode.data.SubscriptionPackageCode = "TCACA_code_007_promo";
	const before = Date.parse("2026-10-12T00:00:00Z");
	// The exact-code match still resolves to that row's own cycle.
	assert.equal(parseOk(withCode, detail, before).resetAt, Date.parse("2026-10-31T23:59:59+08:00"));
});

test("falls back to the largest active pool when nothing matches", () => {
	const odd = structuredClone(DETAIL);
	// No usable SubProductCode, and Status marks the big row as spent.
	odd.data.Response.Data.Accounts[0].SubProductCode = "";
	odd.data.Response.Data.Accounts[0].Status = 3;
	odd.data.Response.Data.Accounts.push({
		PackageCode: "X",
		SubProductCode: "",
		CycleEndTime: "2026-11-30 23:59:59",
		ExpiredTime: "",
		CapacitySize: 9000,
		Status: 0,
	});
	const at = parseOk(SUMMARY, odd, Date.parse("2026-10-12T00:00:00Z")).resetAt;
	assert.equal(at, Date.parse("2026-11-30T23:59:59+08:00"));
});

test("ignores cycle boundaries that already elapsed", () => {
	const after = Date.parse("2026-11-05T00:00:00Z");
	// Every remaining boundary is in the past, so no reset is reported.
	assert.equal(parseCodeBuddyResetAt(DETAIL, undefined, after), undefined);
	assert.equal(parseCodeBuddyResetAt(undefined), undefined);
	assert.equal(parseCodeBuddyResetAt({ data: { Response: { Data: {} } } }), undefined);
});

test("summary alone still works when the detail call fails", () => {
	const payload = parseOk(SUMMARY, null);
	assert.equal(payload.resetAt, undefined);
	assert.equal(payload.leftPercent, 85);
});

test("frozen capacity is subtracted so the bar cannot oversell", () => {
	const frozen = structuredClone(SUMMARY);
	frozen.data.Packages[0].CycleFrozenCapacity = "100";
	const payload = parseOk(frozen);
	// Only the first package is frozen: 702.78 - 100 = 602.78, plus the
	// untouched 500 from the second package.
	assert.equal(Math.round(payload.remain * 100) / 100, 1102.78);
	assert.equal(payload.frozen, 100);
	// 1102.78 / 1408
	assert.equal(payload.leftPercent, 78);
});

test("frozen capacity that would overrun the package is ignored", () => {
	const bad = structuredClone(SUMMARY);
	// remain + frozen > total: the row is inconsistent, so keep it as reported
	// rather than clamping the balance to a value the API never claimed.
	bad.data.Packages[0].CycleFrozenCapacity = "900";
	assert.equal(Math.round(parseOk(bad).remain * 100) / 100, 1202.78);
});

test("classifies auth / rate-limit / unavailable responses", () => {
	assert.equal(parseCodeBuddyQuota({ code: 401, msg: "token expired" }).kind, "auth_error");
	assert.equal(parseCodeBuddyQuota({ code: 403, msg: "未授权" }).kind, "auth_error");
	assert.equal(parseCodeBuddyQuota({ code: 429, msg: "too many requests" }).kind, "rate_limited");
	assert.equal(parseCodeBuddyQuota({ code: 500, msg: "internal" }).kind, "unavailable");
	assert.equal(parseCodeBuddyQuota(null).kind, "unavailable");
	assert.equal(parseCodeBuddyQuota({ code: 0, data: { Packages: [] } }).kind, "unavailable");
	// A package with no capacity numbers at all cannot be rendered.
	assert.equal(parseCodeBuddyQuota({ code: 0, data: { Packages: [{}] } }).kind, "unavailable");
	// Zero-total packages have no meaningful percentage.
	assert.equal(
		parseCodeBuddyQuota({ code: 0, data: { Packages: [{ CycleTotalCapacity: "0", CycleRemainCapacity: "0" }] } })
			.kind,
		"unavailable",
	);
});

test("parses a single package defensively", () => {
	const p = parseCodeBuddyPackage({ PackageCode: "X", CycleTotalCapacity: "10", CycleRemainCapacity: "4" });
	assert.deepEqual(p, { code: "X", unit: "credits", total: 10, remain: 4, used: 0, frozen: 0 });
	assert.equal(parseCodeBuddyPackage({}), null);
	assert.equal(parseCodeBuddyPackage(null), null);
});

test("ttl tightens as the pool drains and is capped by the cycle", () => {
	const healthy = codeBuddyTtlFor({ leftPercent: 90 });
	const low = codeBuddyTtlFor({ leftPercent: 5 });
	assert.ok(low < healthy, `expected ${low} < ${healthy}`);
	assert.ok(healthy <= 600_000, "ttl must never exceed the cycle cap");
});

test("base url honours the env override and trims slashes", () => {
	assert.equal(codeBuddyBaseUrl(), "https://copilot.tencent.com");
	process.env.CODEBUDDY_API_BASE = "https://mirror.example.com///";
	assert.equal(codeBuddyBaseUrl(), "https://mirror.example.com");
	delete process.env.CODEBUDDY_API_BASE;
});

test("renders plan, bar, absolute balance and reset", () => {
	const payload = parseOk(SUMMARY, DETAIL);
	const now = Date.parse("2026-10-12T00:00:00Z");
	const realNow = Date.now;
	Date.now = () => now;
	try {
		const out = renderCodeBuddy(payload, fakeCtx);
		assert.match(out, /^CB 体验版 /);
		assert.match(out, /85%/);
		assert.match(out, /1203\/1408 cr/);
		assert.match(out, /reset /);
		// Free tier is worth flagging so a draining pool is not a surprise.
		assert.match(out, /free/);
	} finally {
		Date.now = realNow;
	}
});

test("drops the free marker once the account is paid", () => {
	const paid = structuredClone(SUMMARY);
	paid.data.IsPaidUser = true;
	const out = renderCodeBuddy(parseOk(paid), fakeCtx);
	assert.doesNotMatch(out, /free/);
});