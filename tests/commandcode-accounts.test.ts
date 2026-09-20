import { test } from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CommandCodeAccountManager,
  loadAccountPool,
} from "../extensions/commandcode/src/account-manager.ts"
import type { ExhaustionVerification } from "../extensions/commandcode/src/exhaustion.ts"

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "cc-accounts-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const agentDir = join(root, "agent"),
    homeDir = join(root, "home")
  mkdirSync(agentDir)
  mkdirSync(join(homeDir, ".commandcode"), { recursive: true })
  const config = loadAccountPool({
    env: { COMMAND_CODE_API_KEYS: "secret-one,secret-two" },
    agentDir,
    homeDir,
  })!
  return { root, agentDir, homeDir, config, statePath: join(root, "state.json") }
}
const exhausted = (
  recheckAt = 1000,
  observedAt = 1,
): Extract<ExhaustionVerification, { status: "exhausted" }> => ({
  status: "exhausted",
  reasons: ["low balance"],
  observedAt,
  recheckAt,
})

test("account source precedence, dedupe, validation and legacy index", (t) => {
  const f = fixture(t),
    opts = { env: {}, agentDir: f.agentDir, homeDir: f.homeDir }
  assert.equal(loadAccountPool(opts), undefined)
  writeFileSync(
    join(f.homeDir, ".commandcode", "accounts.json"),
    JSON.stringify({ accounts: [{ apiKey: "home" }] }),
  )
  assert.equal(loadAccountPool(opts)!.accounts[0].apiKey, "home")
  const path = join(f.agentDir, "commandcode-accounts.json")
  writeFileSync(
    path,
    JSON.stringify({
      accounts: [
        { id: "one", apiKey: "a" },
        { id: "two", apiKey: "b" },
      ],
      activeIndex: 1,
      policy: { remainingCreditsThreshold: 0 },
    }),
  )
  assert.equal(loadAccountPool(opts)!.activeAccountId, "two")
  assert.equal(loadAccountPool(opts)!.remainingCreditsThreshold, 0)
  assert.equal(
    loadAccountPool({ ...opts, env: { COMMAND_CODE_API_KEYS: " x,x\ny " } })!.accounts.length,
    2,
  )
  assert.throws(
    () => loadAccountPool({ ...opts, env: { COMMAND_CODE_API_KEYS: "" } }),
    /configuration/,
  )
  for (const raw of [
    "secret invalid JSON",
    '{"accounts":[]}',
    JSON.stringify({ accounts: [{ id: "../bad", apiKey: "secret" }] }),
    JSON.stringify({ accounts: [{ apiKey: "a" }], policy: { remainingCreditsThreshold: -1 } }),
  ]) {
    writeFileSync(path, raw)
    assert.throws(
      () => loadAccountPool(opts),
      (e) => e instanceof Error && !e.message.includes("secret") && /configuration/.test(e.message),
    )
  }
})

test("sticky selection, persistence, exclusions and all unavailable are bounded", async (t) => {
  const f = fixture(t)
  let calls = 0
  const options = {
    statePath: f.statePath,
    now: () => 10,
    verify: async () => {
      calls++
      return exhausted()
    },
  }
  const m = new CommandCodeAccountManager(f.config, options),
    [a, b] = m.accounts
  assert.equal((await m.getActiveAccount()).id, a.id)
  assert.equal((await m.getActiveAccount()).id, a.id)
  assert.equal(calls, 0)
  await m.markExhausted(a, exhausted())
  const other = new CommandCodeAccountManager(f.config, options)
  assert.equal((await other.getActiveAccount()).id, b.id)
  assert.equal((await m.getActiveAccount()).id, b.id)
  await m.markExhausted(b, exhausted())
  await assert.rejects(m.getActiveAccount(), /earliest recheck 1000/)
  const text = readFileSync(f.statePath, "utf8")
  assert.ok(!text.includes("secret-"))
  assert.equal(statSync(f.statePath).mode & 0o777, 0o600)
})

