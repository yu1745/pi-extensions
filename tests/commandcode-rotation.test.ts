import assert from "node:assert/strict"
import test from "node:test"
import { createRotatingCommandCodeStream } from "../extensions/commandcode/src/rotation.ts"
import { createCommandCodeTransportRouter } from "../extensions/commandcode/src/transport.ts"
import { createStreamCommandCode } from "../extensions/commandcode/src/core.ts"
import type {
  AssistantMessageEvent as Event,
  AssistantMessageEventStreamLike as Stream,
  AssistantMessageLike,
  ModelLike,
  StreamOptions,
} from "../extensions/commandcode/src/types.ts"
import type { CommandCodeAccountManager } from "../extensions/commandcode/src/account-manager.ts"

type Manager = Pick<CommandCodeAccountManager, "accounts" | "getActiveAccount" | "refresh">
const model: ModelLike = {
  id: "test-model",
  api: "test",
  provider: "commandcode",
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
function message(content: AssistantMessageLike["content"] = []): AssistantMessageLike {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  }
}
function queue(): Stream {
  const items: Event[] = []
  const pending: Array<(result: IteratorResult<Event>) => void> = []
  let ended = false
  return {
    push(event) {
      assert.equal(ended, false, "push after end")
      const resolve = pending.shift()
      if (resolve) resolve({ value: event, done: false })
      else items.push(event)
    },
    end() {
      ended = true
      for (const resolve of pending.splice(0)) resolve({ value: undefined, done: true })
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          const value = items.shift()
          if (value) return Promise.resolve({ value, done: false })
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => pending.push(resolve))
        },
        return() {
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
}
const start = (): Event => ({ type: "start", partial: message() })
const done = (): Event => ({ type: "done", reason: "stop", message: message() })
const failure = (text = "quota exceeded", partial = message()): Event => ({
  type: "error",
  reason: "error",
  error: { ...partial, stopReason: "error", errorMessage: text },
})
function producer(run: (stream: Stream) => Promise<void> | void): Stream {
  const stream = queue()
  void Promise.resolve()
    .then(() => run(stream))
    .catch((error) => stream.push(failure(String(error))))
    .finally(() => stream.end())
  return stream
}
async function collect(stream: Stream): Promise<Event[]> {
  const events: Event[] = []
  for await (const event of stream) events.push(event)
  return events
}
function terminal(events: Event[], kind: "done" | "error") {
  const terminals = events.filter((event) => event.type === "done" || event.type === "error")
  assert.equal(terminals.length, 1, "exactly one terminal event")
  assert.equal(terminals[0].type, kind)
  assert.equal(events.at(-1), terminals[0])
  return terminals[0]
}
function fakeManager(status: "exhausted" | "available" | "unknown" = "exhausted") {
  const accounts = ["a", "b"].map((id) => ({
    id,
    apiKey: `fixture-secret-${id}-123456789`,
    fingerprint: `fingerprint-${id}`,
  }))
  const refreshed: string[] = [],
    selections: string[][] = []
  let active = accounts[0]
  const manager: Manager = {
    accounts,
    async getActiveAccount(excluded = new Set()) {
      selections.push([...excluded])
      const account = [active, ...accounts.filter((a) => a !== active)].find(
        (a) => !excluded.has(a.id),
      )
      if (!account) throw new Error("accounts unavailable: exhausted")
      active = account
      return account
    },
    async refresh(account) {
      refreshed.push(account.id)
      if (status === "unknown") return { status, reason: "unavailable" }
      if (status === "available") return { status, observedAt: 1 }
      return { status, observedAt: 1, recheckAt: 100, reasons: ["quota exceeded"] }
    },
  }
  return { manager, refreshed, selections, accounts }
}
type Attempt = { status?: number; text?: string; partial?: Event; success?: boolean }
function fixture(plans: Attempt[], status: "exhausted" | "available" | "unknown" = "exhausted") {
  const fake = fakeManager(status)
  const calls: StreamOptions[] = []
  const stream = (_model: ModelLike, _context: unknown, options: StreamOptions = {}) =>
    producer(async (output) => {
      const plan = plans[calls.length]
      calls.push(options)
      assert.ok(plan, "unexpected replay")
      output.push(start())
      if (plan.status) await options.fetch!("https://fixture.invalid", {})
      if (plan.partial) output.push(plan.partial)
      output.push(
        plan.success
          ? done()
          : failure(
              plan.text,
              plan.partial && "partial" in plan.partial ? plan.partial.partial : undefined,
            ),
      )
    })
  const fetchMock: typeof fetch = async () =>
    new Response("", { status: plans[calls.length - 1].status ?? 200 })
  return {
    ...fake,
    calls,
    stream,
    fetchMock,
    rotate: (extra = {}) =>
      createRotatingCommandCodeStream({
        createStream: queue,
        stream,
        manager: fake.manager,
        delay: async () => {},
        ...extra,
      }),
  }
}

test("successful requests remain sticky and never verify quota", { timeout: 1000 }, async () => {
  const f = fixture([{ success: true }, { success: true }])
  const stream = f.rotate()
  for (let i = 0; i < 2; i++) terminal(await collect(stream(model, {})), "done")
  assert.deepEqual(
    f.calls.map((o) => o.apiKey),
    [f.accounts[0].apiKey, f.accounts[0].apiKey],
  )
  assert.deepEqual(f.refreshed, [])
})
for (const status of [429, 200])
  test(
    `${status} quota failure confirmed exhausted rotates once and suppresses failed terminal`,
    { timeout: 1000 },
    async () => {
      const f = fixture([
        { status, text: status === 429 ? "too many requests" : "insufficient credits" },
        { success: true },
        { success: true },
      ])
      const stream = f.rotate()
      const events = await collect(stream(model, {}, { fetch: f.fetchMock, maxRetries: 3 }))
      terminal(events, "done")
      assert.equal(events.filter((e) => e.type === "start").length, 1)
      assert.deepEqual(f.refreshed, ["a"])
      assert.deepEqual(f.selections, [[], ["a"]])
      terminal(await collect(stream(model, {}, { fetch: f.fetchMock })), "done")
      assert.deepEqual(
        f.calls.map((o) => o.apiKey),
        [f.accounts[0].apiKey, f.accounts[1].apiKey, f.accounts[1].apiKey],
      )
      assert.ok(f.calls.every((o) => o.maxRetries === 0))
    },
  )
for (const status of ["available", "unknown"] as const)
  test(`${status} verification preserves original 429 error, without retry`, async () => {
    const f = fixture([{ status: 429, text: "original upstream diagnostic" }], status)
    const result = terminal(
      await collect(f.rotate()(model, {}, { fetch: f.fetchMock, maxRetries: 10 })),
      "error",
    )
    assert.equal(
      result.type === "error" && result.error.errorMessage,
      "original upstream diagnostic",
    )
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.refreshed, ["a"])
  })
