import {
  BorderedLoader,
  DynamicBorder,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"
import { SelectList, Text, matchesKey, visibleWidth } from "@earendil-works/pi-tui"
import { fetchCommandCodeQuota } from "./quota.ts"
import type { CommandCodeQuota, CommandCodeQuotaResult, CommandCodeWindowLimit } from "./quota-types.ts"
import type { AccountConfigDraft } from "./account-config.ts"
import type { CommandCodeAccountManager } from "./account-manager.ts"

export interface AccountDisplayQuota {
  result: CommandCodeQuotaResult
  fetchedAt: number
}
export type AccountQuotaCache = Map<string, AccountDisplayQuota>

export function getAccountEarliestExpiry(
  quota?: CommandCodeQuota | null,
  now: number = Date.now(),
): number | undefined {
  if (!quota) return undefined

  // 最近到期指的是月额度到期（currentPeriodEnd）；5H和周窗口属于滑动用量限制，不属于额度过期
  const credits = quota.credits
  const sub = quota.subscription
  if (sub?.currentPeriodEnd) {
    const hasMonthly = credits ? credits.monthlyCredits > 0 : true
    if (hasMonthly) {
      const raw = sub.currentPeriodEnd
      let endMs: number | undefined
      if (typeof raw === "number" && Number.isFinite(raw)) {
        endMs = raw >= 1e12 ? raw : raw * 1000
      } else if (typeof raw === "string" && raw.trim()) {
        const trimmed = raw.trim()
        if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
          const num = Number(trimmed)
          endMs = num >= 1e12 ? num : num * 1000
        } else {
          const parsed = Date.parse(trimmed)
          if (Number.isFinite(parsed)) endMs = parsed
        }
      }
      if (endMs !== undefined && endMs > now) return endMs
    }
  }

  return undefined
}

/** Display query that refreshes quota cache and synchronizes available status with the account manager. */
export async function refreshAccountDisplayQuota(
  ctx: ExtensionCommandContext,
  accounts: AccountConfigDraft["accounts"],
  cache: AccountQuotaCache,
  options: {
    apiBase?: string
    headers?: Record<string, string>
    manager?: CommandCodeAccountManager
    remainingCreditsThreshold?: number
  },
): Promise<void> {
  if (!accounts.length) return
  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    const controller = new AbortController()
    const loader = new BorderedLoader(
      tui,
      theme,
      `正在查询 ${accounts.length} 个账号的额度…（Esc 取消）`,
    )
    let closed = false,
      next = 0
    const finish = () => {
      if (!closed) {
        closed = true
        done()
      }
    }
    loader.onAbort = () => {
      controller.abort()
      finish()
    }
    const worker = async () => {
      while (!controller.signal.aborted && next < accounts.length) {
        const account = accounts[next++]
        let result: CommandCodeQuotaResult
        try {
          result = await fetchCommandCodeQuota({
            apiKey: account.apiKey,
            baseUrl: options.apiBase,
            extraHeaders: options.headers,
            signal: controller.signal,
            timeoutMs: 15_000,
          })
        } catch {
          result = { ok: false, error: { kind: "network", message: "Quota query failed" } }
        }
        if (!controller.signal.aborted) {
          cache.set(account.apiKey, { result, fetchedAt: Date.now() })
          if (options.manager && result.ok && result.quota.credits) {
            const matched = options.manager.accounts.find(
              (a) => a.id === account.id && a.apiKey === account.apiKey,
            )
            if (matched) {
              const credits = result.quota.credits
              const threshold = options.remainingCreditsThreshold ?? 0.1
              const five = credits.windowLimits.find((limit) => limit.window === "fiveHour")
              const week = credits.windowLimits.find((limit) => limit.window === "weekly")
              const available =
                credits.remainingCredits > threshold &&
                (!five || five.cap <= 0 || five.used < five.cap) &&
                (!week || week.cap <= 0 || week.used < week.cap)
              const expiresAt = getAccountEarliestExpiry(result.quota)
              if (available) {
                await options.manager.markAvailable(matched, { expiresAt }).catch(() => {})
              }
            }
          }
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(2, accounts.length) }, worker)).then(
      finish,
      finish,
    )
    return {
      render: (width: number) => loader.render(width),
      invalidate: () => loader.invalidate(),
      handleInput(data: string) {
        if (matchesKey(data, "ctrl+c")) {
          controller.abort()
          finish()
        } else loader.handleInput(data)
      },
      dispose() {
        closed = true
        controller.abort()
        loader.dispose()
      },
    }
  })
}

const amount = (value: number) => value.toFixed(2)
const percent = (limit?: CommandCodeWindowLimit) =>
  limit && limit.cap > 0 ? `${Math.round((limit.used / limit.cap) * 100)}%` : "未知"

