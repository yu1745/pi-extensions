import {
  BorderedLoader,
  DynamicBorder,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"
import { SelectList, Text, matchesKey } from "@earendil-works/pi-tui"
import { fetchCommandCodeQuota } from "./quota.ts"
import type { CommandCodeQuotaResult, CommandCodeWindowLimit } from "./quota-types.ts"
import type { AccountConfigDraft } from "./account-config.ts"

export interface AccountDisplayQuota {
  result: CommandCodeQuotaResult
  fetchedAt: number
}
export type AccountQuotaCache = Map<string, AccountDisplayQuota>

/** Read-only display query. Never invokes manager.refresh/getActiveAccount or changes cooldowns. */
export async function refreshAccountDisplayQuota(
  ctx: ExtensionCommandContext,
  accounts: AccountConfigDraft["accounts"],
  cache: AccountQuotaCache,
  options: { apiBase?: string; headers?: Record<string, string> },
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
        if (!controller.signal.aborted) cache.set(account.apiKey, { result, fetchedAt: Date.now() })
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
  return {
    compact: `近期可用 $${amount(available)} (总余 $${amount(credits.remainingCredits)}) · 5h ${percent(five)} · 周 ${percent(week)}`,
    detail: [
      `近期可用 $${amount(available)}  ·  账户总余 $${amount(credits.remainingCredits)}（月度 ${amount(credits.monthlyCredits)} / 购买 ${amount(credits.purchasedCredits)} / 免费 ${amount(credits.freeCredits)}）`,
      window("5小时", five),
      window("周窗口", week),
      `查询时间 ${time} · 百分比为已用比例 · 此处查询不改变轮换状态`,
    ],
  }
}

/** Compact per-account quota rows; highlighted account gets a full detail panel. */
export async function selectAccountQuotaMenu(
  ctx: ExtensionCommandContext,
  title: string,
  items: Array<{ value: string; label: string; detail?: string[] }>,
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
        const detail = items.find((item) => item.value === current?.value)?.detail ?? [
          "修改先保存在草稿中，选择“保存并生效”才会写入配置。",
        ]
        const tableHeader =
          `   ` +
          theme.fg("muted", "账号名称".padEnd(16)) +
          " " +
          theme.fg("muted", "状态".padEnd(8)) +
          " " +
          theme.fg("muted", "近期可用".padStart(10)) +
          "  " +
          theme.fg("muted", "总余额".padStart(9)) +
          "  " +
          theme.fg("muted", "5h已用".padStart(7)) +
          " " +
          theme.fg("muted", "周已用".padStart(7))

        return [
          ...border.render(width),
          ...new Text(theme.fg("accent", theme.bold(title)), 1, 0).render(width),
          "",
          ...new Text(tableHeader, 1, 0).render(width),
          ...select.render(width),
          "",
          ...new Text(detail.join("\n"), 1, 0).render(width),
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
