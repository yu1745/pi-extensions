import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { readAccountConfig, saveAccountConfig } from "../extensions/commandcode/src/account-config.ts"

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "cc-config-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const options = { agentDir: join(root, "agent"), homeDir: join(root, "home"), env: {} }
  const path = join(options.agentDir, "commandcode-accounts.json")
  const put = (value: unknown) => { mkdirSync(options.agentDir, { recursive: true }); writeFileSync(path, JSON.stringify(value)) }
  return { root, options, path, put }
}
const draft = { accounts: [{ id: "one", apiKey: "virtual-secret-one" }], remainingCreditsThreshold: 0.1 }

test("missing read is side-effect free; create and roundtrip with private permissions", async (t) => {
  const f = fixture(t), snap = readAccountConfig(f.options)
  assert.deepEqual(snap.draft, { accounts: [], remainingCreditsThreshold: 0.1 })
  assert.equal(existsSync(f.options.agentDir), false)
  await saveAccountConfig(snap, draft)
  assert.deepEqual(readAccountConfig(f.options).draft, draft)
  assert.equal(statSync(f.path).mode & 0o777, 0o600)
  assert.equal(statSync(f.options.agentDir).mode & 0o777, 0o700)
  assert.deepEqual(readdirSync(f.options.agentDir), ["commandcode-accounts.json"])
})
test("preserves unknown fields and policy, drops deleted accounts and stale active selectors", async (t) => {
  const f = fixture(t)
  f.put({ accounts: [...draft.accounts, { id: "two", apiKey: "virtual-two" }], extra: { a: 1 }, policy: { other: true }, activeIndex: 1, activeAccountId: "two" })
  const mode = statSync(f.options.agentDir).mode
  await saveAccountConfig(readAccountConfig(f.options), draft)
  const raw = JSON.parse(readFileSync(f.path, "utf8"))
  assert.deepEqual(raw.accounts, draft.accounts)
  assert.deepEqual(raw.extra, { a: 1 })
  assert.deepEqual(raw.policy, { other: true, remainingCreditsThreshold: 0.1 })
  assert.equal("activeIndex" in raw, false); assert.equal("activeAccountId" in raw, false)
  assert.equal(statSync(f.options.agentDir).mode, mode)
  f.put({ accounts: draft.accounts, activeAccountId: "one" })
  await saveAccountConfig(readAccountConfig(f.options), draft)
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).activeAccountId, "one")
})
test("legacy fallback, stable generated id, preferred priority and environment veto", (t) => {
  const f = fixture(t), legacy = join(f.options.homeDir, ".commandcode")
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, "accounts.json"), JSON.stringify({ accounts: [{ apiKey: "virtual-legacy" }] }))
  const snap = readAccountConfig(f.options)
  assert.equal(snap.path, join(legacy, "accounts.json"))
  assert.match(snap.draft.accounts[0].id, /^[a-f0-9]{64}$/)
  f.put({ accounts: draft.accounts })
  assert.equal(readAccountConfig(f.options).path, f.path)
  for (const value of ["", "virtual-env-secret"]) assert.throws(() => readAccountConfig({ ...f.options, env: { COMMAND_CODE_API_KEYS: value } }), /环境变量优先/)
})
test("byte revision conflicts, missing-to-existing conflict, concurrent writers", async (t) => {
  const f = fixture(t), absent = readAccountConfig(f.options)
  f.put({ accounts: draft.accounts })
  await assert.rejects(saveAccountConfig(absent, draft), /其他进程修改/)
  const snap = readAccountConfig(f.options)
  writeFileSync(f.path, readFileSync(f.path, "utf8") + " ")
  await assert.rejects(saveAccountConfig(snap, draft), /其他进程修改/)
  const current = readAccountConfig(f.options)
  const results = await Promise.allSettled([saveAccountConfig(current, draft), saveAccountConfig(current, { ...draft, remainingCreditsThreshold: 2 })])
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
  assert.deepEqual(readdirSync(f.options.agentDir), ["commandcode-accounts.json"])
})
test("independent processes cannot overwrite the same snapshot", async (t) => {
  const f = fixture(t), snap = readAccountConfig(f.options)
  const moduleUrl = new URL("../extensions/commandcode/src/account-config.ts", import.meta.url).href
  const run = (threshold: number) => new Promise<number | null>((resolve, reject) => {
    const code = `import { saveAccountConfig } from ${JSON.stringify(moduleUrl)}; try { await saveAccountConfig(${JSON.stringify(snap)}, ${JSON.stringify({ ...draft, remainingCreditsThreshold: threshold })}); } catch (e) { process.exitCode = e.message.includes('其他进程修改') ? 2 : 3 }`
    const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", code], { stdio: "ignore" })
    child.on("error", reject); child.on("exit", resolve)
  })
  assert.deepEqual((await Promise.all([run(1), run(2)])).sort(), [0, 2])
  assert.deepEqual(readdirSync(f.options.agentDir), ["commandcode-accounts.json"])
})
test("invalid drafts never write or leak keys", async (t) => {
  const f = fixture(t), snap = readAccountConfig(f.options)
  const invalid = [
    { ...draft, accounts: [] },
    ...[NaN, Infinity, -1, null, "1"].map((remainingCreditsThreshold) => ({ ...draft, remainingCreditsThreshold })),
    ...["", "../bad", "bad space"].map((id) => ({ ...draft, accounts: [{ id, apiKey: "virtual-secret" }] })),
    ...["", " ", "virtual-secret\n"].map((apiKey) => ({ ...draft, accounts: [{ id: "one", apiKey }] })),
    { ...draft, accounts: [draft.accounts[0], { id: "one", apiKey: "different" }] },
    { ...draft, accounts: [draft.accounts[0], { id: "two", apiKey: " virtual-secret-one " }] },
  ]
  for (const value of invalid) await assert.rejects(saveAccountConfig(snap, value as any), (e: Error) => !e.message.includes("virtual-secret"))
  assert.equal(existsSync(f.path), false)
})
test("malformed and invalid configurations fail closed without exposing content", (t) => {
  const f = fixture(t)
  for (const raw of [null, {}, { accounts: [{ apiKey: "virtual-secret", id: "../bad" }] }]) {
    f.put(raw)
    assert.throws(() => readAccountConfig(f.options), (e: Error) => !e.message.includes("virtual-secret"))
  }
  writeFileSync(f.path, '{"virtual-secret":')
  assert.throws(() => readAccountConfig(f.options), /配置无效/)
})
test("rejects regular and dangling symlinks and directories, including before save", async (t) => {
  const f = fixture(t), snap = readAccountConfig(f.options)
  mkdirSync(f.options.agentDir)
  const target = join(f.root, "target")
  writeFileSync(target, JSON.stringify({ accounts: draft.accounts }))
  for (const destination of [target, join(f.root, "missing")]) {
    symlinkSync(destination, f.path)
    assert.throws(() => readAccountConfig(f.options), /配置无效/)
    await assert.rejects(saveAccountConfig(snap, draft))
    rmSync(f.path)
  }
  mkdirSync(f.path)
  assert.throws(() => readAccountConfig(f.options), /配置无效/)
  assert.equal(JSON.parse(readFileSync(target, "utf8")).accounts[0].apiKey, "virtual-secret-one")
})
test("existing save lock has bounded wait and is not removed", async (t) => {
  const f = fixture(t), snap = readAccountConfig(f.options)
  mkdirSync(f.options.agentDir)
  mkdirSync(f.path + ".edit.lock")
  await assert.rejects(saveAccountConfig(snap, draft), /保存锁超时/)
  assert.equal(existsSync(f.path), false)
  assert.equal(existsSync(f.path + ".edit.lock"), true)
})