export function accountQuotaMetrics(entry?: AccountDisplayQuota) {
  if (!entry || !entry.result.ok || !entry.result.quota.credits) {
    return {
      available: null,
      total: null,
      fivePct: null,
      weekPct: null,
      five: undefined,
      week: undefined,
    }
  }
  const credits = entry.result.quota.credits
  const five = credits.windowLimits.find((limit) => limit.window === "fiveHour")
  const week = credits.windowLimits.find((limit) => limit.window === "weekly")

  let available = credits.remainingCredits
  if (five && five.cap > 0) {
    available = Math.min(available, Math.max(0, five.cap - five.used))
  }
  if (week && week.cap > 0) {
    available = Math.min(available, Math.max(0, week.cap - week.used))
  }

  const fivePct = five && five.cap > 0 ? Math.round((five.used / five.cap) * 100) : null
  const weekPct = week && week.cap > 0 ? Math.round((week.used / week.cap) * 100) : null

  return {
    available,
    total: credits.remainingCredits,
    fivePct,
    weekPct,
    five,
    week,
  }
}

export function padEndVisible(str: string, targetWidth: number): string {
  const w = visibleWidth(str)
  return w < targetWidth ? str + " ".repeat(targetWidth - w) : str
}

export function padStartVisible(str: string, targetWidth: number): string {
  const w = visibleWidth(str)
  return w < targetWidth ? " ".repeat(targetWidth - w) + str : str
}