test("due checks, unknown backoff and display refresh do not move active", async (t) => {
  const f = fixture(t)
  let now = 100
  let result: ExhaustionVerification = { status: "unknown", reason: "secret-one" }
  let calls = 0
  const m = new CommandCodeAccountManager(f.config, {
    statePath: f.statePath,
    now: () => now,
    verify: async () => {
      calls++
      return result
    },
  })
  const [a, b] = m.accounts
  await m.getActiveAccount()
  await m.markExhausted(a, exhausted(50))
  assert.equal((await m.getActiveAccount()).id, b.id)
  assert.equal(calls, 1)
  assert.equal((await m.snapshot()).accounts[a.id].verification!.recheckAt, 30100)
  result = { status: "available", observedAt: 200 }
  now = 200
  await m.refresh(a)
  assert.equal((await m.snapshot()).activeAccountId, b.id)
  assert.equal((await m.getActiveAccount()).id, b.id)
})

test("singleflight has independent cancellation and stale available cannot clear a newer failure", async (t) => {
  const f = fixture(t)
  let resolve!: (v: ExhaustionVerification) => void
  let started!: () => void
  const start = new Promise<void>((r) => (started = r))
  let calls = 0
  let underlying: AbortSignal | undefined
  const m = new CommandCodeAccountManager(f.config, {
    statePath: f.statePath,
    verify: async (_a, signal) => {
      calls++
      underlying = signal
      started()
      return new Promise((r) => (resolve = r))
    },
  })
  const a = m.accounts[0]
  await m.markExhausted(a, exhausted())
  const controller = new AbortController()
  const first = m.refresh(a, controller.signal)
  const second = m.refresh(a)
  await start
  controller.abort()
  await assert.rejects(first, { name: "AbortError" })
  assert.equal(underlying!.aborted, false)
  await m.markExhausted(a, exhausted(2000, 20))
  resolve({ status: "available", observedAt: 10 })
  await second
  assert.equal(calls, 1)
  assert.equal((await m.snapshot()).accounts[a.id].verification!.observedAt, 20)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(m.refresh(a, cancelled.signal))
  await assert.rejects(m.getActiveAccount(undefined, cancelled.signal))
  assert.equal(calls, 1)
})

test("key change resets marks; corrupt state and live locks fail closed", async (t) => {
  const f = fixture(t)
  f.config.accounts[0].id = "primary"
  const m = new CommandCodeAccountManager(f.config, {
    statePath: f.statePath,
    verify: async () => exhausted(),
  })
  await m.markExhausted(m.accounts[0], exhausted())
  const changed = loadAccountPool({ env: { COMMAND_CODE_API_KEYS: "replacement" } })!
  changed.accounts[0].id = "primary"
  const replacement = new CommandCodeAccountManager(changed, {
    statePath: f.statePath,
    verify: async () => exhausted(),
  })
  assert.equal((await replacement.snapshot()).accounts.primary.verification, undefined)
  writeFileSync(f.statePath, "secret-one INVALID")
  await assert.rejects(
    m.snapshot(),
    (e) =>
      e instanceof Error && /state unavailable/.test(e.message) && !e.message.includes("secret"),
  )
  rmSync(f.statePath)
  writeFileSync(f.statePath + ".lock", JSON.stringify({ pid: process.pid, token: "live" }))
  await assert.rejects(m.snapshot(), /lock timeout/)
  assert.equal(JSON.parse(readFileSync(f.statePath + ".lock", "utf8")).token, "live")
})

test("immediate cancellation starts no network verification and writes fail explicitly", async (t) => {
  const f = fixture(t)
  let calls = 0
  const m = new CommandCodeAccountManager(f.config, {
    statePath: f.statePath,
    verify: async () => {
      calls++
      return exhausted()
    },
  })
  const controller = new AbortController()
  const pending = m.refresh(m.accounts[0], controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: "AbortError" })
  await Promise.resolve()
  assert.equal(calls, 0)
  mkdirSync(f.statePath)
  await assert.rejects(m.snapshot(), /state unavailable/)
})