test(
  "all exhausted accounts terminate finitely with original diagnostic and no repeated account",
  { timeout: 1000 },
  async () => {
    const f = fixture([{ status: 429 }, { status: 429 }])
    const result = terminal(
      await collect(f.rotate()(model, {}, { fetch: f.fetchMock, maxRetries: 100 })),
      "error",
    )
    assert.equal(f.calls.length, 2)
    assert.deepEqual(f.refreshed, ["a", "b"])
    assert.deepEqual(f.selections, [[], ["a"], ["a", "b"]])
    assert.match(
      result.type === "error" ? result.error.errorMessage! : "",
      /quota exceeded.*\n.*accounts unavailable/,
    )
  },
)
for (const type of ["text_delta", "thinking_delta", "toolcall_delta"] as const) {
  for (const status of [200, 503])
    test(`${type} forbids quota rotation and ordinary retry (${status})`, async () => {
      const content: AssistantMessageLike["content"] =
        type === "text_delta"
          ? [{ type: "text", text: "visible" }]
          : type === "thinking_delta"
            ? [{ type: "thinking", thinking: "visible" }]
            : [{ type: "toolCall", id: "call", name: "tool", arguments: {} }]
      const partial: Event = { type, contentIndex: 0, delta: "visible", partial: message(content) }
      const f = fixture([
        { status, text: status === 200 ? "quota exceeded" : "server failure", partial },
      ])
      const events = await collect(f.rotate()(model, {}, { fetch: f.fetchMock, maxRetries: 5 }))
      const result = terminal(events, "error")
      assert.equal(f.calls.length, 1)
      assert.equal(events.filter((e) => e.type === type).length, 1)
      assert.deepEqual(result.type === "error" && result.error.content, content)
    })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
for (const phase of ["verification", "retry delay"] as const)
  test(`cancellation during ${phase} terminates without replay`, { timeout: 1000 }, async () => {
    const f = fixture([{ status: phase === "verification" ? 429 : 503, text: "upstream failure" }])
    const entered = deferred<void>()
    const controller = new AbortController()
    let signal: AbortSignal | undefined
    if (phase === "verification")
      f.manager.refresh = async (_account, s) => {
        signal = s
        entered.resolve()
        return new Promise(() => {})
      }
    const delay = async (_ms: number, s: AbortSignal) => {
      signal = s
      entered.resolve()
      await new Promise<void>((_resolve, reject) =>
        s.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        }),
      )
    }
    const resultPromise = collect(
      f.rotate({ delay })(
        model,
        {},
        { fetch: f.fetchMock, signal: controller.signal, maxRetries: 1 },
      ),
    )
    await entered.promise
    controller.abort()
    const result = terminal(await resultPromise, "error")
    assert.equal(result.type === "error" && result.reason, "aborted")
    assert.equal(signal?.aborted, true)
    assert.equal(f.calls.length, 1)
  })
