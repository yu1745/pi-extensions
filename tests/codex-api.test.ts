import assert from "node:assert/strict";
import test from "node:test";
import {
	credentialsFromToken,
	decodeCodexJwtPayload,
	getCodexAccountId,
	parseCodexWindow,
} from "../extensions/shared/codex-api.ts";

function fakeJwt(payload: object): string {
	return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("decodes Codex account identity from an access token", () => {
	const token = fakeJwt({
		"https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
	});
	assert.equal(decodeCodexJwtPayload(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id, "acct-123");
	assert.equal(getCodexAccountId(token), "acct-123");
	assert.deepEqual(credentialsFromToken(token), { accessToken: token, accountId: "acct-123" });
});

test("explicit Codex account id takes precedence over the JWT claim", () => {
	const token = fakeJwt({
		"https://api.openai.com/auth": { chatgpt_account_id: "jwt-account" },
	});
	assert.equal(getCodexAccountId(token, "configured-account"), "configured-account");
});

test("normalizes Codex rate-limit windows and timestamp units", () => {
	assert.deepEqual(
		parseCodexWindow({ used_percent: 37.5, reset_at: 2_000_000_000, limit_window_seconds: 604_800 }),
		{ usedPercent: 37.5, resetAtMs: 2_000_000_000_000, windowSeconds: 604_800 },
	);
	assert.deepEqual(parseCodexWindow({ used_percent: 150, reset_at: 2_000_000_000_000 }), {
		usedPercent: 100,
		resetAtMs: 2_000_000_000_000,
	});
	assert.equal(parseCodexWindow({ reset_at: 2_000_000_000 }), null);
});

test("rejects malformed Codex access tokens", () => {
	assert.equal(decodeCodexJwtPayload("not-a-jwt"), null);
	assert.equal(getCodexAccountId("not-a-jwt"), null);
	assert.equal(credentialsFromToken("not-a-jwt"), null);
});
