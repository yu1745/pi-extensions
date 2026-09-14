export type ExhaustionVerification =
  | {
      status: "exhausted"
      reasons: string[]
      observedAt: number
      knownResetAt?: number
      recheckAt: number
    }
  | { status: "available"; observedAt: number }
  | { status: "unknown"; reason: string }

export interface VerifyOptions {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
  extraHeaders?: Record<string, string>
  remainingCreditsThreshold?: number
  now?: () => number
}

const HOUR = 3_600_000
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const numeric = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0
const unknown = (reason: string): ExhaustionVerification => ({ status: "unknown", reason })

// Numeric epochs follow the existing credits contract: seconds or milliseconds.
function resetTime(value: unknown): number | undefined {
  let time: number
  if (numeric(value)) time = value >= 1e12 ? value : value * 1000
  else if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) {
    const epoch = Number(value)
    time = epoch >= 1e12 ? epoch : epoch * 1000
  } else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value))
    time = Date.parse(value)
  else return undefined
  return numeric(time) && time <= 8.64e15 ? time : undefined
}

/** Accepts the raw /alpha/billing/credits response, never the display parser's defaults. */
export function verifyCreditsSnapshot(
  raw: unknown,
  options: { remainingCreditsThreshold?: number; now?: () => number } = {},
): ExhaustionVerification {
  const threshold =
    options.remainingCreditsThreshold === undefined ? 0.1 : options.remainingCreditsThreshold
  if (!numeric(threshold)) return unknown("Invalid remaining credits threshold")
  const observedAt = (options.now ?? Date.now)()
  if (!numeric(observedAt)) return unknown("Invalid observation time")
  if (!record(raw)) return unknown("Malformed credits response")
  const reasons: string[] = []
  const resets: number[] = []
  let incomplete = false
  let unknownReset = false
  const credits = record(raw.credits) ? raw.credits : {}
  const balances = [credits.monthlyCredits, credits.purchasedCredits, credits.freeCredits]
  if (balances.every(numeric) && Number.isFinite(balances.reduce((a, b) => a + b, 0))) {
    const remaining = balances.reduce((a, b) => a + b, 0)
    if (remaining <= threshold) {
      reasons.push(`Remaining credits ${remaining} <= threshold ${threshold}`)
      // Credits has no documented recovery field; do not infer recharge from subscriptions.
      unknownReset = true
    }
  } else incomplete = true

  const windows = record(raw.windowLimits) ? raw.windowLimits : {}
  if (Object.keys(windows).some((key) => key !== "fiveHour" && key !== "weekly")) incomplete = true
  for (const name of ["fiveHour", "weekly"] as const) {
    const entry = windows[name]
    if (!record(entry) || !numeric(entry.used) || !numeric(entry.cap) || entry.cap === 0) {
      incomplete = true
      continue
    }
    if (entry.used >= entry.cap) {
      reasons.push(`${name} window exhausted: used ${entry.used} >= cap ${entry.cap}`)
      const reset = resetTime(entry.resetAt)
      if (reset !== undefined && reset > observedAt) resets.push(reset)
      else unknownReset = true
    }
  }
  if (!reasons.length)
    return incomplete
      ? unknown("Incomplete or invalid credits/window data")
      : { status: "available", observedAt }
  const knownResetAt = resets.length ? Math.max(...resets) : undefined
  const recheckAt = Math.max(
    knownResetAt ?? 0,
    unknownReset || incomplete || !resets.length ? observedAt + HOUR : 0,
  )
  return {
    status: "exhausted",
    reasons,
    observedAt,
    ...(knownResetAt === undefined ? {} : { knownResetAt }),
    recheckAt,
  }
}

function abortError(): Error {
  return new DOMException("Quota verification cancelled", "AbortError")
}

export async function verifyAccountExhaustion(
  options: VerifyOptions,
): Promise<ExhaustionVerification> {
  if (options.signal?.aborted) throw abortError()
  if (!options.apiKey?.trim()) return unknown("Missing API key")
  if (
    !numeric(
      options.remainingCreditsThreshold === undefined ? 0.1 : options.remainingCreditsThreshold,
    )
  )
    return unknown("Invalid remaining credits threshold")
  const timeoutMs = options.timeoutMs ?? 15_000
  if (!numeric(timeoutMs) || timeoutMs === 0 || timeoutMs > 2_147_483_647)
    return unknown("Invalid verification timeout")
  const controller = new AbortController()
  const cancel = () => controller.abort()
  options.signal?.addEventListener("abort", cancel, { once: true })
  const timer = setTimeout(cancel, timeoutMs)
  let onAbort: (() => void) | undefined
  // Race the whole operation, including body parsing and non-cooperative mock fetches.
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError())
    controller.signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    const headers = new Headers(options.extraHeaders)
    headers.delete("x-api-key")
    headers.delete("api-key")
    headers.set("Authorization", `Bearer ${options.apiKey}`)
    headers.set("Accept", "application/json")
    const base = (options.baseUrl ?? "https://api.commandcode.ai").replace(/\/+$/, "")
    const request = async (path: string): Promise<unknown> => {
      if (controller.signal.aborted) throw abortError()
      const response = await (options.fetchImpl ?? fetch)(`${base}${path}`, {
        method: "GET",
        headers,
        signal: controller.signal,
      })
      if (!response.ok) throw new Error("Quota HTTP failure")
      return response.json()
    }
    const operation = async (): Promise<ExhaustionVerification> => {
      const identity = await request("/alpha/whoami")
      if (!record(identity)) return unknown("Malformed account response")
      let orgId: string | undefined
      if (identity.org !== undefined && identity.org !== null) {
        if (!record(identity.org) || typeof identity.org.id !== "string" || !identity.org.id.trim())
          return unknown("Malformed organization identity")
        orgId = identity.org.id
      } else if (
        !record(identity.user) ||
        ![identity.user.userName, identity.user.name].some((v) => typeof v === "string" && v.trim())
      ) {
        return unknown("Missing account identity")
      }
      const query = orgId ? `?${new URLSearchParams({ orgId })}` : ""
      const raw = await request(`/alpha/billing/credits${query}`)
      return verifyCreditsSnapshot(raw, options)
    }
    const result = await Promise.race([operation(), aborted])
    if (options.signal?.aborted) throw abortError()
    return result
  } catch {
    if (options.signal?.aborted) throw abortError()
    return unknown(
      controller.signal.aborted
        ? "Quota verification timed out"
        : "Quota verification request failed",
    )
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", cancel)
    if (onAbort) controller.signal.removeEventListener("abort", onAbort)
  }
}
