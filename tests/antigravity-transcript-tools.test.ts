import assert from "node:assert/strict";
import test from "node:test";
import { createInitialSystemMessage } from "@earendil-works/pi-ai";
import { buildRequest } from "../extensions/antigravity/stream/stream.js";
import { ANTIGRAVITY_MODELS, PROVIDER_ID } from "../extensions/antigravity/models/models.js";

/**
 * Regression guard for the pi 0.86.0 provider contract change.
 *
 * Pi stopped handing providers a raw `Context` (`systemPrompt` / `tools` fields) and
 * now passes a normalized `TranscriptContext` whose prompt and tool declarations live
 * in the transcript's system messages. `buildRequest` kept reading `context.tools`,
 * which silently became `undefined`: the outgoing request carried NO `tools` field at
 * all, so Gemini invented a call to an undeclared function (`read_file`) and the
 * backend rejected the whole turn with `MALFORMED_FUNCTION_CALL`.
 *
 * These assertions are deliberately written against the *outgoing request*, not against
 * `convertTools()`. Testing the schema helper alone is what let the bug ship: the helper
 * was always correct, it just never received any tools.
 */

const READ_TOOL = {
  name: "read",
  description: "Read the contents of a file.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: { path: { type: "string", description: "Path to the file to read" } },
  },
};

/** The provider model object pi hands to `buildRequest`, built from the shipped catalog. */
function model() {
  const config = ANTIGRAVITY_MODELS.find((entry) => entry.id === "gemini-3.8-flash");
  assert.ok(config, "gemini-3.8-flash must exist in ANTIGRAVITY_MODELS");
  return { ...config, provider: PROVIDER_ID, api: "antigravity-api" };
}

/** A transcript shaped the way pi actually builds one: prompt+tools in a system message. */
function transcriptWith(systemPrompt, tools) {
  const head = createInitialSystemMessage(systemPrompt, tools);
  return {
    messages: [
      ...(head ? [head] : []),
      { role: "user", content: [{ type: "text", text: "open the file" }], timestamp: 1 },
    ],
  };
}

function buildOptions() {
  return { reasoning: "low" };
}

test("antigravity: tool declarations from the transcript reach the outgoing request", () => {
  const context = transcriptWith("You are a coding assistant.", [READ_TOOL]);
  const request = buildRequest(model(), context, "test-project", buildOptions(), "gemini-3.8-flash-low");

  const tools = request.request.tools;
  assert.ok(Array.isArray(tools), "request.tools must be present; an absent field means the model has no tools");
  assert.equal(tools.length, 1, `expected 1 declared tool, got ${tools?.length ?? 0}`);
  const declaration = tools[0].functionDeclarations[0];
  assert.equal(declaration.name, "read");
  // agy 1.2.x shape: protobuf Schema types are uppercase enum names.
  assert.equal(declaration.parameters.type, "OBJECT");
  assert.equal(declaration.parameters.properties.path.type, "STRING");
});

test("antigravity: the transcript system prompt reaches systemInstruction", () => {
  const marker = "MARKER-SYSTEM-PROMPT-9c1f";
  const context = transcriptWith(marker, [READ_TOOL]);
  const request = buildRequest(model(), context, "test-project", buildOptions(), "gemini-3.8-flash-low");

  const text = request.request.systemInstruction.parts.map((part) => part.text).join("\n");
  assert.ok(text.includes(marker), "the transcript system prompt must be merged into systemInstruction");
  // The persona and the no-preamble rule must survive alongside it.
  assert.ok(text.includes("Antigravity"), "the Antigravity persona must still be sent");
});

test("antigravity: a transcript with no tools omits the tools field instead of sending an empty one", () => {
  const context = transcriptWith("You are a coding assistant.", undefined);
  const request = buildRequest(model(), context, "test-project", buildOptions(), "gemini-3.8-flash-low");
  assert.equal(request.request.tools, undefined);
});

test("antigravity: the geo-block 400 does not advise a useless re-login", async () => {
  const { friendlyAntigravityError } = await import("../extensions/antigravity/stream/stream.js");
  const body = JSON.stringify({
    error: {
      code: 400,
      message: "User location is not supported for the API use.",
      status: "FAILED_PRECONDITION",
    },
  });
  const message = friendlyAntigravityError(400, body);
  assert.match(message, /proxy|VPN|region/i, "must name the real remedy");
  // The action must not be "run /login antigravity", which cannot change the egress region.
  assert.doesNotMatch(message, /Next:.*\/login antigravity/i, "must not prescribe re-login as the fix");
});
