import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

// Actual Pi CLI: an empty HOME/auth store, only pool credentials. This verifies
// the host auth gate as well as native transport, not just a direct factory call.
test(
  "isolated Pi CLI loads pool-only auth and completes a verified rotation",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-cli-"))
    const inferenceKeys: string[] = []
    let quotaReads = 0
    const server = createServer(async (req, res) => {
      for await (const _ of req) {
        /* consume request body without logging it */
      }
      res.setHeader("content-type", "application/json")
      const send = (body: unknown, status = 200) => {
        res.statusCode = status
        res.end(JSON.stringify(body))
      }
      if (req.url === "/provider/v1/models")
        return send({
          object: "list",
          data: [
            { id: "deepseek/deepseek-v4-flash", name: "Test DeepSeek", context_length: 200000 },
          ],
        })
      if (req.url === "/alpha/whoami") return send({ user: { userName: "test" } })
      if (req.url === "/alpha/billing/credits") {
        quotaReads++
        return send({
          credits: { monthlyCredits: 0.05, purchasedCredits: 0, freeCredits: 0 },
          windowLimits: {},
        })
      }
      if (req.url !== "/provider/v1/chat/completions")
        return send({ error: "Unexpected route" }, 404)
      const authorization = req.headers.authorization
      // Keep assertion output safe even if a broken implementation resolves another key.
      inferenceKeys.push(
        authorization === "Bearer fake-first"
          ? "first"
          : authorization === "Bearer fake-second"
            ? "second"
            : "unexpected",
      )
      if (authorization === "Bearer fake-first")
        return send({ error: { message: "Rate limit exceeded", code: "rate_limit_exceeded" } }, 429)
      if (authorization !== "Bearer fake-second")
        return send({ error: "Unexpected credential" }, 401)
      res.setHeader("content-type", "text/event-stream")
      for (const [delta, finish_reason] of [
        [{ role: "assistant", content: "OK" }, null],
        [{}, "stop"],
      ]) {
        res.write(
          `data: ${JSON.stringify({ id: "test-cli", object: "chat.completion.chunk", model: "deepseek/deepseek-v4-flash", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        )
      }
      res.end("data: [DONE]\n\n")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port
    const base = `http://127.0.0.1:${port}`
    try {
      const packagePath = fileURLToPath(
        new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url),
      )
      const manifest = JSON.parse(await readFile(packagePath, "utf8"))
      const cli = join(dirname(packagePath), manifest.bin.pi)
      const extension = fileURLToPath(
        new URL("../extensions/commandcode/index.ts", import.meta.url),
      )
      const env = {
        ...process.env,
        HOME: directory,
        PI_CODING_AGENT_DIR: directory,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        COMMAND_CODE_API_KEYS: "fake-first,fake-second",
        COMMANDCODE_API_BASE: `${base}/provider/v1`,
        COMMANDCODE_MODELS_URL: `${base}/provider/v1/models`,
        COMMANDCODE_MODELS_CACHE: join(directory, "models.json"),
      }
      delete env.COMMAND_CODE_API_KEY
      delete env.COMMANDCODE_API_KEY
      const pending = promisify(execFile)(
        process.execPath,
        [
          cli,
          "--offline",
          "--no-extensions",
          "-e",
          extension,
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--no-tools",
          "--no-session",
          "--provider",
          "commandcode",
          "--model",
          "deepseek/deepseek-v4-flash",
          "--thinking",
          "off",
          "--system-prompt",
          "Reply briefly.",
          "-p",
          "Reply OK.",
        ],
        { cwd: directory, env, timeout: 25000, maxBuffer: 1024 * 1024 },
      )
      pending.child.stdin?.end()
      const result = await pending
      assert.match(result.stdout, /OK/)
      assert.doesNotMatch(
        result.stderr,
        /Failed to load extension|Provider is not configured|No API key/,
      )
      assert.deepEqual(inferenceKeys, ["first", "second"])
      assert.equal(quotaReads, 1)
      const state = await readFile(join(directory, "commandcode-account-state.json"), "utf8")
      assert.ok(!state.includes("fake-first") && !state.includes("fake-second"))
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  },
)
