import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { Container, Input, Text, matchesKey } from "@earendil-works/pi-tui"
import { readAccountConfig, saveAccountConfig, type AccountConfigDraft } from "./account-config.ts"
import type { CommandCodeAccountManager } from "./account-manager.ts"
import {
  accountQuotaText,
  refreshAccountDisplayQuota,
  resetLabel,
  selectAccountQuotaMenu,
  type AccountQuotaCache,
} from "./account-quota-ui.ts"

/** Reuse Input's editing/paste/cursor support, but NEVER render its real value. */
export class MaskedAccountInput extends Input {
  private pendingPaste: string | undefined
  override handleInput(data: string): void {
    const start = "\x1b[200~",
      end = "\x1b[201~"
    if (this.pendingPaste !== undefined) {
      this.pendingPaste += data
      const index = this.pendingPaste.indexOf(end)
      if (index < 0) return
      const value = this.pendingPaste.slice(0, index).replace(/\r\n?|\n/g, " ")
      const rest = this.pendingPaste.slice(index + end.length)
      this.pendingPaste = undefined
      // Built-in Input removes newlines entirely; normalize separators first so
      // pasting one key per line cannot silently concatenate credentials.
      super.handleInput(start + value + end)
      if (rest) this.handleInput(rest)
      return
    }
    const index = data.indexOf(start)
    if (index >= 0) {
      if (index > 0) super.handleInput(data.slice(0, index))
      this.pendingPaste = ""
      this.handleInput(data.slice(index + start.length))
      return
    }
    super.handleInput(data)
  }
  clearSecrets(): void {
    this.setValue("")
    this.pendingPaste = undefined
  }
  override render(width: number): string[] {
    const secret = this.getValue()
    this.setValue("•".repeat(secret.length))
    try {
      return super.render(width)
    } finally {
      this.setValue(secret)
    }
  }
}

export async function promptAccountKeys(ctx: ExtensionCommandContext): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container()
    const input = new MaskedAccountInput({ placeholder: "粘贴 API Key（支持逗号或换行分隔多个）" })
    let closed = false
    const finish = (value: string | undefined) => {
      if (closed) return
      closed = true
      input.clearSecrets()
      done(value)
    }
    input.onSubmit = (value) => finish(value)
    input.onEscape = () => finish(undefined)
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)))
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Command Code · 安全输入 Key")), 1, 0),
    )
    container.addChild(new Text("内容只保存在本地配置，不进入聊天记录或模型上下文。", 1, 0))
    container.addChild(input)
    container.addChild(new Text(theme.fg("dim", "支持粘贴多个 Key · Enter 确认 · Esc 取消"), 1, 0))
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)))
    return {
      get focused() {
        return input.focused
      },
      set focused(value: boolean) {
        input.focused = value
      },
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        if (closed) return
        if (matchesKey(data, "ctrl+c")) finish(undefined)
        else input.handleInput(data)
        tui.requestRender()
      },
      dispose() {
        closed = true
        input.clearSecrets()
      },
    }
  })
}

interface AccountUiOptions {
  agentDir: string
  homeDir?: string
  env?: NodeJS.ProcessEnv
  manager?: CommandCodeAccountManager
  apiBase?: string
  headers?: Record<string, string>
  // Injectable UI/store boundaries keep tests entirely local and credential-free.
  promptKeys?: (ctx: ExtensionCommandContext) => Promise<string | undefined>
  readConfig?: typeof readAccountConfig
  saveConfig?: typeof saveAccountConfig
}

const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)
const nextId = (draft: AccountConfigDraft) => {
  let i = 1
  while (draft.accounts.some((account) => account.id === `account-${i}`)) i++
  return `account-${i}`
}
const splitKeys = (value: string) => [...new Set(value.split(/[\s,]+/).filter(Boolean))]