test("independent processes atomically retain both account failures", async (t) => {
  const f = fixture(t)
  const moduleUrl = new URL("../extensions/commandcode/src/account-manager.ts", import.meta.url)
    .href
  const run = promisify(execFile)
  const script = `import { CommandCodeAccountManager, loadAccountPool } from ${JSON.stringify(moduleUrl)};
 const config = loadAccountPool({env:{COMMAND_CODE_API_KEYS:'secret-one,secret-two'}});
 const manager = new CommandCodeAccountManager(config, {statePath:process.argv[1],verify:async()=>({status:'unknown',reason:'test'})});
 await manager.markExhausted(manager.accounts[Number(process.argv[2])], {status:'exhausted',reasons:['test'],observedAt:1,recheckAt:1000});`
  await Promise.all(
    [0, 1].map((i) =>
      run(process.execPath, [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        script,
        f.statePath,
        String(i),
      ]),
    ),
  )
  const m = new CommandCodeAccountManager(f.config, {
    statePath: f.statePath,
    verify: async () => exhausted(),
  })
  const snapshot = await m.snapshot()
  for (const a of m.accounts) assert.ok(snapshot.accounts[a.id].verification)
})

test("dead PID locks recover and concurrent managers preserve both marks", async (t) => {
  const f = fixture(t)
  writeFileSync(f.statePath + ".lock", JSON.stringify({ pid: 2147483647, token: "dead" }))
  const options = { statePath: f.statePath, verify: async () => exhausted() }
  const a = new CommandCodeAccountManager(f.config, options),
    b = new CommandCodeAccountManager(f.config, options)
  await Promise.all([
    a.markExhausted(a.accounts[0], exhausted()),
    b.markExhausted(b.accounts[1], exhausted()),
  ])
  const state = await a.snapshot()
  assert.ok(state.accounts[a.accounts[0].id].verification)
  assert.ok(state.accounts[a.accounts[1].id].verification)
})

test("getActiveAccount prioritizes accounts whose quota expires earlier", async (t) => {
  const f = fixture(t)
  let now = 1000
  const m = new CommandCodeAccountManager(f.config, {
    statePath: f.statePath,
    now: () => now,
    verify: async () => ({ status: "available", observedAt: now }),
  })
  const [a, b] = m.accounts

  // Case 1: Neither account has expiresAt, first account selected by default
  assert.equal((await m.getActiveAccount()).id, a.id)

  // Case 2: b expires at 2000, a expires at 5000 -> b is chosen because 2000 < 5000
  await m.markAvailable(a, { expiresAt: 5000 })
  await m.markAvailable(b, { expiresAt: 2000 })
  assert.equal((await m.getActiveAccount()).id, b.id)

  // Case 3: a expires at 1500, b expires at 2000 -> a is chosen because 1500 < 2000
  await m.markAvailable(a, { expiresAt: 1500 })
  assert.equal((await m.getActiveAccount()).id, a.id)

  // Case 4: a has no expiration (Infinity), b expires at 3000 -> b is chosen
  await m.markAvailable(a) // no expiresAt -> Infinity
  await m.markAvailable(b, { expiresAt: 3000 })
  assert.equal((await m.getActiveAccount()).id, b.id)

  // Case 5: a was exhausted but its recheckAt has arrived; when rechecked and refreshed,
  // if it expires earlier than b, it is selected!
  now = 10000
  await m.markExhausted(a, {
    status: "exhausted",
    reasons: ["rate limit"],
    observedAt: 5000,
    recheckAt: 8000, // already passed since now = 10000
  })
  await m.markAvailable(b, { expiresAt: 20000 })
  // verify function sets a's expiresAt to 12000 (earlier than b's 20000)
  m["verify"] = async () => ({ status: "available", observedAt: now, expiresAt: 12000 })
  assert.equal((await m.getActiveAccount()).id, a.id)
  // a's verification was cleared
  assert.equal((await m.snapshot()).accounts[a.id].verification, undefined)
})

test("markAvailable clears verification and sets expiresAt in store", async (t) => {
  const f = fixture(t)
  const m = new CommandCodeAccountManager(f.config, {
    statePath: f.statePath,
    verify: async () => exhausted(),
  })
  const a = m.accounts[0]
  await m.markExhausted(a, exhausted(5000))
  assert.ok((await m.snapshot()).accounts[a.id].verification)

  await m.markAvailable(a, { expiresAt: 12345 })
  const snap = await m.snapshot()
  assert.equal(snap.accounts[a.id].verification, undefined)
  assert.equal(snap.accounts[a.id].expiresAt, 12345)
})

