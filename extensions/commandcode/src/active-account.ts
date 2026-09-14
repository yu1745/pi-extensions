import type { CommandCodeAccountManager } from "./account-manager.ts"

// pi loads every extension entry file through its own jiti instance with
// `moduleCache: false` (dist/core/extensions/loader.js). The Command Code
// provider (extensions/commandcode/index.ts) and the quota footer
// (extensions/quota-footer/index.ts) are separate entries, so they get
// separate copies of this module: a plain module-level variable would only be
// written in the provider's copy, leaving the footer's copy permanently
// undefined and stuck on the fallback API key (the pool's first account, not
// the active one). Share the reference on globalThis so both copies agree.
const GLOBAL_KEY = "__piCommandCodeAccountManager"

interface ManagerSlot {
  manager: CommandCodeAccountManager | undefined
}

function slot(): ManagerSlot {
  const g = globalThis as Record<string, unknown>
  return (g[GLOBAL_KEY] as ManagerSlot) ?? (g[GLOBAL_KEY] = { manager: undefined })
}

/** Read-only integration for the quota footer: never select or rotate an account. */
export function registerCommandCodeAccountManager(
  value: CommandCodeAccountManager | undefined,
): () => void {
  const shared = slot()
  shared.manager = value
  return () => {
    if (shared.manager === value) shared.manager = undefined
  }
}

export async function resolveCommandCodeDisplayKey(
  fallback: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const current = slot().manager
  if (!current) return fallback()
  try {
    const state = await current.snapshot()
    return (
      current.accounts.find((account) => account.id === state.activeAccountId)?.apiKey ??
      current.accounts[0]?.apiKey
    )
  } catch {
    // Never silently display another account's quota if active state cannot be read.
    return undefined
  }
}
