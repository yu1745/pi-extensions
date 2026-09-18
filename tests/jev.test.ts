import assert from "node:assert/strict"
import test from "node:test"
import { createEventBus } from "@earendil-works/pi-coding-agent"
import typesafeJevExtension from "../extensions/typesafe-jev/index.ts"
import { createJevClient, JevError } from "../extensions/shared/jev/client.ts"
import {
  createAuthenticatedJevService,
  discoverJevService,
  publishJevService,
  registerJevService,
  resolveJevService,
} from "../extensions/shared/jev/service.ts"
import { JEV_PROVIDER_ID, JEV_SERVICE_VERSION, type JevServiceV1 } from "../extensions/shared/jev/types.ts"

const request = {
  state: { command: "until false; do :; done" },
  questions: {
    stuck: {
      type: "noul" as const,
      instructions: "Is this stuck?",
      criteria: { true: "Permanently blocked", false: "Can complete" },
    },
  },
}

test("provider exposes /login auth without pretending Jev is a chat model", async () => {
  let provider: any
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const events = createEventBus()
  typesafeJevExtension({
    registerProvider(value: unknown) { provider = value },
    events,
    on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler) },
  } as never)
  try {
    assert.equal(provider.id, JEV_PROVIDER_ID)
    assert.deepEqual(await provider.getModels(), [])
    const credential = await provider.auth.apiKey.login({
      async prompt() { return "  temporary-key  " },
    })
    assert.deepEqual(credential, { type: "api_key", key: "temporary-key" })
  } finally {
    await handlers.get("session_shutdown")?.()
  }
})

test("Jev client sends bearer auth and validates answers", async () => {
  let captured: RequestInit | undefined
  const client = createJevClient({
    apiKey: "secret-key",
    fetch: async (_url, init) => {
      captured = init
      return new Response(JSON.stringify({
        model: "jev-test",
        answers: { stuck: { type: "noul", noul: 0.97 } },
        usage: { input_tokens: 12, output_tokens: 3 },
      }), { status: 200, headers: { "content-type": "application/json" } })
    },
  })
  const response = await client.evaluate(request)
  assert.equal((captured?.headers as Record<string, string>).Authorization, "Bearer secret-key")
  assert.match(String(captured?.body), /"model":"jev-latest"/)
  assert.deepEqual(response.answers.stuck, { type: "noul", noul: 0.97 })
})

test("Jev client rejects malformed typed answers", async () => {
  const client = createJevClient({
    apiKey: "secret-key",
    maxAttempts: 1,
    fetch: async () => new Response(JSON.stringify({
      model: "jev-test",
      answers: { stuck: { type: "noul", noul: 2 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200 }),
  })
  await assert.rejects(client.evaluate(request), (error: unknown) =>
    error instanceof JevError && error.code === "invalid_response")
})

test("Jev service discovery works through the Pi event bus", () => {
  const events = createEventBus()
  const service: JevServiceV1 = {
    version: JEV_SERVICE_VERSION,
    async evaluate() { throw new Error("not used") },
  }
  const unsubscribe = publishJevService(events, service)
  try {
    assert.equal(discoverJevService(events), service)
  } finally {
    unsubscribe()
  }
  assert.equal(discoverJevService(events), undefined)
})

test("global service cleanup cannot erase a newer registration", () => {
  const first = { version: JEV_SERVICE_VERSION, async evaluate() { throw new Error("first") } } satisfies JevServiceV1
  const second = { version: JEV_SERVICE_VERSION, async evaluate() { throw new Error("second") } } satisfies JevServiceV1
  const removeFirst = registerJevService(first)
  const removeSecond = registerJevService(second)
  removeFirst()
  assert.equal(resolveJevService(), second)
  removeSecond()
  assert.equal(resolveJevService(), undefined)
})

test("authenticated service resolves the /login provider key lazily", async () => {
  let requestedProvider = ""
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer stored-key")
    return new Response(JSON.stringify({
      model: "jev-test",
      answers: { stuck: { type: "noul", noul: 0.8 } },
      usage: { input_tokens: 2, output_tokens: 1 },
    }), { status: 200 })
  }
  try {
    const service = createAuthenticatedJevService(() => ({
      async getProviderAuth(provider) {
        requestedProvider = provider
        return { auth: { apiKey: "stored-key" } }
      },
    }))
    const response = await service.evaluate(request)
    assert.equal(requestedProvider, JEV_PROVIDER_ID)
    assert.equal(response.answers.stuck.type, "noul")
  } finally {
    globalThis.fetch = oldFetch
  }
})