/** Command-only settings flow. No tools, session entries, or plaintext key notifications. */
export async function openCommandCodeAccounts(
  ctx: ExtensionCommandContext,
  options: AccountUiOptions,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("账号管理界面需要在 Pi 交互终端中打开。", "warning")
    return
  }
  await ctx.waitForIdle()
  let snapshot: ReturnType<typeof readAccountConfig>
  try {
    snapshot = (options.readConfig ?? readAccountConfig)(options)
  } catch {
    ctx.ui.notify(
      options.env?.COMMAND_CODE_API_KEYS !== undefined ||
        (options.env === undefined && process.env.COMMAND_CODE_API_KEYS !== undefined)
        ? "当前账号由 COMMAND_CODE_API_KEYS 环境变量管理。请先取消该变量，再使用账号界面。"
        : "无法读取账号配置：请检查文件格式、类型和权限；原文件未修改。",
      "error",
    )
    return
  }
  const draft = structuredClone(snapshot.draft)
  let runtimeState: Awaited<ReturnType<CommandCodeAccountManager["snapshot"]>> | undefined
  const readRuntime = async () => {
    try {
      runtimeState = await options.manager?.snapshot()
    } catch {
      runtimeState = undefined
    }
  }
  await readRuntime()
  const quotaCache: AccountQuotaCache = new Map()
  const dirty = () => JSON.stringify(draft) !== JSON.stringify(snapshot.draft)
  const prompt = options.promptKeys ?? promptAccountKeys
  const notify = (text: string, level: "info" | "warning" | "error" = "info") =>
    ctx.ui.notify(text, level)
  try {
    await refreshAccountDisplayQuota(ctx, draft.accounts, quotaCache, options)
    for (;;) {
      // The cache is keyed by the actual key, so replacing a key never reuses old quota.
      const accountItems = draft.accounts.map((account, index) => {
        let id = account.id
        for (const entry of draft.accounts) id = id.split(entry.apiKey).join("[隐藏]")
        const current = account.id === runtimeState?.activeAccountId
        const unchangedKey = options.manager?.accounts.some(
          (entry) => entry.id === account.id && entry.apiKey === account.apiKey,
        )
        const cooldown = unchangedKey ? runtimeState?.accounts[account.id]?.verification : undefined
        const quota = accountQuotaText(quotaCache.get(account.apiKey))
        const status = cooldown ? " · 冷却" : ""
        const label = `${index + 1}. ${current ? "●" : "○"} ${id}${status}  |  ${quota.compact}`
        const stateLine = cooldown
          ? `冷却中：${resetLabel(cooldown.recheckAt).replace("后重置", "后可重新核验")}（不保证恢复）`
          : current
            ? "当前粘性账号"
            : "备用账号"
        return { value: label, label, detail: [stateLine, ...quota.detail] }
      })
      const rows = accountItems.map((item) => item.value)
      let totalBalance = 0,
        totalRecentAvailable = 0,
        knownBalances = 0
      for (const account of draft.accounts) {
        const result = quotaCache.get(account.apiKey)?.result
        if (result?.ok && result.quota.credits) {
          const credits = result.quota.credits
          const five = credits.windowLimits.find((limit) => limit.window === "fiveHour")
          const recentAvail =
            five && five.cap > 0
              ? Math.min(credits.remainingCredits, Math.max(0, five.cap - five.used))
              : credits.remainingCredits
          totalBalance += credits.remainingCredits
          totalRecentAvailable += recentAvail
          knownBalances++
        }
      }
      const refresh = "↻ 刷新额度（仅查询，不轮换）"
      const add = "＋ 添加 / 批量导入 Key"
      const threshold = `⚙ 修改耗尽阈值（当前 ${draft.remainingCreditsThreshold}）`
      const save = dirty() ? "✓ 保存并生效" : "✓ 已保存（无修改）"
      const exit = dirty() ? "退出（放弃未保存修改）" : "关闭"
      const summaryText = knownBalances
        ? `近期可用 $${totalRecentAvailable.toFixed(2)} / 总余 $${totalBalance.toFixed(2)}`
        : "余额未知"
      const choice = await selectAccountQuotaMenu(
        ctx,
        `Command Code · DeepSeek | ${draft.accounts.length} 个账号 | ${summaryText} (${knownBalances}/${draft.accounts.length})${dirty() ? " · 未保存" : ""}`,
        [
          ...accountItems,
          ...[refresh, add, threshold, save, exit].map((label) => ({ value: label, label })),
        ],
      )
      if (choice === refresh) {
        await readRuntime()
        await refreshAccountDisplayQuota(ctx, draft.accounts, quotaCache, options)
        continue
      }
      if (choice === undefined || choice === exit) {
        if (
          !dirty() ||
          (await ctx.ui.confirm("放弃修改？", "尚未保存的账号修改将丢弃；现有配置保持不变。"))
        )
          return
        continue
      }
      if (choice === save) {
        if (!dirty()) return
        if (!draft.accounts.length) {
          notify("请先添加至少一个账号。", "warning")
          continue
        }
        try {
          await (options.saveConfig ?? saveAccountConfig)(snapshot, draft)
        } catch {
          notify(
            "保存失败：配置可能已被其他窗口修改，或文件不可写。请关闭后重新打开；不会覆盖已有修改。",
            "error",
          )
          continue
        }
        notify("账号配置已安全保存，正在重载生效。")
        // Reload invalidates this extension instance. Do not access old pi/ctx afterwards.
        await ctx.reload()
        return
      }
      if (choice === threshold) {
        const value = await ctx.ui.input(
          "低余额耗尽阈值（余额 ≤ 此值时视为耗尽）",
          String(draft.remainingCreditsThreshold),
        )
        if (value === undefined) continue
        const text = value.trim(),
          number = Number(text)
        if (!text || !Number.isFinite(number) || number < 0) {
          notify("请输入大于或等于 0 的有效数字。", "warning")
          continue
        }
        draft.remainingCreditsThreshold = number
        continue
      }
      if (choice === add) {
        const value = await prompt(ctx)
        if (value === undefined) continue
        const keys = splitKeys(value)
        if (!keys.length || keys.some((key) => /[\x00-\x1f\x7f-\x9f]/.test(key))) {
          notify("未识别到有效 Key，请重新粘贴。", "warning")
          continue
        }
        const fresh = keys.filter(
          (key) => !draft.accounts.some((account) => account.apiKey === key),
        )
        if (!fresh.length) {
          notify("这些 Key 已存在，没有重复添加。", "warning")
          continue
        }
        if (fresh.length === 1) {
          const suggested = nextId(draft)
          const value = await ctx.ui.input(
            "账号名称（不是 Key；英文、数字、下划线或短横线）",
            suggested,
          )
          if (value === undefined) continue
          const id = value.trim() || suggested
          if (
            !validId(id) ||
            draft.accounts.some((account) => account.id === id) ||
            fresh.some((key) => id.includes(key))
          ) {
            notify("账号名须唯一，以英文或数字开头，最多 64 字符；不要把 Key 当作名称。", "warning")
            continue
          }
          draft.accounts.push({ id, apiKey: fresh[0] })
        } else {
          for (const apiKey of fresh) draft.accounts.push({ id: nextId(draft), apiKey })
        }
        notify(`已加入 ${fresh.length} 个账号到草稿，保存后生效。`)
        continue
      }
      const index = rows.indexOf(choice)
      if (index < 0) continue
      const account = draft.accounts[index]
      const action = await ctx.ui.select("账号操作", ["替换 Key", "删除账号", "返回"])
      if (action === "替换 Key") {
        const value = await prompt(ctx)
        if (value === undefined) continue
        const keys = splitKeys(value)
        if (
          keys.length !== 1 ||
          /[\x00-\x1f\x7f-\x9f]/.test(keys[0]) ||
          draft.accounts.some((entry, i) => i !== index && entry.apiKey === keys[0])
        ) {
          notify("替换时请只输入一个有效、未重复的 Key。", "warning")
          continue
        }
        account.apiKey = keys[0]
      } else if (action === "删除账号") {
        if (draft.accounts.length === 1) {
          notify("至少需要保留一个账号；可使用“替换 Key”。", "warning")
          continue
        }
        if (
          await ctx.ui.confirm(
            "删除此账号？",
            "保存后才会从账号池移除。若它是当前账号，下次请求将选择其他账号。",
          )
        )
          draft.accounts.splice(index, 1)
      }
    }
  } finally {
    // Best-effort release of draft references; never retain secrets in session state.
    quotaCache.clear()
    for (const account of draft.accounts) account.apiKey = ""
    for (const account of snapshot.draft.accounts) account.apiKey = ""
    snapshot.raw = {}
  }
}
