import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	fetchRiver,
	fetchRiverBalance,
	keepRiverSessionWarm,
	mintRiverAccessToken,
	parseRiverAccount,
	persistRiverStore,
	readRiverStore,
	readSetCookie,
	renderRiver,
	riverCredentialId,
	riverKeepAliveDue,
	riverTtlFor,
	seedRiverSession,
} from "../extensions/quota-footer.ts";

/** Captured verbatim from GET https://console.river.ai/api/billing/account. */
const ACCOUNT = {
	owner_email: "wangyu17455@gmail.com",
	balance_micro_usd: 24908195,
	balance_usd: 24.908195,
	credit_limit_micro_usd: 0,
	credit_limit_usd: 0.0,
	status: "active",
	low_balance_threshold_micro_usd: null,
	low_balance_threshold_usd: null,
	created_at: "2026-10-13T18:24:37.118388Z",
	updated_at: "2026-10-14T14:02:55.314793Z",
};

/** Captured verbatim from the Console when the Bearer token is rejected. */
const UNAUTHORIZED = { error: "unauthorized", message: "invalid WorkOS access token: InvalidSignature" };

const fakeCtx = { ui: { theme: { fg: (_color: string, text: string) => text } } } as unknown as ExtensionContext;

const CLIENT_ID = "client_01M0TG5W3GBNMFS87K40PYHM98";

function b64url(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A structurally valid JWT — only `exp` is ever read. */
function jwt(expSeconds: number): string {
	return `${b64url({ alg: "RS256", kid: "test" })}.${b64url({ sub: "user_1", exp: expSeconds })}.sig`;
}

function tempStore(): string {
	return join(mkdtempSync(join(tmpdir(), "river-quota-")), "river-session.json");
}

interface Call {
	url: string;
	body: any;
	headers: Record<string, string>;
}

/** Records every request and answers per-path. */
function mockFetch(handler: (call: Call, index: number) => { status: number; json?: any; setCookie?: string[] }): {
	calls: Call[];
	impl: typeof fetch;
} {
	const calls: Call[] = [];
	const impl = (async (url: any, init: any = {}) => {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(init.headers ?? {})) headers[key.toLowerCase()] = String(value);
		const call: Call = {
			url: String(url),
			body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
			headers,
		};
		calls.push(call);
		const { status, json, setCookie } = handler(call, calls.length - 1);
		const responseHeaders = new Headers({ "Content-Type": "application/json" });
		for (const cookie of setCookie ?? []) responseHeaders.append("set-cookie", cookie);
		return new Response(json === undefined ? "" : JSON.stringify(json), { status, headers: responseHeaders });
	}) as unknown as typeof fetch;
	return { calls, impl };
}

const AUTH_URL = "https://auth.console.river.ai/user_management/authenticate";
const BALANCE_URL = "https://console.river.ai/api/billing/account";

// ─── parsing ─────────────────────────────────────────────────────────────────

test("parseRiverAccount reads the live balance payload", () => {
	const result = parseRiverAccount(ACCOUNT, 1_000);
	assert.equal(result.kind, "success");
	const payload = (result as any).payload;
	assert.equal(payload.balanceUsd, 24.908195);
	assert.equal(payload.creditLimitUsd, 0);
	assert.equal(payload.status, "active");
	assert.equal(payload.ownerEmail, "wangyu17455@gmail.com");
	assert.equal(payload.lowBalanceThresholdUsd, undefined);
	assert.equal(payload.updatedAt, "2026-10-14T14:02:55.314793Z");
});

test("parseRiverAccount falls back to micro_usd when only micros are present", () => {
	const result = parseRiverAccount({ ...ACCOUNT, balance_usd: undefined, balance_micro_usd: 2_500_000 });
	assert.equal((result as any).payload.balanceUsd, 2.5);
});

test("parseRiverAccount classifies a rejected Bearer token as auth_error", () => {
	assert.equal(parseRiverAccount(UNAUTHORIZED).kind, "auth_error");
	assert.equal(parseRiverAccount({ error: "rate_limited", message: "too many requests" }).kind, "rate_limited");
	assert.equal(parseRiverAccount({}).kind, "unavailable");
	assert.equal(parseRiverAccount(null).kind, "unavailable");
});

test("riverTtlFor polls tighter as the balance drains", () => {
	assert.equal(riverTtlFor({ balanceUsd: 42 }), 300_000);
	assert.equal(riverTtlFor({ balanceUsd: 9.99 }), 60_000);
	assert.equal(riverTtlFor({ balanceUsd: 0 }), 60_000);
	assert.equal(riverTtlFor(null), 60_000);
});

