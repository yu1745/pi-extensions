import type { CommandCodeAccountManager } from "./account-manager.ts"
import { getConfiguredApiKey } from "./api-key.ts"
import { pickCommandCodeApiKey } from "./converters.ts"
import { fetchCommandCodeQuota, redactValue } from "./quota.ts"
import { formatQuota } from "./quota-format.ts"

export interface QuotaCommandContext {
  waitForIdle?: () => Promise<void>
  modelRegistry?: {
    getApiKeyForProvider?: (provider: string) => Promise<string | undefined>
  }
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void
  }
}

interface QuotaCommandApi {
  registerCommand(
    name: string,
    options: {
      description: string
      handler: (args: string, ctx: QuotaCommandContext) => Promise<void>
    },
  ): void
}

interface RegisterQuotaCommandOptions {
  apiBase: string
  headers?: Record<string, string>
  getConfiguredKey?: () => string | undefined
  fetchQuota?: typeof fetchCommandCodeQuota
  accountManager?: CommandCodeAccountManager
  openAccounts?: (ctx: QuotaCommandContext) => Promise<void>
}

export function registerCommandCodeQuota(
  pi: QuotaCommandApi,
  options: RegisterQuotaCommandOptions,
): void {
  const getConfiguredKey = options.getConfiguredKey ?? getConfiguredApiKey
  const fetchQuota = options.fetchQuota ?? fetchCommandCodeQuota

  const handler = async (args: string, ctx: QuotaCommandContext) => {
    await ctx.waitForIdle?.()
    if (options.accountManager) {
      const manager = options.accountManager
      try {
        // Sequential by design: bounded concurrency and no active-account changes.
        const refreshStatus = new Map<string, string>()
        if (args.trim() === "refresh") {
          for (const account of manager.accounts) {
            const result = await manager.refresh(account)
            refreshStatus.set(
              account.id,
              result.status === "unknown"
                ? `Refresh unknown: ${result.reason}`
                : `Refresh: ${result.status}`,
            )
          }
        } else if (args.trim()) {
          ctx.ui.notify(
            "Usage: /commandcode quota [refresh] or /commandcode-quota [refresh]",
            "warning",
          )
          return
        }
        const state = await manager.snapshot()
        const sections = [
          `Command Code account pool — low-balance threshold: ${manager.remainingCreditsThreshold}`,
        ]
        for (const account of manager.accounts) {
          const result = await fetchQuota({
            apiKey: account.apiKey,
            baseUrl: options.apiBase,
            extraHeaders: options.headers,
          })
          const verification = state.accounts[account.id]?.verification
          sections.push(
            [
              `${account.id}${state.activeAccountId === account.id ? " (active)" : ""}`,
              ...(refreshStatus.has(account.id) ? [refreshStatus.get(account.id)!] : []),
              verification
                ? `Unavailable: ${verification.reasons.join("; ")}; recheck after ${new Date(verification.recheckAt).toISOString()} (not guaranteed recovery)`
                : "No confirmed exhaustion",
              result.ok
                ? formatQuota(result.quota)
                : `Quota unknown: ${redactValue(result.error.message)}`,
            ].join("\n"),
          )
        }
        let text = sections.join("\n\n")
        for (const account of manager.accounts) text = text.split(account.apiKey).join("[redacted]")
        ctx.ui.notify(redactValue(text), "info")
      } catch {
        ctx.ui.notify(
          "Command Code account quota/state operation failed; check configuration and state file permissions.",
          "error",
        )
      }
      return
    }
    const registryKey = await ctx.modelRegistry?.getApiKeyForProvider?.("commandcode")
    const apiKey = pickCommandCodeApiKey(registryKey, getConfiguredKey())
    if (!apiKey) {
      ctx.ui.notify(
        "Command Code quota requires an API key. Run /login and select Command Code, or set COMMAND_CODE_API_KEY.",
        "warning",
      )
      return
    }

    const result = await fetchQuota({
      apiKey,
      baseUrl: options.apiBase,
      extraHeaders: options.headers,
    })
    if (!result.ok) {
      ctx.ui.notify(redactValue(result.error.message), "error")
      return
    }
    ctx.ui.notify(formatQuota(result.quota), "info")
  }
  pi.registerCommand("commandcode-quota", {
    description: "Show Command Code account usage and quota; refresh rechecks exhausted accounts",
    handler,
  })
  pi.registerCommand("commandcode", {
    description: "Command Code: accounts (交互账号管理) / quota [refresh]",
    handler: async (args, ctx) => {
      const [command, ...rest] = args.trim().split(/\s+/)
      if ((!command || command === "accounts") && rest.length === 0 && options.openAccounts) {
        await options.openAccounts(ctx)
        return
      }
      if (command !== "quota") {
        ctx.ui.notify("Usage: /commandcode accounts | /commandcode quota [refresh]", "info")
        return
      }
      await handler(rest.join(" "), ctx)
    },
  })
}
