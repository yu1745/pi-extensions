import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { streamResponse } from "../extensions/antigravity/stream/stream.ts";
import { resolveServedModelCost } from "../extensions/antigravity/models/models.ts";
import { ANTIGRAVITY_API } from "../extensions/antigravity/types/types.ts";
import extension from "../extensions/antigravity/index.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

const MODEL = {
  id: "gemini-3.1-pro",
  name: "Gemini 3.1 Pro (Antigravity)",
  api: ANTIGRAVITY_API,
  provider: "antigravity",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  contextWindow: 1048576,
  maxTokens: 65535,
} as any;

const FLASH_COST = { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 };
const PRO_COST = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 };

function emptyOutput(model = MODEL) {
  return {
    role: "assistant",
    content: [],
    api: ANTIGRAVITY_API,
    provider: "antigravity",
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: 0,
  } as any;
}

/** Minimal SSE Response carrying the given chunk objects. */
function sse(chunks: unknown[]) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

async function run(chunks: unknown[], output = emptyOutput()) {
  const events: any[] = [];
  const stream = createAssistantMessageEventStream();
  stream.push = ((event: unknown) => events.push(event)) as any;
  const hasContent = await streamResponse(MODEL, sse(chunks), stream, output);
  return { output, events, hasContent };
}

// ─── streamResponse: modelVersion -> responseModel ──────────────────────────

test("modelVersion is recorded on responseModel, distinct from the requested model", async () => {
  const { output } = await run([
    {
      response: {
        candidates: [{ content: { role: "model", parts: [{ text: "OK" }] } }],
        usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 1, totalTokenCount: 77 },
        modelVersion: "gemini-3.8-flash-n",
        responseId: "5PbKaonlBL_Y7M8PtYptiAQ",
      },
      traceId: "821725ced935dde7",
    },
  ]);
  assert.equal(output.responseModel, "gemini-3.8-flash-n");
  // The requested id stays put: `model` is the routing label the user picked.
  assert.equal(output.model, "gemini-3.1-pro");
});

test("a chunk without modelVersion leaves responseModel undefined", async () => {
  const { output } = await run([
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }] } },
  ]);
  assert.equal(output.responseModel, undefined);
});

test("modelVersion is read from a bare (unwrapped) chunk too", async () => {
  const { output } = await run([
    { candidates: [], usageMetadata: {}, modelVersion: "gemini-3.5-flash-lite" },
  ]);
  assert.equal(output.responseModel, "gemini-3.5-flash-lite");
});

// ─── pricing: served model, not the requested label ────────────────────────

test("resolveServedModelCost prices by the served id", () => {
  // The real 2026-10 case: Pro requested, Flash weights answered.
  const downgraded = resolveServedModelCost("gemini-3.8-flash-n", MODEL);
  assert.deepEqual(downgraded.rates, FLASH_COST);
  assert.equal(downgraded.pricedBy, "gemini-3.8-flash-n");
  assert.equal(downgraded.unknownServedModel, false);

  // A non-Gemini model that echoes itself keeps its own rates.
  const opus = resolveServedModelCost("claude-opus-4-6-thinking", {
    ...MODEL, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  });
  assert.equal(opus.rates.input, 5);
  assert.equal(opus.rates.output, 25);
});

test("resolveServedModelCost falls back by family, then flags unknown ids", () => {
  const family = resolveServedModelCost("gemini-9-ultra-preview", MODEL);
  assert.deepEqual(family.rates, FLASH_COST);
  assert.equal(family.pricedBy, "gemini-9-ultra-preview*");
  assert.equal(family.unknownServedModel, false);

  // Unknown family: keep the requested rates, but say so instead of guessing.
  const unknown = resolveServedModelCost("some-vendor-model-v9", MODEL);
  assert.deepEqual(unknown.rates, PRO_COST);
  assert.equal(unknown.pricedBy, undefined);
  assert.equal(unknown.unknownServedModel, true);

  // No served model yet (error/aborted before the first chunk): requested rates.
  const none = resolveServedModelCost(undefined, MODEL);
  assert.deepEqual(none.rates, PRO_COST);
  assert.equal(none.unknownServedModel, false);
});

test("usage is priced from modelVersion, not the requested Pro rates", async () => {
  const { output } = await run([
    {
      response: {
        candidates: [{ content: { role: "model", parts: [{ text: "OK" }] } }],
        usageMetadata: {
          promptTokenCount: 1_000_000,
          cachedContentTokenCount: 0,
          candidatesTokenCount: 100_000,
          thoughtsTokenCount: 0,
          totalTokenCount: 1_100_000,
        },
        modelVersion: "gemini-3.8-flash-n",
      },
    },
  ]);
  assert.equal(output.responseModel, "gemini-3.8-flash-n");
  // Flash rates: 1M in * 0.75/M + 100k out * 3.75/M. Pro rates would be 2.45.
  assert.equal(output.usage.cost.input, 0.75);
  assert.equal(output.usage.cost.output, 0.375);
  assert.equal(output.usage.cost.total, 1.125);
});