test("renderRiver shows an absolute USD balance and honours the account threshold", () => {
	const out = renderRiver((parseRiverAccount(ACCOUNT) as any).payload, fakeCtx);
	assert.match(out, /River/);
	assert.match(out, /\$24\.91/);

	const low = renderRiver(
		(parseRiverAccount({ ...ACCOUNT, balance_usd: 0.5, low_balance_threshold_usd: 1 }) as any).payload,
		fakeCtx,
	);
	assert.match(low, /\$0\.50/);

	const inactive = renderRiver((parseRiverAccount({ ...ACCOUNT, status: "suspended" }) as any).payload, fakeCtx);
	assert.match(inactive, /suspended/);

	const credit = renderRiver((parseRiverAccount({ ...ACCOUNT, credit_limit_usd: 10 }) as any).payload, fakeCtx);
	assert.match(credit, /limit/);
});

test("readSetCookie picks the sealed session out of a folded Set-Cookie header", () => {
	const headers = new Headers();
	headers.append("set-cookie", "workos-has-session=client_01; Path=/");
	headers.append("set-cookie", "wos-session=Fe26.2**abc; Domain=console.river.ai; Path=/user_management");
	const res = new Response("", { headers });
	assert.equal(readSetCookie(res, "wos-session"), "Fe26.2**abc");
	assert.equal(readSetCookie(res, "missing"), undefined);
});

// ─── auth ────────────────────────────────────────────────────────────────────

test("mintRiverAccessToken exchanges a refresh token and captures rotation", async () => {
	const { calls, impl } = mockFetch(() => ({
		status: 200,
		json: { user: { email: "wangyu17455@gmail.com" }, access_token: jwt(1_700), refresh_token: "head-2" },
		setCookie: ["wos-session=Fe26.2**rotated; Domain=console.river.ai; Path=/user_management"],
	}));
	const result = await mintRiverAccessToken(
		{ refresh_token: "head-1" },
		{ fetchImpl: impl, authBase: "auth.console.river.ai", clientId: CLIENT_ID, now: () => 1_000 },
	);
	assert.equal(result.ok, true);
	const token = (result as any).token;
	assert.equal(token.refreshToken, "head-2");
	assert.equal(token.wosSession, "Fe26.2**rotated");
	assert.equal(token.email, "wangyu17455@gmail.com");
	assert.equal(token.expiresAt, 1_700_000);
	assert.equal(calls[0].url, AUTH_URL);
	assert.deepEqual(calls[0].body, { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: "head-1" });
});

test("mintRiverAccessToken falls back to the sealed cookie when the token half is spent", async () => {
	const { calls, impl } = mockFetch((call) => {
		if (call.headers.cookie) return { status: 200, json: { access_token: jwt(1_700) } };
		return { status: 400, json: { error: "invalid_grant", error_description: "Refresh token already exchanged." } };
	});
	const result = await mintRiverAccessToken(
		{ refresh_token: "spent", wos_session: "Fe26.2**sealed" },
		{ fetchImpl: impl, authBase: "auth.console.river.ai", clientId: CLIENT_ID, now: () => 1_000 },
	);
	assert.equal(result.ok, true);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].headers.cookie, undefined);
	assert.equal(calls[1].headers.cookie, "wos-session=Fe26.2**sealed");
	// The cookie grant carries no refresh_token in the body.
	assert.deepEqual(calls[1].body, { grant_type: "refresh_token", client_id: CLIENT_ID });
});

test("mintRiverAccessToken reports a spent chain as auth_error, never as unavailable", async () => {
	const { impl } = mockFetch(() => ({
		status: 400,
		json: { error: "invalid_grant", error_description: "Refresh token already exchanged." },
	}));
	const result = await mintRiverAccessToken(
		{ refresh_token: "spent", wos_session: "Fe26.2**stale" },
		{ fetchImpl: impl, authBase: "auth.console.river.ai", clientId: CLIENT_ID },
	);
	assert.deepEqual(result, { ok: false, kind: "auth_error" });
});

test("mintRiverAccessToken surfaces WorkOS rate limiting", async () => {
	const { impl } = mockFetch(() => ({ status: 429, json: { error: "rate_limited" } }));
	const result = await mintRiverAccessToken(
		{ refresh_token: "head" },
		{ fetchImpl: impl, authBase: "auth.console.river.ai", clientId: CLIENT_ID },
	);
	assert.deepEqual(result, { ok: false, kind: "rate_limited" });
});

// ─── store / renewal ─────────────────────────────────────────────────────────

test("fetchRiverBalance reuses a live access token instead of advancing the chain", async () => {
	const storeFile = tempStore();
	const { calls, impl } = mockFetch(() => ({ status: 200, json: ACCOUNT }));
	const result = await fetchRiverBalance(
		{ refresh_token: "head-1", access_token: jwt(2_000), access_expires_at: 2_000_000 },
		{ fetchImpl: impl, authBase: AUTH_URL, clientId: CLIENT_ID, storeFile, noSeed: true, now: () => 1_000_000 },
	);
	assert.equal(result.kind, "success");
	// Exactly one request: the cached token was still good for another 1000s.
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, BALANCE_URL);
	assert.equal(calls[0].headers.authorization, `Bearer ${jwt(2_000)}`);
});