test("overall deadline interrupts a hung quota verification", { timeout: 1000 }, async () => {
  const f = fixture([{ status: 429 }])
  f.manager.refresh = async () => new Promise(() => {})
  const result = terminal(
    await collect(f.rotate({ totalTimeoutMs: 20 })(model, {}, { fetch: f.fetchMock })),
    "error",
  )
  assert.equal(result.type === "error" && result.reason, "error")
  assert.match(result.type === "error" ? result.error.errorMessage! : "", /total request timed out/)
  assert.equal(f.calls.length, 1)
})
test("ordinary maxRetries budget is global across account changes", async () => {
  const f = fixture([
    { status: 503, text: "server error" },
    { status: 429 },
    { status: 503, text: "final server error" },
  ])
  const waits: number[] = []
  const result = terminal(
    await collect(
      f.rotate({
        delay: async (ms: number) => {
          waits.push(ms)
        },
      })(model, {}, { fetch: f.fetchMock, maxRetries: 1 }),
    ),
    "error",
  )
  assert.equal(f.calls.length, 3)
  assert.equal(waits.length, 1)
  assert.deepEqual(
    f.calls.map((o) => o.apiKey),
    [f.accounts[0].apiKey, f.accounts[0].apiKey, f.accounts[1].apiKey],
  )
  assert.equal(result.type === "error" && result.error.errorMessage, "final server error")
})
for (const location of ["options", "model"])
  test(`reject custom mixed-case Authorization in ${location} before account access`, async () => {
    const f = fixture([])
    const headers = { aUtHoRiZaTiOn: "Bearer never-use" }
    const result = terminal(
      await collect(
        f.rotate()(
          location === "model" ? { ...model, headers } : model,
          {},
          location === "options" ? { headers } : {},
        ),
      ),
      "error",
    )
    assert.match(result.type === "error" ? result.error.errorMessage! : "", /Custom Authorization/)
    assert.equal(f.calls.length, 0)
    assert.equal(f.selections.length, 0)
  })
test("error diagnostics redact every account key, including selection failures", async () => {
  const f = fixture([{ status: 429 }])
  const secrets = f.accounts.map((a) => a.apiKey)
  f.manager.refresh = async () => {
    throw new Error(`verification failed ${secrets.join(" ")}`)
  }
  const events = await collect(f.rotate()(model, {}, { fetch: f.fetchMock }))
  terminal(events, "error")
  for (const key of secrets) assert.ok(!JSON.stringify(events).includes(key))
  const g = fixture([{ status: 400, text: secrets.join(" ") }])
  const errors = await collect(g.rotate()(model, {}, { fetch: g.fetchMock }))
  for (const key of secrets) assert.ok(!JSON.stringify(errors).includes(key))
  const h = fixture([{ status: 429, text: `quota exceeded ${secrets[0]}` }])
  const select = h.manager.getActiveAccount
  h.manager.getActiveAccount = async (excluded, signal) => {
    if (excluded?.size) throw new Error(`selection failed ${secrets[1]}`)
    return select(excluded, signal)
  }
  const selectionErrors = await collect(h.rotate()(model, {}, { fetch: h.fetchMock }))
  terminal(selectionErrors, "error")
  for (const key of secrets) assert.ok(!JSON.stringify(selectionErrors).includes(key))
})