test("a request whose served model matches keeps identical pricing", async () => {
  const flashModel = { ...MODEL, id: "gemini-3.8-flash", cost: FLASH_COST };
  const output = emptyOutput(flashModel);
  await streamResponse(
    flashModel,
    sse([
      {
        response: {
          candidates: [{ content: { role: "model", parts: [{ text: "OK" }] } }],
          usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 0, totalTokenCount: 1_000_000 },
          modelVersion: "gemini-3.8-flash-n",
        },
      },
    ]),
    { push() {} } as any,
    output,
  );
  assert.equal(output.usage.cost.input, 0.75);
  assert.equal(output.usage.cost.total, 0.75);
});

test("repricing is idempotent across cumulative usage chunks", async () => {
  const { output } = await run([
    {
      response: {
        candidates: [{ content: { role: "model", parts: [{ text: "a" }] } }],
        usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 10_000, totalTokenCount: 1_010_000 },
        modelVersion: "gemini-3.8-flash-n",
      },
    },
    {
      response: {
        candidates: [],
        usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 50_000, totalTokenCount: 1_050_000 },
        modelVersion: "gemini-3.8-flash-n",
      },
    },
  ]);
  // Cumulative metadata, so the final cost must reflect only the last chunk,
  // not the sum of both.
  assert.equal(output.usage.cost.output, (50_000 / 1_000_000) * 3.75);
  assert.equal(output.usage.cost.total, 0.75 + 0.1875);
});

// ─── extension: transcript-only entry ──────────────────────────────────────

function harness() {
  const handlers = new Map<string, Function>();
  const renderers = new Map<string, Function>();
  const entries: any[] = [];
  extension({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: () => {},
    registerProvider: () => {},
    registerEntryRenderer: (customType: string, renderer: Function) =>
      renderers.set(customType, renderer),
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
  } as any);
  const theme = { fg: (_: string, text: string) => text } as any;
  return {
    entries,
    emit: (name: string, data: any) => handlers.get(name)!(data, {}),
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
    render: (customType: string, data: any) =>
      renderers.get(customType)!({ customType, data }, {}, theme),
  };
}

const assistant = (over: Record<string, unknown> = {}) =>
  ({ type: "message_end", message: { role: "assistant", provider: "antigravity", ...over } }) as any;

test("every antigravity reply appends one modelVersion entry", async () => {
  const h = harness();
  await h.emit("message_end", assistant({ model: "gemini-3.1-pro", responseModel: "gemini-3.8-flash-n" }));
  await h.emit("message_end", assistant({ model: "gemini-3.8-flash", responseModel: "gemini-3.8-flash-n" }));
  await h.flush();
  assert.equal(h.entries.length, 2);
  assert.deepEqual(h.entries[0].data, { requested: "gemini-3.1-pro", served: "gemini-3.8-flash-n" });
  assert.deepEqual(h.entries[1].data, { requested: "gemini-3.8-flash", served: "gemini-3.8-flash-n" });
});

test("the append is deferred, so it cannot run before the TUI clears streamingComponent", async () => {
  const h = harness();
  await h.emit("message_end", assistant({ model: "gemini-3.8-flash", responseModel: "gemini-3.8-flash-n" }));
  // Synchronously after the handler returns, nothing is appended yet. This is the
  // whole point: an inline appendEntry would fire here, while the TUI still holds a
  // live streamingComponent, and the entry would render above the message.
  assert.deepEqual(h.entries, []);
  await h.flush();
  assert.equal(h.entries.length, 1);
});

test("no entry for other providers, other roles, or responses with no modelVersion", async () => {
  const h = harness();
  await h.emit("message_end", assistant({ provider: "openai", responseModel: "gpt-5.6" }));
  await h.emit("message_end", assistant({ role: "user", responseModel: "gemini-3.8-flash-n" }));
  await h.emit("message_end", assistant({ model: "gemini-3.8-flash" }));
  await h.flush();
  assert.deepEqual(h.entries, []);
});

test("renderer shows the mismatch, and hides itself without served data", () => {
  const h = harness();
  const mismatch = h.render("antigravity-model-version", {
    requested: "gemini-3.1-pro",
    served: "gemini-3.8-flash-n",
  });
  const line = (mismatch as any).text ?? (mismatch as any).content;
  assert.match(String(line), /asked for gemini-3\.1-pro/);
  assert.match(String(line), /gemini-3\.8-flash-n/);
  // A match is not worth an "asked for" note.
  const match = h.render("antigravity-model-version", {
    requested: "claude-opus-4-6",
    served: "claude-opus-4-6",
  });
  assert.doesNotMatch(String((match as any).text ?? (match as any).content), /asked for/);
  assert.equal(h.render("antigravity-model-version", {}), undefined);
});
