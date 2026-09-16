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
    assert.equal(a.callIndex, 1);
    assert.equal(b.callIndex, 1);
    assert.equal(a.isNewTrajectory, true);
    assert.equal(b.isNewTrajectory, true);
  }
});

test("one context remains stable and advances independently of message length", () => {
  const ctx = context([{ role: "user", content: "hello" }]);
  const first = prepareAntigravityRequestIdentity(ctx);
  ctx.messages.length = 0; // Simulate compaction.
  const second = prepareAntigravityRequestIdentity(ctx);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.trajectoryId, first.trajectoryId);
  assert.equal(second.callIndex, first.callIndex + 1);
  assert.equal(second.isNewTrajectory, false);
});

test("explicit session deterministically owns a valid, isolated trajectory", () => {
  const first = prepareAntigravityRequestIdentity(context(), { sessionId: "session-A" });
  const again = prepareAntigravityRequestIdentity(context(), { sessionId: "session-A" });
  const other = prepareAntigravityRequestIdentity(context(), { sessionId: "session-B" });
  assert.equal(first.sessionId, "session-A");
  assert.equal(again.trajectoryId, first.trajectoryId);
  assert.equal(again.callIndex, first.callIndex + 1);
  assert.notEqual(other.trajectoryId, first.trajectoryId);
  assert.match(first.trajectoryId, UUID);
});

test("explicit trajectory is honored and gets its own counter", () => {
  const opts = { sessionId: "session-C", trajectoryId: "caller-trajectory" };
  const first = prepareAntigravityRequestIdentity(context(), opts);
  const second = prepareAntigravityRequestIdentity(context(), opts);
  assert.equal(first.trajectoryId, opts.trajectoryId);
  assert.equal(first.callIndex, 1);
  assert.equal(second.callIndex, 2);
});

test("envelope reproduces the agy 1.2.4 agent labels", () => {
  const identity = prepareAntigravityRequestIdentity(context());
  const envelope = antigravityRequestEnvelope("gemini-3.6-flash-low", {
    isClaude: false,
    isNonGeminiModel: false,
    sessionId: identity.sessionId,
    trajectoryId: identity.trajectoryId,
    callIndex: identity.callIndex,
    step: 1,
    conversationId: "conversation-id",
  });

  assert.equal(envelope.sessionId, identity.sessionId);
  assert.match(
    envelope.requestId,
    new RegExp(`^agent/conversation-id/\\d+/${identity.trajectoryId}/1$`),
  );
  assert.deepEqual(envelope.labels, {
    last_step_index: "0",
    model_enum: "MODEL_PLACEHOLDER_M73",
    request_id: `${identity.trajectoryId}-0`,
    trajectory_id: identity.trajectoryId,
    used_claude: "false",
    used_claude_conservative: "false",
    used_non_gemini_model: "false",
  });
});

test("envelope advances step and callIndex like the CLI's tool round-trip", () => {
  const ctx = context();
  const first = prepareAntigravityRequestIdentity(ctx);
  const second = prepareAntigravityRequestIdentity(ctx);
  assert.equal(first.callIndex, 1);
  assert.equal(second.callIndex, 2);
  assert.equal(second.isNewTrajectory, false);
  const envelope = antigravityRequestEnvelope("gemini-3.8-flash-medium", {
    isClaude: false,
    sessionId: second.sessionId,
    trajectoryId: second.trajectoryId,
    callIndex: second.callIndex,
    step: 3,
  });
  assert.equal(envelope.labels.last_step_index, "2");
  assert.equal(envelope.labels.request_id, `${second.trajectoryId}-1`);
  assert.equal(envelope.labels.model_enum, "MODEL_PLACEHOLDER_M319");
  assert.match(envelope.requestId, /\/3$/);
});

test("envelope flags Claude and GPT-OSS as non-Gemini", () => {
  const identity = prepareAntigravityRequestIdentity(context());
  const base = {
    sessionId: identity.sessionId,
    trajectoryId: identity.trajectoryId,
    callIndex: identity.callIndex,
    step: 1,
  };
  const claude = antigravityRequestEnvelope("claude-sonnet-4-6", {
    ...base,
    isClaude: true,
    isNonGeminiModel: true,
  });
  assert.equal(claude.labels.used_claude, "true");
  assert.equal(claude.labels.used_claude_conservative, "true");
  assert.equal(claude.labels.used_non_gemini_model, "true");
  assert.equal(claude.labels.model_enum, "MODEL_PLACEHOLDER_M35");

  const gptOss = antigravityRequestEnvelope("gpt-oss-120b-medium", {
    ...base,
    isClaude: false,
    isNonGeminiModel: true,
  });
  assert.equal(gptOss.labels.used_claude, "false");
  assert.equal(gptOss.labels.used_non_gemini_model, "true");
  assert.equal(gptOss.labels.model_enum, "MODEL_OPENAI_GPT_OSS_120B_MEDIUM");
});

test("unknown runtime models omit model_enum instead of guessing one", () => {
  const identity = prepareAntigravityRequestIdentity(context());
  const envelope = antigravityRequestEnvelope("gemini-9.9-flash-low", {
    isClaude: false,
    sessionId: identity.sessionId,
    trajectoryId: identity.trajectoryId,
    callIndex: identity.callIndex,
    step: 1,
  });
  assert.equal("model_enum" in envelope.labels, false);
});

test("retry envelope reuse preserves step labels", () => {
  const identity = prepareAntigravityRequestIdentity(context());
  const options = {
    isClaude: false,
    sessionId: identity.sessionId,
    trajectoryId: identity.trajectoryId,
    callIndex: identity.callIndex,
    step: 1,
  };
  const first = antigravityRequestEnvelope("gemini-3.7-flash-low", options);
  // Transport retries of one logical call reuse the identity, so the requestId is stable.
  const retry = antigravityRequestEnvelope("gemini-3.7-flash-low", options);
  assert.equal(first.sessionId, retry.sessionId);
  assert.equal(first.labels.trajectory_id, retry.labels.trajectory_id);
  assert.equal(first.labels.last_step_index, retry.labels.last_step_index);
  assert.equal(first.labels.request_id, retry.labels.request_id);
  assert.equal(first.labels.last_step_index, "0");
  assert.equal(first.requestId, retry.requestId);

  // The next call in the trajectory is a distinct request.
  const next = antigravityRequestEnvelope("gemini-3.7-flash-low", {
    ...options,
    callIndex: options.callIndex + 1,
    step: 3,
  });
  assert.notEqual(next.requestId, first.requestId);
  assert.equal(next.labels.request_id, `${identity.trajectoryId}-1`);
});
