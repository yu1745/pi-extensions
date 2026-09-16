import assert from "node:assert/strict";
import test from "node:test";
import {
	ignoreDisposedSession,
	isStaleCtxError,
} from "../extensions/quota-footer/index.ts";

const STALE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The shape that killed the process: a captured ctx whose getters throw once disposed. */
const disposedCtx = () => ({
	get model(): never {
		throw new Error(STALE);
	},
});

test("recognizes pi's disposed-session error and nothing else", () => {
	assert.equal(isStaleCtxError(new Error(STALE)), true);
	assert.equal(isStaleCtxError(STALE), true);
	assert.equal(isStaleCtxError(new Error(`wrapped: ${STALE}`)), true);
	assert.equal(isStaleCtxError(new Error("boom")), false);
	assert.equal(isStaleCtxError(undefined), false);
	assert.equal(isStaleCtxError(null), false);
});

test("reading a disposed ctx really does throw (the original crash trigger)", () => {
	const ctx = disposedCtx();
	assert.throws(() => {
		void ctx.model;
	}, /ctx is stale/);
});

test("background work against a disposed ctx is dropped, not thrown", async () => {
	const ctx = disposedCtx();

	// Sync and async continuations, including a ctx read *after* an await — exactly how
	// refresh() re-enters ctx after its network fetch resolves.
	await ignoreDisposedSession(() => {
		void ctx.model;
	});
	await ignoreDisposedSession(async () => {
		await tick();
		void ctx.model;
	});
});

test("a detached refresh hitting a disposed ctx raises no unhandled rejection", async () => {
	const rejections: unknown[] = [];
	const onUnhandled = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const ctx = disposedCtx();
		// Mirrors scheduleRefresh(): fire-and-forget, nobody awaits the promise.
		void (async () => {
			try {
				await ignoreDisposedSession(async () => {
					await tick();
					void ctx.model;
				});
			} finally {
				/* activeFetch reset */
			}
		})();
		await new Promise((resolve) => setTimeout(resolve, 50));
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	assert.deepEqual(rejections, []);
});

test("real failures still surface to the caller", async () => {
	await assert.rejects(
		() =>
			ignoreDisposedSession(() => {
				throw new Error("boom");
			}),
		/boom/,
	);
	await assert.rejects(
		() =>
			ignoreDisposedSession(async () => {
				await tick();
				throw new Error("async boom");
			}),
		/async boom/,
	);
});