test("fetchRiverBalance mints when the cached token is inside the skew window and rotates the head on disk", async () => {
	const storeFile = tempStore();
	const { calls, impl } = mockFetch((call) => {
		if (call.url === BALANCE_URL) return { status: 200, json: ACCOUNT };
		return { status: 200, json: { access_token: jwt(1_300), refresh_token: "head-2" } };
	});
	const result = await fetchRiverBalance(
		// 30s of life left — below the 60s skew, so it must be re-minted.
		{ refresh_token: "head-1", access_token: jwt(1_030), access_expires_at: 1_030_000 },
		{ fetchImpl: impl, authBase: "auth.console.river.ai", clientId: CLIENT_ID, storeFile, noSeed: true, now: () => 1_000_000 },
	);
	assert.equal(result.kind, "success");
	assert.deepEqual(
		calls.map((c) => c.url),
		[AUTH_URL, BALANCE_URL],
	);
	const saved = JSON.parse(readFileSync(storeFile, "utf8"));
	assert.equal(saved.refresh_token, "head-2");
	assert.equal(saved.access_expires_at, 1_300_000);
	assert.equal(statSync(storeFile).mode & 0o777, 0o600);
});

test("fetchRiver degrades to auth_error when the store is unreadable", async () => {
	const storeFile = tempStore();
	writeFileSync(storeFile, "{ not json");
	const result = await fetchRiver("river:unknown", { storeFile, noSeed: true });
	assert.equal(result.kind, "auth_error");
});

test("fetchRiver recovers when another process rotated the single-use chain mid-flight", async () => {
	const storeFile = tempStore();
	persistRiverStore({ refresh_token: "spent-head", email: "wangyu17455@gmail.com" }, { storeFile, noSeed: true });
	let rotated = false;
	const { calls, impl } = mockFetch((call) => {
		if (call.url === BALANCE_URL) return { status: 200, json: ACCOUNT };
		const offered = call.body?.refresh_token ?? call.headers.cookie;
		if (!rotated) {
			// Stand in for the other pi process: it advanced the chain and persisted
			// the new head while we were in flight.
			rotated = true;
			persistRiverStore({ refresh_token: "fresh-head" }, { storeFile, noSeed: true });
			return { status: 400, json: { error: "invalid_grant", error_description: "Refresh token already exchanged." } };
		}
		assert.equal(offered, "fresh-head");
		return { status: 200, json: { access_token: jwt(1_700), refresh_token: "fresh-head-2" } };
	});
	const result = await fetchRiver("river:wangyu17455@gmail.com", {
		fetchImpl: impl,
		authBase: "auth.console.river.ai",
		clientId: CLIENT_ID,
		storeFile,
		noSeed: true,
		now: () => 1_000_000,
	});
	assert.equal(result.kind, "success");
	assert.equal(calls.filter((c) => c.url === AUTH_URL).length, 2);
	assert.equal(JSON.parse(readFileSync(storeFile, "utf8")).refresh_token, "fresh-head-2");
});

test("fetchRiver replays the same head once, then records it as dead so a re-seed can take over", async () => {
	const storeFile = tempStore();
	persistRiverStore(
		{ refresh_token: "spent-head", wos_session: "Fe26.2**spent", email: "wangyu17455@gmail.com" },
		{ storeFile, noSeed: true },
	);
	const { calls, impl } = mockFetch(() => ({
		status: 400,
		json: { error: "invalid_grant", error_description: "Refresh token already exchanged." },
	}));
	const deps = {
		fetchImpl: impl,
		authBase: "auth.console.river.ai",
		clientId: CLIENT_ID,
		storeFile,
		noSeed: true,
		now: () => 1_000_000,
	};

	const first = await fetchRiver("river:wangyu17455@gmail.com", deps);
	assert.equal(first.kind, "auth_error");
	// Body grant then cookie fallback — both against the spent head, and no more.
	assert.equal(calls.filter((c) => c.url === AUTH_URL).length, 2);

	// The dead head is recorded, and the session itself is preserved so a re-seed
	// does not have to start from an empty file.
	const saved = JSON.parse(readFileSync(storeFile, "utf8"));
	assert.equal(saved.head_dead, "spent-head");
	assert.equal(saved.refresh_token, "spent-head");

	// With the head marked dead, a freshly seeded session is picked up without
	// deleting anything.
	process.env.RIVER_WOS_SESSION = "Fe26.2**fresh-cookie";
	try {
		assert.equal(readRiverStore({ storeFile })?.wos_session, "Fe26.2**fresh-cookie");
	} finally {
		delete process.env.RIVER_WOS_SESSION;
	}
});