export function resetLabel(timestampMs?: number | null): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return "重置时间未知"
  const delta = timestampMs - Date.now()
  if (delta <= 0) return "重置时间已到，待刷新"
  const minutes = Math.ceil(delta / 60_000)
  const duration =
    minutes < 60
      ? `${minutes}分`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}小时${minutes % 60 ? `${minutes % 60}分` : ""}`
        : `${Math.floor(minutes / 1440)}天${Math.floor((minutes % 1440) / 60)}小时`
  return `${duration}后重置`
}
export function accountQuotaText(entry?: AccountDisplayQuota): {
  compact: string
  detail: string[]
} {
  if (!entry)
    return { compact: "额度未查询", detail: ["新添或替换的 Key 尚未查询额度，可选择“刷新额度”。"] }
  const { result, fetchedAt } = entry
  const time = new Date(fetchedAt).toLocaleTimeString("zh-CN", { hour12: false })
  if (!result.ok) {
    const reason = {
      config: "凭证未配置",
      http: "接口或鉴权错误",
      network: "网络错误",
      timeout: "查询超时",
    }[result.error.kind]
    return {
      compact: `额度未知 · ${reason}`,
      detail: [
        `查询失败：${reason}（${time}）。可选择“刷新额度”重试。`,
        "查询失败不等于耗尽，不会触发轮换。",
      ],
    }
  }
  const credits = result.quota.credits
  if (!credits)
    return {
      compact: "余额未知",
      detail: [`额度接口未返回可用余额数据（${time}），不会按零余额处理。`],
    }
  const five = credits.windowLimits.find((limit) => limit.window === "fiveHour")
  const week = credits.windowLimits.find((limit) => limit.window === "weekly")

  // 当前真实可用额度：取总剩余余额、5小时窗口剩余以及本周窗口剩余的交集（最小值）
  let available = credits.remainingCredits
  if (five && five.cap > 0) {
    available = Math.min(available, Math.max(0, five.cap - five.used))
  }
  if (week && week.cap > 0) {
    available = Math.min(available, Math.max(0, week.cap - week.used))
  }

  const window = (label: string, limit?: CommandCodeWindowLimit) =>
    limit
      ? `${label}  已用 ${amount(limit.used)} / ${amount(limit.cap)} (${percent(limit)})  · ${resetLabel(limit.resetAt === null ? null : limit.resetAt * 1000)}`
      : `${label}  未返回窗口数据`
  const detail = [
    `近期可用 $${amount(available)}  ·  账户总余 $${amount(credits.remainingCredits)}（月度 ${amount(credits.monthlyCredits)} / 购买 ${amount(credits.purchasedCredits)} / 免费 ${amount(credits.freeCredits)}）`,
    window("5小时", five),
    window("周窗口", week),
  ]
  if (result.quota.subscription?.currentPeriodEnd) {
    const raw = result.quota.subscription.currentPeriodEnd
    let endMs: number | undefined
    if (typeof raw === "number" && Number.isFinite(raw)) endMs = raw >= 1e12 ? raw : raw * 1000
    else if (typeof raw === "string" && raw.trim()) {
      const trimmed = raw.trim()
      if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
        const num = Number(trimmed)
        endMs = num >= 1e12 ? num : num * 1000
      } else {
        const parsed = Date.parse(trimmed)
        if (Number.isFinite(parsed)) endMs = parsed
      }
    }
    if (endMs !== undefined) {
      detail.push(`月度周期  ${resetLabel(endMs)}`)
    }
  }
  detail.push(`查询时间 ${time} · 百分比为已用比例 · 此处查询不改变轮换状态`)
  return {
    compact: `近期可用 $${amount(available)} (总余 $${amount(credits.remainingCredits)}) · 5h ${percent(five)} · 周 ${percent(week)}`,
    detail,
  }
}

export function toEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value >= 1e12 ? value : value * 1000
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim()
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed)
      return num >= 1e12 ? num : num * 1000
    }
    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

export function padCell(
  str: string,
  targetWidth: number,
  align: "left" | "right" | "center" = "left",
): string {
  const w = visibleWidth(str)
  if (w >= targetWidth) return str
  const pad = " ".repeat(targetWidth - w)
  if (align === "right") return pad + str
  if (align === "center") {
    const left = " ".repeat(Math.floor((targetWidth - w) / 2))
    const right = " ".repeat(targetWidth - w - left.length)
    return left + str + right
  }
  return str + pad
}

export function renderDetailCard(
  theme: any,
  title: string,
  lines: string[],
  cardWidth: number,
): string[] {
  const innerWidth = Math.max(20, cardWidth - 6)
  const topTitle = " " + title + " "
  const topDashLen = Math.max(2, innerWidth + 1 - visibleWidth(topTitle))
  const topBorder =
    "  " +
    theme.fg("accent", "╭─") +
    theme.fg("accent", theme.bold(topTitle)) +
    theme.fg("accent", "─".repeat(topDashLen) + "╮")
  const botBorder =
    "  " + theme.fg("accent", "╰" + "─".repeat(innerWidth + 2) + "╯")

  const content = lines.map((line) => {
    const w = visibleWidth(line)
    const pad = w < innerWidth ? " ".repeat(innerWidth - w) : ""
    return "  " + theme.fg("accent", "│") + " " + line + pad + " " + theme.fg("accent", "│")
  })

  return [topBorder, ...content, botBorder]
}

export interface AccountTableOptions {
  accountCount: number
  tableTop: string
  tableHeader: string
  tableDivider: string
  tableBottom: string
  tableWidth: number
}

/** Compact per-account quota rows; highlighted account gets a full detail panel. */
export async function selectAccountQuotaMenu(
  ctx: ExtensionCommandContext,
  title: string,
  items: Array<{ value: string; label: string; detail?: string[]; detailTitle?: string }>,
  tableOptions?: AccountTableOptions,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, kb, done) => {
    const border = new DynamicBorder((text: string) => theme.fg("accent", text))
    const select = new SelectList(items, Math.min(items.length, 14), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    })
    select.onSelect = (item) => done(item.value)
    select.onCancel = () => done(undefined)
    select.onSelectionChange = () => tui.requestRender()
    return {
      render(width: number) {
        const current = select.getSelectedItem()
        const currentItem = items.find((item) => item.value === current?.value)
        const detailLines = currentItem?.detail ?? [
          "修改先保存在草稿中，选择“保存并生效”才会写入配置。",
        ]
        const detailTitle = currentItem?.detailTitle ?? "详情说明"

        const selectLines = select.render(width)
        const accountCount = tableOptions?.accountCount ?? 0
        const accountLines = selectLines.slice(0, accountCount)
        const actionLines = selectLines.slice(accountCount)

        const cardWidth = Math.min(width - 4, tableOptions?.tableWidth ?? width - 4)
        const card = renderDetailCard(theme, detailTitle, detailLines, cardWidth)

        if (tableOptions && accountCount > 0) {
          const table = [
            tableOptions.tableTop,
            tableOptions.tableHeader,
            tableOptions.tableDivider,
            ...accountLines,
            tableOptions.tableBottom,
          ]
          return [
            ...border.render(width),
            ...new Text(theme.fg("accent", theme.bold(title)), 1, 0).render(width),
            "",
            ...table,
            "",
            ...actionLines,
            "",
            ...card,
            "",
            ...new Text(theme.fg("dim", "↑↓ 选择账号查看详情 · Enter 管理 · Esc 关闭"), 1, 0).render(
              width,
            ),
            ...border.render(width),
          ]
        }

        return [
          ...border.render(width),
          ...new Text(theme.fg("accent", theme.bold(title)), 1, 0).render(width),
          "",
          ...selectLines,
          "",
          ...card,
          "",
          ...new Text(theme.fg("dim", "↑↓ 选择账号查看详情 · Enter 管理 · Esc 关闭"), 1, 0).render(
            width,
          ),
          ...border.render(width),
        ]
      },
      invalidate() {
        select.invalidate()
        border.invalidate()
      },
      handleInput(data: string) {
        if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) done(undefined)
        else select.handleInput(data)
        tui.requestRender()
      },
    }
  })
}
