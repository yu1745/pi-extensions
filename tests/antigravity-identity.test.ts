import assert from "node:assert/strict";
import test from "node:test";
import {
  antigravityRequestEnvelope,
  prepareAntigravityRequestIdentity,
} from "../extensions/antigravity/utils/util.js";

const context = (content: unknown[] = []) => ({ systemPrompt: "same", messages: content }) as any;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RANDOM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("equal and empty contexts are isolated by runtime identity", () => {
  for (const messages of [[], [{ role: "user", content: "identical" }]]) {
    const a = prepareAntigravityRequestIdentity(context(messages));
    const b = prepareAntigravityRequestIdentity(context(messages));
    assert.notEqual(a.sessionId, b.sessionId);
    assert.notEqual(a.trajectoryId, b.trajectoryId);
    assert.match(a.trajectoryId, RANDOM_UUID);
    assert.equal(a.step, 2);
    assert.equal(b.step, 2);
  }
});

test("one context remains stable and advances independently of message length", () => {
  const ctx = context([{ role: "user", content: "hello" }]);
  const first = prepareAntigravityRequestIdentity(ctx);
  ctx.messages.length = 0; // Simulate compaction.
  const second = prepareAntigravityRequestIdentity(ctx);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.trajectoryId, first.trajectoryId);
  assert.equal(second.step, first.step + 1);
});

test("explicit session deterministically owns a valid, isolated trajectory", () => {
  const first = prepareAntigravityRequestIdentity(context(), { sessionId: "session-A" });
  const again = prepareAntigravityRequestIdentity(context(), { sessionId: "session-A" });
  const other = prepareAntigravityRequestIdentity(context(), { sessionId: "session-B" });
  assert.equal(first.sessionId, "session-A");
  assert.equal(again.trajectoryId, first.trajectoryId);
  assert.equal(again.step, first.step + 1);
  assert.notEqual(other.trajectoryId, first.trajectoryId);
  assert.match(first.trajectoryId, UUID);
});

test("explicit trajectory is honored and gets its own counter", () => {
  const opts = { sessionId: "session-C", trajectoryId: "caller-trajectory" };
  const first = prepareAntigravityRequestIdentity(context(), opts);
  const second = prepareAntigravityRequestIdentity(context(), opts);
  assert.equal(first.trajectoryId, opts.trajectoryId);
  assert.equal(second.step, 3);
});

test("retry envelope reuse preserves step labels", () => {
  const identity = prepareAntigravityRequestIdentity(context());
  const first = antigravityRequestEnvelope("gemini-2.5-pro", false, identity);
  const retry = antigravityRequestEnvelope("gemini-2.5-pro", false, identity);
  assert.equal(first.sessionId, retry.sessionId);
  assert.equal(first.labels.trajectory_id, retry.labels.trajectory_id);
  assert.equal(first.labels.last_step_index, retry.labels.last_step_index);
  assert.equal(first.labels.last_step_index, "1");
  assert.notEqual(first.requestId, retry.requestId);
});
