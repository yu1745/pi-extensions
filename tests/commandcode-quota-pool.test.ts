import assert from "node:assert/strict"
import { test } from "node:test"
import {
  registerCommandCodeQuota,
  type QuotaCommandContext,
} from "../extensions/commandcode/src/quota-command.ts"
import {
  registerCommandCodeAccountManager,
  resolveCommandCodeDisplayKey,
} from "../extensions/commandcode/src/active-account.ts"
import type { CommandCodeAccountManager } from "../extensions/commandcode/src/account-manager.ts"

function fixture() {
  const accounts = [
    { id: "primary", apiKey: "secret-primary-key", fingerprint: "1" },
    { id: "backup", apiKey: "secret-backup-key", fingerprint: "2" },
  ]
  let activeAccountId = "backup"
  const refreshed: string[] = []
  const manager = {
    accounts,
    remainingCreditsThreshold: 0.1,
    async snapshot() {
      return { activeAccountId, accounts: {} }
    },
    async refresh(account: (typeof accounts)[number]) {
      refreshed.push(account.id)
      return { status: "available", observedAt: 1 }
    },
    async getActiveAccount() {
      throw new Error("Display must not select an account")
    },
  } as unknown as CommandCodeAccountManager
  const commands = new Map<string, (args: string, ctx: QuotaCommandContext) => Promise<void>>()
  const notifications: string[] = []
  const calls: string[] = []
  registerCommandCodeQuota(
    {
      registerCommand(name, options) {
        commands.set(name, options.handler)
      },
    },
    {
      apiBase: "https://invalid.test",
      accountManager: manager,
      fetchQuota: async (options) => {
        calls.push(options.apiKey)
        return { ok: false, error: { kind: "http", message: `unknown: ${options.apiKey}` } }
      },
    },
  )
  const ctx: QuotaCommandContext = {
    ui: {
      notify(message) {
        notifications.push(message)
      },
    },
  }
  return {
    accounts,
    manager,
    commands,
    ctx,
    calls,
    notifications,
    refreshed,
    setActive(id: string) {
      activeAccountId = id
    },
  }
}

test("quota aliases show every account without rotating and redact exact keys", async () => {
  const f = fixture()
  await f.commands.get("commandcode")!("quota", f.ctx)
  assert.equal(f.calls.length, 2)
  assert.equal(f.refreshed.length, 0)
  assert.match(f.notifications[0], /threshold: 0\.1/)
  assert.match(f.notifications[0], /backup \(active\)/)
  for (const account of f.accounts) assert.ok(!f.notifications[0].includes(account.apiKey))
  assert.match(f.notifications[0], /unknown/)
})

test("explicit refresh reverifies each account and doesn't choose an active one", async () => {
  const f = fixture()
  await f.commands.get("commandcode-quota")!("refresh", f.ctx)
  assert.deepEqual(f.refreshed, ["primary", "backup"])
  assert.match(f.notifications[0], /backup \(active\)/)
})

test("refresh unknown is displayed separately from a successful quota display", async () => {
  const f = fixture()
  f.manager.refresh = async () => ({ status: "unknown", reason: "Network timeout" })
  await f.commands.get("commandcode-quota")!("refresh", f.ctx)
  assert.match(f.notifications[0], /Refresh unknown: Network timeout/)
})

test("footer uses read-only active identity, tracks switches and restores fallback", async () => {
  const f = fixture()
  const unregister = registerCommandCodeAccountManager(f.manager)
  const fallback = async () => "single-account-key"
  try {
    assert.equal(await resolveCommandCodeDisplayKey(fallback), f.accounts[1].apiKey)
    f.setActive("primary")
    assert.equal(await resolveCommandCodeDisplayKey(fallback), f.accounts[0].apiKey)
    assert.equal(f.refreshed.length, 0)
  } finally {
    unregister()
  }
  assert.equal(await resolveCommandCodeDisplayKey(fallback), "single-account-key")
})

test("footer state errors never silently show a different account", async () => {
  const f = fixture()
  f.manager.snapshot = async () => {
    throw new Error("Cannot read")
  }
  const unregister = registerCommandCodeAccountManager(f.manager)
  try {
    assert.equal(await resolveCommandCodeDisplayKey(async () => "wrong-key"), undefined)
  } finally {
    unregister()
  }
})
