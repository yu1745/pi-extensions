// Does the Command Code rotation/footer stack still behave with 3-4 accounts?
//
// The pre-existing rotation tests use a simplified fake manager that fakes away
// `getActiveAccount`, so they cannot prove the real selection logic scales past
// two accounts. Here we drive the REAL CommandCodeAccountManager (real store,
// real selection, real state file) with 3 and 4 accounts.

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { CommandCodeAccountManager } from "../extensions/commandcode/src/account-manager.ts"
import type { ExhaustionVerification } from "../extensions/commandcode/src/exhaustion.ts"
import {
  registerCommandCodeAccountManager,
  resolveCommandCodeDisplayKey,
} from "../extensions/commandcode/src/active-account.ts"

function account(id: string) {
  const apiKey = `key-${id}-${"x".repeat(20)}`
  return { id, apiKey, fingerprint: createHash("sha256").update(apiKey).digest("hex") }
}

type Verdict = "available" | "exhausted" | "unknown"

/** Real manager backed by a temp state file; quota answers come from a script. */
async function fixture(ids: string[], verdicts: Record<string, Verdict>) {
  const dir = await mkdtemp(join(tmpdir(), "cc-n-accounts-"))
  const accounts = ids.map(account)
  const manager = new CommandCodeAccountManager(
    { accounts, remainingCreditsThreshold: 0.1, poolId: "testpool" },
    {
      statePath: join(dir, "state.json"),
      now: () => 1_000_000,
      verify: async (a: { id: string }): Promise<ExhaustionVerification> => {
        const verdict = verdicts[a.id] ?? "available"
        if (verdict === "available") return { status: "available", observedAt: 1_000_000 }
        if (verdict === "unknown")
          return { status: "unknown", reason: "verification unavailable" }
        return {
          status: "exhausted",
          observedAt: 1_000_000,
          recheckAt: 1_000_000 + 3_600_000,
          knownResetAt: 1_000_000 + 3_600_000,
          reasons: [`${a.id} weekly window exhausted`],
        }
      },
    },
  )
  // Register exactly as the provider extension does, so the footer resolves
  // through the shared manager instead of its fallback key.
  const unregister = registerCommandCodeAccountManager(manager)
  return {
    dir,
    manager,
    accounts,
    async cleanup() {
      unregister()
      manager.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

// ─── selection scales ────────────────────────────────────────────────────────

for (const count of [3, 4]) {
  const ids = Array.from({ length: count }, (_, i) => `acct${i + 1}`)

  test(`picks the first usable account among ${count} when all are healthy`, async () => {
    const f = await fixture(ids, {})
    try {
      const picked = await f.manager.getActiveAccount(new Set())
      assert.equal(picked.id, ids[0])

      // A request excluded the first account (it just failed) — the next healthy
      // one must be selected, not an error.
      const next = await f.manager.getActiveAccount(new Set([ids[0]]))
      assert.equal(next.id, ids[1])
    } finally {
      await f.cleanup()
    }
  })

  test(`skips exhausted accounts and lands on the ${count}th when it is the only healthy one`, async () => {
    const healthy = ids[ids.length - 1]
    const verdicts: Record<string, Verdict> = {}
    for (const id of ids.slice(0, -1)) verdicts[id] = "exhausted"
    const f = await fixture(ids, verdicts)
    try {
      // Mark all but the last as exhausted through the real verification path.
      for (const a of f.accounts.slice(0, -1)) await f.manager.refresh(a)

      // A single selection call must auto-skip every marked account and land on
      // the only healthy one, without the caller pre-excluding anything.
      const final = await f.manager.getActiveAccount()
      assert.equal(final.id, healthy)

      // And it stays sticky on a follow-up call.
      assert.equal((await f.manager.getActiveAccount()).id, healthy)
    } finally {
      await f.cleanup()
    }
  })
}

// ─── footer identity across N accounts ───────────────────────────────────────

for (const count of [3, 4]) {
  const ids = Array.from({ length: count }, (_, i) => `acct${i + 1}`)

  test(`footer follows the rotated active account among ${count}`, async () => {
    const f = await fixture(ids, {})
    try {
      // Rotate to the last account the way the stream does: exclude each one.
      const excluded = new Set<string>()
      let active = await f.manager.getActiveAccount(excluded)
      for (let i = 1; i < count; i++) {
        excluded.add(active.id)
        active = await f.manager.getActiveAccount(excluded)
      }
      assert.equal(active.id, ids[count - 1])

      // The footer must resolve to that same account's key.
      const resolved = await resolveCommandCodeDisplayKey(async () => {
        throw new Error("must not fall back while a manager is registered")
      })
      assert.equal(resolved, active.apiKey)
    } finally {
      await f.cleanup()
    }
  })
}

// ─── the footer must never show an account other than the active one ─────────

test("footer never shows account 1 when account 3 is active among 4", async () => {
  const ids = ["acct1", "acct2", "acct3", "acct4"]
  const f = await fixture(ids, {})
  try {
    const excluded = new Set<string>()
    let active = await f.manager.getActiveAccount(excluded)
    for (let i = 1; i < 3; i++) {
      excluded.add(active.id)
      active = await f.manager.getActiveAccount(excluded)
    }
    assert.equal(active.id, "acct3")

    const shown = await resolveCommandCodeDisplayKey(async () => f.accounts[0].apiKey)
    assert.equal(shown, f.accounts[2].apiKey)
    assert.notEqual(shown, f.accounts[0].apiKey)
  } finally {
    await f.cleanup()
  }
})

// ─── all-exhausted must still fail clearly, not silently mis-route ───────────

test("all-exhausted 4-account pool reports an error instead of reusing a spent key", async () => {
  const ids = ["acct1", "acct2", "acct3", "acct4"]
  const verdicts: Record<string, Verdict> = {}
  for (const id of ids) verdicts[id] = "exhausted"
  const f = await fixture(ids, verdicts)
  try {
    // Mark every account exhausted through the real verification path.
    for (const a of f.accounts) await f.manager.refresh(a)
    await assert.rejects(
      () => f.manager.getActiveAccount(new Set()),
      /Command Code accounts unavailable/,
    )
  } finally {
    await f.cleanup()
  }
})
