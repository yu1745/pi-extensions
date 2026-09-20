import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { Container, Input, Text, matchesKey, visibleWidth } from "@earendil-works/pi-tui"
import { readAccountConfig, saveAccountConfig, type AccountConfigDraft } from "./account-config.ts"
import type { CommandCodeAccountManager } from "./account-manager.ts"
import {
  accountQuotaMetrics,
  accountQuotaText,
  padCell,
  padEndVisible,
  padStartVisible,
  refreshAccountDisplayQuota,
  resetLabel,
  selectAccountQuotaMenu,
  toEpochMs,
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

function formatAccountExpiryBadge(
  accountEndMs: number | undefined,
  allEndMs: Array<{ id: string; endMs: number }>,
): string {
  if (!accountEndMs) return "重置时间未知"
  const date = new Date(accountEndMs)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hour = String(date.getHours()).padStart(2, "0")
  const min = String(date.getMinutes()).padStart(2, "0")
  const shortDate = `${month}/${day} ${hour}:${min}`

  const valid = allEndMs.filter((e) => e.endMs > 0)
  if (valid.length > 1) {
    const minEnd = Math.min(...valid.map((e) => e.endMs))
    if (accountEndMs === minEnd) {
      return `${shortDate} (先到期)`
    }
    return `${shortDate} (后到期)`
  }
  return shortDate
}

function buildAccountDetailCard(
  account: { id: string; apiKey: string },
  current: boolean,
  cooldown: any,
  quotaEntry: any,
  draftThreshold: number,
  expiryBadge: string,
  theme: any,
): string[] {
  const result = quotaEntry?.result
  const credits = result?.ok ? result.quota.credits : undefined
  const sub = result?.ok ? result.quota.subscription : undefined
  const time = quotaEntry
    ? new Date(quotaEntry.fetchedAt).toLocaleTimeString("zh-CN", { hour12: false })
    : "--"

  let planName = "未知方案"
  if (sub?.planId) {
    if (sub.planId.includes("goat")) planName = "goat 账号 (individual-goat)"
    else if (sub.planId.includes("go")) planName = "go 账号 (individual-go)"
    else planName = `${sub.planId} 账号`
  }

  const roleText = current
    ? theme.fg("success", theme.bold("当前活跃账号"))
    : theme.fg("dim", "备用账号")

  const statusText = cooldown
    ? theme.fg(
        "error",
        theme.bold(`冷却中 (${resetLabel(cooldown.recheckAt).replace("后重置", "后可重新核验")})`),
      )
    : theme.fg("success", "正常可用")

  const lines: string[] = [
    theme.fg("muted", "方案: ") +
      theme.fg("accent", theme.bold(planName)) +
      "   " +
      theme.fg("muted", "角色: ") +
      roleText +
      "   " +
      theme.fg("muted", "状态: ") +
      statusText,
    "",
    theme.fg("accent", theme.bold("额度余额")),
  ]

  if (credits) {
    const availNum = credits.remainingCredits
    const availColor = availNum <= draftThreshold ? "error" : availNum < 2 ? "warning" : "success"
    lines.push(
      theme.fg("muted", "  近期可用: ") +
        theme.fg(availColor, theme.bold(`$${availNum.toFixed(2)}`)) +
        "         " +
        theme.fg("muted", "账户总额: ") +
        theme.bold(`$${credits.remainingCredits.toFixed(2)}`),
    )
    lines.push(
      theme.fg("muted", "  月度额度: ") +
        theme.fg("accent", `$${credits.monthlyCredits.toFixed(2)}`) +
        "         " +
        theme.fg("muted", "购买额度: ") +
        theme.fg(
          credits.purchasedCredits > 0 ? "success" : "muted",
          `$${credits.purchasedCredits.toFixed(2)}`,
        ) +
        "         " +
        theme.fg("muted", "免费额度: ") +
        theme.fg(credits.freeCredits > 0 ? "success" : "muted", `$${credits.freeCredits.toFixed(2)}`),
    )
  } else {
    lines.push(theme.fg("dim", "  额度数据未返回或查询失败"))
  }

  lines.push("", theme.fg("accent", theme.bold("用量窗口")))
  if (credits) {
    const five = credits.windowLimits.find((l: any) => l.window === "fiveHour")
    const week = credits.windowLimits.find((l: any) => l.window === "weekly")

    const formatWin = (label: string, limit?: any) => {
      if (!limit) return theme.fg("dim", `  ${label}: 未返回窗口数据`)
      const pct = limit.cap > 0 ? Math.round((limit.used / limit.cap) * 100) : 0
      const pctColor = pct >= 90 ? "error" : pct >= 70 ? "warning" : "muted"
      const reset = resetLabel(limit.resetAt === null ? null : limit.resetAt * 1000)
      return (
        theme.fg("muted", `  ${label}: `) +
        theme.fg(pctColor, `${limit.used.toFixed(2)} / ${limit.cap.toFixed(2)} (${pct}%)`) +
        theme.fg("dim", ` · ${reset}`)
      )
    }

    lines.push(formatWin("5小时窗口", five))
    lines.push(formatWin("每周窗口 ", week))

    if (sub?.currentPeriodEnd) {
      const endMs = toEpochMs(sub.currentPeriodEnd)
      if (endMs) {
        const dateStr = new Date(endMs).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour12: false,
        })
        const reset = resetLabel(endMs)
        const isEarliest = expiryBadge.includes("先到期")
        const badgeColor = isEarliest ? "warning" : "muted"
        lines.push(
          theme.fg("muted", "  月度周期 : ") +
            theme.fg(badgeColor, theme.bold(`${dateStr} 到期`)) +
            theme.fg("dim", ` (${reset}${isEarliest ? " · ⭐ 先到期优先" : ""})`),
        )
      }
    }
  } else {
    lines.push(theme.fg("dim", "  窗口数据未返回"))
  }

  lines.push(
    "",
    theme.fg("dim", `提示: 查询时间 ${time} · 百分比为已用比例 · 此处查询不改变轮换状态`),
  )

  return lines
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
    await refreshAccountDisplayQuota(ctx, draft.accounts, quotaCache, {
      ...options,
      remainingCreditsThreshold: draft.remainingCreditsThreshold,
    })
    await readRuntime()
    for (;;) {
      // The cache is keyed by the actual key, so replacing a key never reuses old quota.
      const theme = ctx.ui.theme

      const allEndMs = draft.accounts
        .map((a) => {
          const q = quotaCache.get(a.apiKey)?.result
          const sub = q?.ok ? q.quota.subscription : undefined
          return { id: a.id, endMs: toEpochMs(sub?.currentPeriodEnd) ?? 0 }
        })
        .filter((e) => e.endMs > 0)

      const cols = [
        { header: "账号", width: 10, align: "left" as const },
        { header: "方案", width: 11, align: "left" as const },
        { header: "状态", width: 9, align: "left" as const },
        { header: "近期可用", width: 9, align: "right" as const },
        { header: "总余额", width: 9, align: "right" as const },
        { header: "5h已用", width: 7, align: "right" as const },
        { header: "周已用", width: 7, align: "right" as const },
        { header: "月到期(北京)", width: 20, align: "left" as const },
      ]

      const borderLine = (charL: string, charM: string, charR: string) =>
        theme.fg("dim", "  " + charL + cols.map((c) => "─".repeat(c.width + 2)).join(charM) + charR)

      const tableTop = borderLine("┌", "┬", "┐")
      const tableHeader =
        theme.fg("dim", "  │ ") +
        cols
          .map((c) => theme.fg("accent", theme.bold(padCell(c.header, c.width, "center"))))
          .join(theme.fg("dim", " │ ")) +
        theme.fg("dim", " │")
      const tableDivider = borderLine("├", "┼", "┤")
      const tableBottom = borderLine("└", "┴", "┘")
      const tableWidth = visibleWidth(tableTop)
      const sep = theme.fg("dim", " │ ")

      const accountItems = draft.accounts.map((account) => {
        let id = account.id
        for (const entry of draft.accounts) id = id.split(entry.apiKey).join("[隐藏]")
        const current = account.id === runtimeState?.activeAccountId
        const unchangedKey = options.manager?.accounts.some(
          (entry) => entry.id === account.id && entry.apiKey === account.apiKey,
        )
        const quotaEntry = quotaCache.get(account.apiKey)
        const metrics = accountQuotaMetrics(quotaEntry)
        const isFreshlyAvailable =
          metrics.available !== null &&
          metrics.available > draft.remainingCreditsThreshold &&
          (metrics.fivePct === null || metrics.fivePct < 100) &&
          (metrics.weekPct === null || metrics.weekPct < 100)
        const cooldown =
          unchangedKey && !isFreshlyAvailable
            ? runtimeState?.accounts[account.id]?.verification
            : undefined

        const sub = quotaEntry?.result.ok ? quotaEntry.result.quota.subscription : undefined
        let planBadge = theme.fg("dim", padCell("--", 11, "left"))
        if (sub?.planId) {
          if (sub.planId.includes("goat")) {
            planBadge = theme.fg("warning", padCell("goat 账号", 11, "left"))
          } else if (sub.planId.includes("go")) {
            planBadge = theme.fg("accent", padCell("go 账号", 11, "left"))
          } else {
            planBadge = theme.fg("muted", padCell(sub.planId, 11, "left"))
          }
        }

        let statusBadge = ""
        if (cooldown) {
          statusBadge = theme.fg("error", theme.bold(padCell("× 冷却中", 9, "left")))
        } else if (current) {
          statusBadge = theme.fg("success", theme.bold(padCell("● 活跃中", 9, "left")))
        } else {
          statusBadge = theme.fg("accent", padCell("○ 就绪", 9, "left"))
        }

        let availCol = theme.fg("dim", padCell("--", 9, "right"))
        let totalCol = theme.fg("dim", padCell("--", 9, "right"))
        let fiveCol = theme.fg("dim", padCell("--", 7, "right"))
        let weekCol = theme.fg("dim", padCell("--", 7, "right"))

        if (metrics.available !== null && metrics.total !== null) {
          const availNum = metrics.available.toFixed(2)
          const totalNum = metrics.total.toFixed(2)

          const availColor =
            metrics.available <= draft.remainingCreditsThreshold
              ? "error"
              : metrics.available < 2
                ? "warning"
                : "success"
          availCol = theme.fg(availColor, padCell(`$${availNum}`, 9, "right"))
          totalCol = theme.bold(padCell(`$${totalNum}`, 9, "right"))

          const fiveColor =
            metrics.fivePct !== null && metrics.fivePct >= 90
              ? "error"
              : metrics.fivePct !== null && metrics.fivePct >= 70
                ? "warning"
                : "muted"
          fiveCol = theme.fg(
            fiveColor,
            padCell(metrics.fivePct !== null ? `${metrics.fivePct}%` : "--", 7, "right"),
          )

          const weekColor =
            metrics.weekPct !== null && metrics.weekPct >= 90
              ? "error"
              : metrics.weekPct !== null && metrics.weekPct >= 70
                ? "warning"
                : "muted"
          weekCol = theme.fg(
            weekColor,
            padCell(metrics.weekPct !== null ? `${metrics.weekPct}%` : "--", 7, "right"),
          )
        }

        const accountEndMs = toEpochMs(sub?.currentPeriodEnd)
        const expiryBadgeStr = formatAccountExpiryBadge(accountEndMs, allEndMs)
        let expiryCol = theme.fg("dim", padCell(expiryBadgeStr, 20, "left"))
        if (expiryBadgeStr.includes("先到期")) {
          expiryCol = theme.fg("warning", theme.bold(padCell(expiryBadgeStr, 20, "left")))
        } else if (expiryBadgeStr.includes("后到期")) {
          expiryCol = theme.fg("muted", padCell(expiryBadgeStr, 20, "left"))
        }

        const cells = [
          theme.fg("accent", theme.bold(padCell(id, 10, "left"))),
          planBadge,
          statusBadge,
          availCol,
          totalCol,
          fiveCol,
          weekCol,
          expiryCol,
        ]

        const label = theme.fg("dim", "│ ") + cells.join(sep) + theme.fg("dim", " │")
        const detail = buildAccountDetailCard(
          account,
          current,
          cooldown,
          quotaEntry,
          draft.remainingCreditsThreshold,
          expiryBadgeStr,
          theme,
        )

        return {
          value: account.id,
          label,
          detail,
          detailTitle: `账号详情 · ${id}`,
        }
      })
      const rows = draft.accounts.map((a) => a.id)
      let totalBalance = 0,
        totalRecentAvailable = 0,
        knownBalances = 0
      for (const account of draft.accounts) {
        const result = quotaCache.get(account.apiKey)?.result
        if (result?.ok && result.quota.credits) {
          const credits = result.quota.credits
          const five = credits.windowLimits.find((limit) => limit.window === "fiveHour")
          const week = credits.windowLimits.find((limit) => limit.window === "weekly")
          let recentAvail = credits.remainingCredits
          if (five && five.cap > 0) {
            recentAvail = Math.min(recentAvail, Math.max(0, five.cap - five.used))
          }
          if (week && week.cap > 0) {
            recentAvail = Math.min(recentAvail, Math.max(0, week.cap - week.used))
          }
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

      const actionItems = [
        {
          value: refresh,
          label: refresh,
          detailTitle: "操作说明 · 刷新额度",
          detail: [
            theme.fg(
              "muted",
              "从 Command Code API 重新获取所有账号的最新余额、5小时/周用量与月度到期时间。",
            ),
            theme.fg("dim", "注意: 仅查询更新额度，不会切换当前活跃账号。"),
          ],
        },
        {
          value: add,
          label: add,
          detailTitle: "操作说明 · 添加 / 导入 Key",
          detail: [
            theme.fg(
              "muted",
              "添加新的 API Key 到账号池。支持直接粘贴多个 Key（以逗号或换行分隔）。",
            ),
            theme.fg("dim", "内容仅保存在本地配置文件，不进入聊天记录或模型上下文。"),
          ],
        },
        {
          value: threshold,
          label: threshold,
          detailTitle: "操作说明 · 耗尽阈值",
          detail: [
            theme.fg("muted", `修改低余额耗尽阈值（当前 ${draft.remainingCreditsThreshold}）。`),
            theme.fg("dim", "当账号可用余额 ≤ 阈值时自动标记耗尽并轮换下一可用账号。"),
          ],
        },
        {
          value: save,
          label: save,
          detailTitle: "操作说明 · 保存配置",
          detail: [
            theme.fg(
              "muted",
              dirty()
                ? "将当前草稿修改写入本地配置文件，并重新加载扩展生效。"
                : "当前配置已保存，无未提交的修改。",
            ),
            theme.fg("dim", dirty() ? "保存后会自动触发扩展重载。" : "无需重复保存。"),
          ],
        },
        {
          value: exit,
          label: exit,
          detailTitle: "操作说明 · 关闭",
          detail: [
            theme.fg("muted", dirty() ? "放弃尚未保存的修改并退出。" : "退出账号管理界面，返回终端。"),
          ],
        },
      ]

      const choice = await selectAccountQuotaMenu(
        ctx,
        `Command Code · DeepSeek | ${draft.accounts.length} 个账号 | ${summaryText} (${knownBalances}/${draft.accounts.length})${dirty() ? " · 未保存" : ""}`,
        [...accountItems, ...actionItems],
        {
          accountCount: draft.accounts.length,
          tableTop,
          tableHeader,
          tableDivider,
          tableBottom,
          tableWidth,
        },
      )
      if (choice === refresh) {
        await refreshAccountDisplayQuota(ctx, draft.accounts, quotaCache, {
          ...options,
          remainingCreditsThreshold: draft.remainingCreditsThreshold,
        })
        await readRuntime()
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