function core() {
  return createStreamCommandCode({
    createStream: queue,
    calculateCost: () => {},
    env: {},
    authPaths: [],
    cwd: () => "/fixture",
    fetchImpl: async () => {
      throw new Error("dependency fetch must not override options.fetch")
    },
  })
}
const successfulResponse = () =>
  new Response(
    JSON.stringify({ type: "text-delta", text: "hello" }) +
      "\n" +
      JSON.stringify({ type: "finish", finishReason: "stop" }) +
      "\n",
  )
test(
  "real generate core honors options.fetch and pooled HTTP 429 rotates using intercepted status",
  { timeout: 1000 },
  async () => {
    const f = fakeManager()
    const requests: { url: string; authorization: string | null }[] = []
    const fetchMock: typeof fetch = async (url, init) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
      })
      return requests.length === 1
        ? new Response("opaque upstream diagnostic", { status: 429 })
        : successfulResponse()
    }
    const rotate = createRotatingCommandCodeStream({
      createStream: queue,
      stream: core(),
      manager: f.manager,
    })
    const events = await collect(
      rotate(model, { messages: [{ role: "user", content: "hi" }] }, { fetch: fetchMock }),
    )
    terminal(events, "done")
    assert.equal(requests.length, 2)
    assert.ok(requests.every((r) => r.url.endsWith("/alpha/generate")))
    assert.deepEqual(
      requests.map((r) => r.authorization),
      f.accounts.map((a) => `Bearer ${a.apiKey}`),
    )
    assert.deepEqual(f.refreshed, ["a"])
    assert.equal(events.filter((e) => e.type === "text_delta").length, 1)
  },
)

test("native transport participates in status interception and quota rotation", async () => {
  const f = fixture([{ status: 429, text: "opaque" }, { success: true }])
  let generateCalls = 0
  const router = createCommandCodeTransportRouter({
    createStream: queue,
    streamProvider: f.stream,
    streamGenerate: () => {
      generateCalls++
      return producer((s) => s.push(done()))
    },
  })
  const rotate = createRotatingCommandCodeStream({
    createStream: queue,
    stream: router.stream,
    manager: f.manager,
  })
  terminal(await collect(rotate(model, {}, { fetch: f.fetchMock })), "done")
  assert.equal(generateCalls, 0)
  assert.equal(f.calls.length, 2)
  assert.equal(router.getTransport(), "provider")
})
test("upgrade_required before visible content routes to generate, caches per key, and resets on key change", async () => {
  let nativeCalls = 0,
    generateCalls = 0
  const router = createCommandCodeTransportRouter({
    createStream: queue,
    streamProvider: (_m, _c, o) =>
      producer(async (s) => {
        nativeCalls++
        await o!.fetch!("https://fixture.invalid")
        s.push(failure("upgrade_required"))
      }),
    streamGenerate: () =>
      producer((s) => {
        generateCalls++
        s.push(done())
      }),
  })
  const fetchMock: typeof fetch = async () =>
    Response.json({ error: { code: "upgrade_required" } }, { status: 403 })
  for (const apiKey of ["fake-a", "fake-a", "fake-b"])
    terminal(await collect(router.stream(model, {}, { apiKey, fetch: fetchMock })), "done")
  assert.equal(nativeCalls, 2)
  assert.equal(generateCalls, 3)
  assert.equal(router.getTransport(), "generate")
})
for (const type of ["text_delta", "thinking_delta", "toolcall_delta"] as const)
  test(`upgrade_required after visible ${type} MUST NOT replay through generate`, async () => {
    let generateCalls = 0
    const router = createCommandCodeTransportRouter({
      createStream: queue,
      streamProvider: (_m, _c, o) =>
        producer(async (s) => {
          s.push(start())
          s.push({ type, contentIndex: 0, delta: "visible", partial: message() })
          await o!.fetch!("https://fixture.invalid")
          s.push(failure("upgrade_required"))
        }),
      streamGenerate: () =>
        producer((s) => {
          generateCalls++
          s.push(done())
        }),
    })
    const f = fakeManager()
    const rotate = createRotatingCommandCodeStream({
      createStream: queue,
      stream: router.stream,
      manager: f.manager,
    })
    const events = await collect(
      rotate(
        model,
        {},
        {
          fetch: async () =>
            Response.json({ error: { code: "upgrade_required" } }, { status: 403 }),
        },
      ),
    )
    assert.equal(generateCalls, 0, "fallback would replay an already visible native attempt")
    terminal(events, "error")
    assert.equal(events.filter((e) => e.type === type).length, 1)
  })
