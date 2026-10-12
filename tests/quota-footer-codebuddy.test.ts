import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	cbCycleMs,
	codeBuddyBaseUrl,
	codeBuddyTtlFor,
	parseCodeBuddyPackage,
	parseCodeBuddyQuota,
	parseCodeBuddyExpiring,
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

/**
 * Captured verbatim from POST /billing/meter/get-user-resource (rows trimmed to
 * the ones that matter). The real account has 11 rows: one subscription pool
 * plus ten referral packs, each on its own clock.
 */
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
						SubProductCode: "sp_tcaca_codebuddy_ide",
						CapacitySize: 500,
						CapacityRemain: 500,
						CycleStartTime: "2026-10-01 00:00:00",
						CycleEndTime: "2026-10-31 23:59:59",
						ExpiredTime: "",
						Status: 0,
					},
					{
						// Drained, and already past its expiry: must never be picked.
						PackageCode: "TCACA_code_007_nzdH5h4Nl0",
						PackageName: "CodeBuddy个人版国内运营裂变包",
						SubProductCode: "sp_tcaca_codebuddyide_bonus_pack",
						CapacitySize: 100,
						CapacityRemain: 0,
						CycleStartTime: "2026-09-15 00:58:38",
						CycleEndTime: "2026-10-15 00:58:37",
						ExpiredTime: "2026-10-09 14:27:03",
						Status: 3,
					},
					{
						// The soonest live pack — this is the one the footer warns about.
						PackageCode: "TCACA_code_007_nzdH5h4Nl0",
						PackageName: "CodeBuddy个人版国内运营裂变包",
						SubProductCode: "sp_tcaca_codebuddyide_bonus_pack",
						CapacitySize: 100,
						CapacityRemain: 2,
						CycleStartTime: "2026-09-16 09:25:38",
						CycleEndTime: "2026-10-16 09:25:37",
						ExpiredTime: "",
						Status: 0,
					},
					{
						PackageCode: "TCACA_code_007_nzdH5h4Nl0",
						PackageName: "CodeBuddy个人版国内运营裂变包",
						SubProductCode: "sp_tcaca_codebuddyide_bonus_pack",
						CapacitySize: 100,
						CapacityRemain: 100,
						CycleStartTime: "2026-09-20 18:21:16",
						CycleEndTime: "2026-10-20 18:21:15",
						ExpiredTime: "",
						Status: 0,
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

test("reads cycle boundaries as UTC+8", () => {
	// "2026-10-31 23:59:59" must be CST, not the process timezone. On a UTC+2
	// box Date.parse() would silently land 6h earlier.
	assert.equal(cbCycleMs("2026-10-31 23:59:59"), Date.parse("2026-10-31T23:59:59+08:00"));
	assert.equal(cbCycleMs("2026-10-01 00:00:00"), Date.parse("2026-10-01T00:00:00+08:00"));
	assert.equal(cbCycleMs("not-a-date"), undefined);
	assert.equal(cbCycleMs(12345), undefined);
});

test("picks the soonest expiring pack, not the biggest one", () => {
	const before = Date.parse("2026-10-12T00:00:00Z");
	// The 2-credit pack expires in ~4 days; the 500-credit pool in ~19 days.
	// Credits burn earliest-expiry-first, so the 2-credit one is the risk.
	const expiring = parseCodeBuddyExpiring(DETAIL, before);
	assert.deepEqual(expiring, { amount: 2, at: Date.parse("2026-10-16T09:25:37+08:00") });
});

test("skips drained packs and ones already past expiry", () => {
	const before = Date.parse("2026-10-12T00:00:00Z");
	// The 100-credit row with ExpiredTime 2026-10-09 is both drained and
	// elapsed; neither state may surface as a warning.
	assert.equal(parseCodeBuddyExpiring(DETAIL, before)?.amount, 2);
	// Once every remaining boundary is in the past there is nothing to warn on.
	assert.equal(parseCodeBuddyExpiring(DETAIL, Date.parse("2026-11-20T00:00:00Z")), undefined);
});

test("ExpiredTime wins over CycleEndTime when both are present", () => {
	const both = structuredClone(DETAIL);
	const row = both.data.Response.Data.Accounts[2];
	row.ExpiredTime = "2026-10-14 08:00:00"; // earlier than its CycleEndTime
	assert.equal(parseCodeBuddyExpiring(both, Date.parse("2026-10-12T00:00:00Z"))?.at, Date.parse("2026-10-14T08:00:00+08:00"));
});

test("a malformed detail payload degrades to no expiry hint", () => {
	assert.equal(parseCodeBuddyExpiring(undefined), undefined);
	assert.equal(parseCodeBuddyExpiring({ data: { Response: { Data: {} } } }), undefined);
	// A row with no parseable date must not become an "expires now" warning.
	assert.equal(parseCodeBuddyExpiring({ data: { Response: { Data: { Accounts: [{ CapacityRemain: 5 }] } } } }), undefined);
});

test("summary alone still works when the detail call fails", () => {
	const payload = parseOk(SUMMARY, null);
	assert.equal(payload.expiring, undefined);
	assert.equal(payload.remain, 1202.78000015);
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

test("ttl is flat because the API reports no percentage to tier on", () => {
	// CodeBuddy has no percentage and no spend-rate signal, so the poll must
	// not vary with the balance.
	for (const leftPercent of [99, 50, 20, 1, 0]) {
		assert.equal(codeBuddyTtlFor({ leftPercent }), 60_000);
	}
	assert.equal(codeBuddyTtlFor(undefined), 60_000);
});

test("base url honours the env override and trims slashes", () => {
	assert.equal(codeBuddyBaseUrl(), "https://copilot.tencent.com");
	process.env.CODEBUDDY_API_BASE = "https://mirror.example.com///";
	assert.equal(codeBuddyBaseUrl(), "https://mirror.example.com");
	delete process.env.CODEBUDDY_API_BASE;
});

test("renders the absolute balance and the soonest expiry countdown", () => {
	const payload = parseOk(SUMMARY, DETAIL, Date.parse("2026-10-12T00:00:00Z"));
	const now = Date.parse("2026-10-12T00:00:00Z");
	const realNow = Date.now;
	Date.now = () => now;
	try {
		const out = renderCodeBuddy(payload, fakeCtx);
		assert.equal(out, "CB 体验版 1203 cr | 2积分会在5d内过期");
		// No percentage, no bar: the API has no percentage and neither do we.
		assert.doesNotMatch(out, /%/);
		assert.doesNotMatch(out, /[█░]/);
	} finally {
		Date.now = realNow;
	}
});

test("hides the expiry hint once nothing is left to expire", () => {
	const drained = structuredClone(SUMMARY);
	drained.data.Packages[0].CycleRemainCapacity = "0";
	drained.data.Packages[0].CycleUsedCapacity = "908";
	// Every detail row is drained, so there is no countdown worth showing.
	for (const row of DETAIL.data.Response.Data.Accounts) row.CapacityRemain = 0;
	const out = renderCodeBuddy(parseOk(drained, DETAIL, Date.parse("2026-10-12T00:00:00Z")), fakeCtx);
	assert.equal(out, "CB 体验版 500 cr");
	assert.doesNotMatch(out, /过期/);
});