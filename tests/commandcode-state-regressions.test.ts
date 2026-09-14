import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  CommandCodeAccountManager,
  loadAccountPool,
} from "../extensions/commandcode/src/account-manager.ts"
import type { ExhaustionVerification } from "../extensions/commandcode/src/exhaustion.ts"
const exhausted = {
  status: "exhausted",
  observedAt: 1,
  recheckAt: 1000,
  reasons: ["exhausted"],
} as const
const failure = () => ({ ...exhausted, reasons: [...exhausted.reasons] })
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "cc-state-regression-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const statePath = join(directory, "state.json")
  const make = (keys: string) =>
    new CommandCodeAccountManager(loadAccountPool({ env: { COMMAND_CODE_API_KEYS: keys } })!, {
      statePath,
      now: () => 10,
      verify: async () => ({ status: "unknown", reason: "test" }),
    })
  return { directory, statePath, make }
}
test("independent environment pools cannot prune each other's cooldowns", async (t) => {
  const f = fixture(t),
    a = f.make("first,second"),
    b = f.make("third,fourth")
  await a.markExhausted(a.accounts[0], failure())
  await b.markExhausted(b.accounts[1], failure())
  assert.ok((await a.snapshot()).accounts[a.accounts[0].id].verification)
  assert.ok((await b.snapshot()).accounts[b.accounts[1].id].verification)
  assert.equal(Object.keys(JSON.parse(readFileSync(f.statePath, "utf8")).pools).length, 2)
})
test("read-only snapshots don't rewrite state or advance revisions", async (t) => {
  const f = fixture(t),
    manager = f.make("first,second")
  await manager.getActiveAccount()
  const before = readFileSync(f.statePath, "utf8")
  await manager.snapshot()
  await manager.snapshot()
  assert.equal(readFileSync(f.statePath, "utf8"), before)
})
test("file pool keeps active ID after reorder/add and moves forward only on exhaustion", async (t) => {
  const f = fixture(t)
  const path = join(f.directory, "commandcode-accounts.json")
  const write = (ids: string[], activeIndex?: number) =>
    writeFileSync(
      path,
      JSON.stringify({ activeIndex, accounts: ids.map((id) => ({ id, apiKey: `test-${id}` })) }),
    )
  const manager = () =>
    new CommandCodeAccountManager(
      loadAccountPool({ env: {}, agentDir: f.directory, homeDir: f.directory })!,
      { statePath: f.statePath, now: () => 10, verify: async () => failure() },
    )
  write(["a", "b", "c"], 1)
  const first = manager()
  assert.equal((await first.getActiveAccount()).id, "b")
  await first.markExhausted(first.accounts[1], failure())
  assert.equal((await first.getActiveAccount()).id, "c")
  write(["d", "c", "b", "a"])
  const next = manager()
  assert.equal((await next.getActiveAccount()).id, "c")
  assert.ok((await next.snapshot()).accounts.b.verification)
})
test("all attempted exhausted accounts still appear in aggregate reset diagnostics", async (t) => {
  const f = fixture(t),
    manager = f.make("first,second")
  for (const account of manager.accounts) await manager.markExhausted(account, failure())
  await assert.rejects(
    manager.getActiveAccount(new Set(manager.accounts.map((a) => a.id))),
    /confirmed exhausted 2.*earliest recheck 1000/,
  )
})
test("last cancelled waiter aborts the underlying quota fetch", async (t) => {
  const f = fixture(t)
  let entered!: () => void
  const start = new Promise<void>((resolve) => {
    entered = resolve
  })
  let underlying!: AbortSignal
  const config = loadAccountPool({ env: { COMMAND_CODE_API_KEYS: "first" } })!
  const manager = new CommandCodeAccountManager(config, {
    statePath: f.statePath,
    verify: async (_account, signal) => {
      underlying = signal!
      entered()
      return new Promise<ExhaustionVerification>((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        }),
      )
    },
  })
  const controller = new AbortController()
  const task = manager.refresh(manager.accounts[0], controller.signal)
  await start
  controller.abort()
  await assert.rejects(task, { name: "AbortError" })
  assert.equal(underlying.aborted, true)
})
test("a stale exhaustion observation cannot authorize rotation after a concurrent recovery", async (t) => {
  const f = fixture(t),
    config = loadAccountPool({ env: { COMMAND_CODE_API_KEYS: "first" } })!
  let finish!: (result: ExhaustionVerification) => void, entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const old = new CommandCodeAccountManager(config, {
    statePath: f.statePath,
    verify: async () => {
      entered()
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  })
  const fresh = new CommandCodeAccountManager(config, {
    statePath: f.statePath,
    verify: async () => ({ status: "available", observedAt: 20 }),
  })
  const task = old.refresh(old.accounts[0])
  await started
  await fresh.refresh(fresh.accounts[0])
  finish(failure())
  assert.equal((await task).status, "unknown")
  assert.equal((await old.snapshot()).accounts[old.accounts[0].id].verification, undefined)
})
