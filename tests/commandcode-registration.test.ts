import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import commandCodeExtension from "../extensions/commandcode/index.ts"
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent"
import { resolveCommandCodeDisplayKey } from "../extensions/commandcode/src/active-account.ts"

// Uses the real extension entry and native SDK with a fake fetch, not a fake adapter.
test("registered provider rotates through native SDK and remains sticky without framework auth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cc-registration-"))
  const originalFetch = globalThis.fetch
  const names = [
    "PI_CODING_AGENT_DIR",
    "COMMAND_CODE_API_KEYS",
    "COMMAND_CODE_API_KEY",
    "COMMANDCODE_MODELS_CACHE",
    "COMMANDCODE_MODELS_URL",
    "COMMANDCODE_API_BASE",
  ] as const
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  process.env.PI_CODING_AGENT_DIR = directory
  process.env.COMMAND_CODE_API_KEYS = "fake-primary-key,fake-backup-key"
  process.env.COMMAND_CODE_API_KEY = "fake-single-fallback-key"
  process.env.COMMANDCODE_MODELS_CACHE = join(directory, "models.json")
  process.env.COMMANDCODE_MODELS_URL = "https://commandcode.invalid/provider/v1/models"
  process.env.COMMANDCODE_API_BASE = "https://commandcode.invalid/provider/v1"
  const calls: Array<{ path: string; key: string | null }> = []
  let config: ProviderConfig | undefined
  const commands: string[] = []
  const shutdown: Array<() => void> = []
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request?.url ?? String(input))
    assert.equal(url.hostname, "commandcode.invalid", "No real network in tests")
    const key = new Headers(init?.headers ?? request?.headers).get("authorization")
    calls.push({ path: url.pathname, key })
    if (url.pathname.endsWith("/models"))
      return Response.json({
        object: "list",
        data: [
          { id: "deepseek/deepseek-v4-flash", name: "DeepSeek Flash", context_length: 200000 },
          { id: "gpt-5.4-mini", name: "Unsupported model", context_length: 200000 },
        ],
      })
    if (url.pathname === "/alpha/whoami") return Response.json({ user: { userName: "fake" } })
    if (url.pathname === "/alpha/billing/credits") {
      assert.equal(key, "Bearer fake-primary-key")
      return Response.json({
        credits: { monthlyCredits: 0.05, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: {},
      })
    }
    assert.equal(url.pathname, "/provider/v1/chat/completions")
    if (key === "Bearer fake-primary-key")
      return Response.json(
        { error: { code: "rate_limit_exceeded", message: "Rate limit exceeded" } },
        { status: 429 },
      )
    assert.equal(key, "Bearer fake-backup-key")
    const events = [
      {
        id: "chat-test",
        object: "chat.completion.chunk",
        model: "deepseek/deepseek-v4-flash",
        choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
      },
      {
        id: "chat-test",
        object: "chat.completion.chunk",
        model: "deepseek/deepseek-v4-flash",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      },
    ]
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  }
  try {
    await commandCodeExtension({
      registerProvider(name: string, value: ProviderConfig) {
        assert.equal(name, "commandcode")
        config = value
      },
      registerCommand(name: string) {
        commands.push(name)
      },
      on(name: string, callback: () => void) {
        if (name === "session_shutdown") shutdown.push(callback)
      },
    } as unknown as ExtensionAPI)
    assert.ok(config)
    assert.equal(config.apiKey, "fake-primary-key")
    assert.ok(commands.includes("commandcode"))
    assert.ok(commands.includes("commandcode-quota"))
    const selected = config.models?.[0]
    assert.ok(selected)
    assert.deepEqual(
      config.models?.map((model) => model.id),
      ["deepseek/deepseek-v4-flash"],
      "register DeepSeek only",
    )
    const model = {
      ...selected,
      api: config.api,
      provider: "commandcode",
      baseUrl: selected.baseUrl ?? config.baseUrl,
    }
    for (let i = 0; i < 2; i++) {
      const events = []
      const stream = config.streamSimple!(
        model as never,
        { messages: [{ role: "user", content: "OK?", timestamp: 1 }] },
        { maxTokens: 16 },
      )
      for await (const event of stream) events.push(event)
      assert.equal(events.filter((event) => event.type === "done").length, 1)
      assert.equal(events.filter((event) => event.type === "error").length, 0)
      assert.equal((await stream.result()).stopReason, "stop")
    }
    assert.equal(calls.filter((call) => call.path === "/alpha/billing/credits").length, 1)
    assert.deepEqual(
      calls.filter((call) => call.path.endsWith("/chat/completions")).map((call) => call.key),
      ["Bearer fake-primary-key", "Bearer fake-backup-key", "Bearer fake-backup-key"],
    )
    assert.equal(await resolveCommandCodeDisplayKey(async () => "wrong"), "fake-backup-key")
  } finally {
    for (const callback of shutdown) callback()
    globalThis.fetch = originalFetch
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name]
      else process.env[name] = old[name]
    }
    await rm(directory, { recursive: true, force: true })
  }
})
