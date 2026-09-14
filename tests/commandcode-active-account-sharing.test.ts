// Regression test for the quota footer showing the wrong Command Code account.
//
// pi loads every extension entry file through its own jiti instance with
// `moduleCache: false`, so extensions/commandcode/index.ts and
// extensions/quota-footer/index.ts each get a separate copy of the shared
// src/active-account.ts module. A plain module-level variable only landed in
// the provider's copy, so the footer's copy stayed undefined and fell back to
// ctx.modelRegistry's key (the pool's FIRST account) while requests actually
// went to the active (rotated) account — the footer displayed an exhausted
// key while a healthy one was in use.
//
// This test reproduces that two-entry loading shape instead of importing the
// module once, which is what the other tests do.

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const extensionsRoot = join(here, "../extensions")

// Same resolution the repo's test runner uses: jiti comes from pi's own tree.
const piRequire = createRequire(
  "/home/wangyu/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/index.js",
)
const { createJiti } = piRequire("jiti")

function entryJiti(entryFile: string) {
  return createJiti(join(extensionsRoot, entryFile), { moduleCache: false })
}

test("quota footer and provider share the account manager across entry files", async () => {
  // Two entries, two jiti instances — exactly how pi loads them.
  const providerJiti = entryJiti("commandcode/index.ts")
  const footerJiti = entryJiti("quota-footer/index.ts")

  const providerModule = await providerJiti.import(
    join(extensionsRoot, "commandcode/src/active-account.ts"),
  )
  const footerModule = await footerJiti.import(
    join(extensionsRoot, "commandcode/src/active-account.ts"),
  )

  // Separate module instances are expected (and are the whole hazard).
  assert.notEqual(providerModule, footerModule)

  const manager = {
    accounts: [
      { id: "primary", apiKey: "exhausted-primary-key", fingerprint: "a".repeat(64) },
      { id: "backup", apiKey: "healthy-backup-key", fingerprint: "b".repeat(64) },
    ],
    async snapshot() {
      return { activeAccountId: "backup", accounts: {} }
    },
  }

  const unregister = providerModule.registerCommandCodeAccountManager(manager as never)
  try {
    const resolved = await footerModule.resolveCommandCodeDisplayKey(async () => {
      throw new Error("footer must not fall back to the registry key while a manager is registered")
    })
    assert.equal(resolved, "healthy-backup-key")
  } finally {
    unregister()
  }

  // After unregister the footer falls back again, so the slot is not leaked.
  assert.equal(
    await footerModule.resolveCommandCodeDisplayKey(async () => "fallback-key"),
    "fallback-key",
  )
})

test("footer never shows another account when active state cannot be read", async () => {
  const providerJiti = entryJiti("commandcode/index.ts")
  const footerJiti = entryJiti("quota-footer/index.ts")
  const providerModule = await providerJiti.import(
    join(extensionsRoot, "commandcode/src/active-account.ts"),
  )
  const footerModule = await footerJiti.import(
    join(extensionsRoot, "commandcode/src/active-account.ts"),
  )

  const manager = {
    accounts: [{ id: "primary", apiKey: "primary-key", fingerprint: "a".repeat(64) }],
    async snapshot(): Promise<never> {
      throw new Error("state unavailable")
    },
  }

  const unregister = providerModule.registerCommandCodeAccountManager(manager as never)
  try {
    assert.equal(
      await footerModule.resolveCommandCodeDisplayKey(async () => "fallback-key"),
      undefined,
    )
  } finally {
    unregister()
  }
})
