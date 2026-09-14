import type { CommandCodeAccountManager } from "./account-manager.ts"

let manager: CommandCodeAccountManager | undefined

/** Read-only integration for the quota footer: never select or rotate an account. */
export function registerCommandCodeAccountManager(
  value: CommandCodeAccountManager | undefined,
): () => void {
  manager = value
  return () => {
    if (manager === value) manager = undefined
  }
}

export async function resolveCommandCodeDisplayKey(
  fallback: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const current = manager
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