test("fetchRiver does not mark the head dead on a transient failure", async () => {
	const storeFile = tempStore();
	persistRiverStore({ refresh_token: "good-head" }, { storeFile, noSeed: true });
	const { impl } = mockFetch(() => ({ status: 503, json: { error: "service_unavailable" } }));
	const result = await fetchRiver("river:console", {
		fetchImpl: impl,
		authBase: "auth.console.river.ai",
		clientId: CLIENT_ID,
		storeFile,
		noSeed: true,
	});
	assert.equal(result.kind, "unavailable");
	const saved = JSON.parse(readFileSync(storeFile, "utf8"));
	assert.equal(saved.head_dead, undefined);
	assert.equal(saved.refresh_token, "good-head");
});

test("riverCredentialId keys the cache on the account, not the rotating head", () => {
	const storeFile = tempStore();
	assert.equal(riverCredentialId({ storeFile, noSeed: true }), undefined);
	persistRiverStore({ refresh_token: "head-1", email: "wangyu17455@gmail.com" }, { storeFile, noSeed: true });
	const before = riverCredentialId({ storeFile, noSeed: true });
	persistRiverStore({ refresh_token: "head-2" }, { storeFile, noSeed: true });
	const after = riverCredentialId({ storeFile, noSeed: true });
	assert.equal(before, "river:wangyu17455@gmail.com");
	assert.equal(after, before);
});

// ─── keep-alive / re-seed ────────────────────────────────────────────────────

test("riverKeepAliveDue only fires once the inactivity window has passed", () => {
	const storeFile = tempStore();
	const deps = { storeFile, noSeed: true, now: () => 1_700_000_000_000 };
	assert.equal(riverKeepAliveDue(deps), false);

	// A fresh successful exchange — $ from the timer's point of view.
	persistRiverStore(
		{ refresh_token: "head", refreshed_at: new Date(1_700_000_000_000).toISOString() },
		{ storeFile, noSeed: true },
	);
	assert.equal(riverKeepAliveDue(deps), false);

	const later = { ...deps, now: () => 1_700_000_000_000 + 61 * 60_000 };
	assert.equal(riverKeepAliveDue(later), true);

	process.env.RIVER_KEEPALIVE = "0";
	try {
		assert.equal(riverKeepAliveDue(later), false);
	} finally {
		delete process.env.RIVER_KEEPALIVE;
	}
});

test("keepRiverSessionWarm exchanges the session when it is due, and swallows failures", async () => {
	const storeFile = tempStore();
	persistRiverStore(
		{ refresh_token: "head-1", refreshed_at: new Date(0).toISOString() },
		{ storeFile, noSeed: true },
	);
	const { calls, impl } = mockFetch((call) =>
		call.url === BALANCE_URL
			? { status: 200, json: ACCOUNT }
			: { status: 200, json: { access_token: jwt(1_700), refresh_token: "head-2" } },
	);
	await keepRiverSessionWarm({
		fetchImpl: impl,
		authBase: "auth.console.river.ai",
		clientId: CLIENT_ID,
		storeFile,
		noSeed: true,
		now: () => 1_700_000_000_000,
	});
	assert.deepEqual(
		calls.map((c) => c.url),
		[AUTH_URL, BALANCE_URL],
	);
	assert.equal(JSON.parse(readFileSync(storeFile, "utf8")).refresh_token, "head-2");

	// A dead session must not throw into the caller's event loop.
	const failing = mockFetch(() => ({ status: 500, json: {} }));
	await keepRiverSessionWarm({
		fetchImpl: failing.impl,
		authBase: "auth.console.river.ai",
		clientId: CLIENT_ID,
		storeFile,
		noSeed: true,
	});
});

test("seedRiverSession accepts a cookie or a bare refresh token and replaces the store", () => {
	const storeFile = tempStore();
	const deps = { storeFile, noSeed: true };
	persistRiverStore({ refresh_token: "old", wos_session: "Fe26.2**old", head_dead: "old" }, deps);

	assert.equal(seedRiverSession("", deps), false);
	assert.equal(readRiverStore(deps)?.refresh_token, "old");

	assert.equal(seedRiverSession("wos-session=Fe26.2**new; Domain=console.river.ai", deps), true);
	const seeded = JSON.parse(readFileSync(storeFile, "utf8"));
	assert.equal(seeded.wos_session, "Fe26.2**new");
	// A reset drops the old session's head, its cached token and its dead marker.
	assert.equal(seeded.refresh_token, undefined);
	assert.equal(seeded.head_dead, undefined);

	assert.equal(seedRiverSession("fresh-refresh-token", deps), true);
	assert.equal(JSON.parse(readFileSync(storeFile, "utf8")).refresh_token, "fresh-refresh-token");
});
