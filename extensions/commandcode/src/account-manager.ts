import { createHash } from "node:crypto"
import type { ExhaustionVerification } from "./exhaustion.ts"
import { AccountStore, sanitizeVerification } from "./account-store.ts"
import type { AccountPoolConfig, CommandCodeAccount } from "./account-store.ts"
export { loadAccountPool } from "./account-store.ts"
export type { AccountPoolConfig, CommandCodeAccount } from "./account-store.ts"
type Exhausted = Extract<ExhaustionVerification, { status: "exhausted" }>

export class CommandCodeAccountManager {
  readonly accounts: readonly CommandCodeAccount[]
  readonly remainingCreditsThreshold: number
  private readonly store: AccountStore
  private readonly verify: (
    account: CommandCodeAccount,
    signal?: AbortSignal,
  ) => Promise<ExhaustionVerification>
  private readonly now: () => number
  private readonly pending = new Map<
    string,
    {
      task: Promise<ExhaustionVerification>
      waiters: Set<{ signal?: AbortSignal }>
      controller: AbortController
    }
  >()
  constructor(
    config: AccountPoolConfig,
    options: {
      statePath: string
      verify: (account: CommandCodeAccount, signal?: AbortSignal) => Promise<ExhaustionVerification>
      now?: () => number
    },
  ) {
    if (
      !config.accounts.length ||
      !Number.isFinite(config.remainingCreditsThreshold) ||
      config.remainingCreditsThreshold < 0
    )
      throw new Error("Invalid Command Code account configuration")
    const ids = new Set<string>(),
      keys = new Set<string>()
    for (const a of config.accounts) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(a.id) ||
        !a.apiKey ||
        a.fingerprint !== createHash("sha256").update(a.apiKey).digest("hex") ||
        ids.has(a.id) ||
        keys.has(a.apiKey)
      )
        throw new Error("Invalid Command Code account configuration")
      ids.add(a.id)
      keys.add(a.apiKey)
    }
    this.accounts = Object.freeze(config.accounts.map((a) => Object.freeze({ ...a })))
    this.remainingCreditsThreshold = config.remainingCreditsThreshold
    this.store = new AccountStore(options.statePath, { ...config, accounts: [...this.accounts] })
    this.verify = options.verify
    this.now = options.now ?? Date.now
  }
  private account(account: CommandCodeAccount): CommandCodeAccount {
    const found = this.accounts.find(
      (a) => a.id === account.id && a.fingerprint === account.fingerprint,
    )
    if (!found) throw new Error("Unknown Command Code account")
    return found
  }
  async snapshot(): Promise<{
    activeAccountId?: string
    accounts: Record<string, { fingerprint: string; verification?: Exhausted }>
  }> {
    return this.store.transaction((state) => ({
      activeAccountId: state.activeAccountId,
      accounts: Object.fromEntries(
        Object.entries(state.accounts).map(([id, entry]) => [
          id,
          {
            fingerprint: entry.fingerprint,
            ...(entry.verification ? { verification: structuredClone(entry.verification) } : {}),
          },
        ]),
      ),
    }))
  }
  async markExhausted(account: CommandCodeAccount, result: Exhausted): Promise<void> {
    const a = this.account(account),
      safe = sanitizeVerification(result, this.accounts)
    await this.store.transaction((state) => {
      const entry = state.accounts[a.id]
      if (!entry.verification || safe.observedAt >= entry.verification.observedAt)
        entry.verification = safe
      // Even an older failure invalidates in-flight recovery observations.
      entry.revision++
    })
  }
  async refresh(
    account: CommandCodeAccount,
    signal?: AbortSignal,
  ): Promise<ExhaustionVerification> {
    signal?.throwIfAborted()
    const a = this.account(account)
    let shared = this.pending.get(a.id)
    if (!shared || shared.controller.signal.aborted) {
      const waiters = new Set<{ signal?: AbortSignal }>()
      const controller = new AbortController()
      const task = Promise.resolve().then(() =>
        this.query(a, () => [...waiters].some((w) => !w.signal?.aborted), controller.signal),
      )
      shared = { task, waiters, controller }
      this.pending.set(a.id, shared)
      const entry = shared
      void task
        .finally(() => {
          if (this.pending.get(a.id) === entry) this.pending.delete(a.id)
        })
        .catch(() => {})
    }
    const waiter = { signal }
    shared.waiters.add(waiter)
    try {
      return await this.wait(shared.task, signal)
    } finally {
      shared.waiters.delete(waiter)
      if (!shared.waiters.size) shared.controller.abort()
    }
  }
  dispose(): void {
    for (const entry of this.pending.values()) entry.controller.abort()
    this.pending.clear()
  }
  private async query(
    a: CommandCodeAccount,
    hasWaiters: () => boolean,
    signal: AbortSignal,
  ): Promise<ExhaustionVerification> {
    if (!hasWaiters()) throw new DOMException("Aborted", "AbortError")
    const revision = await this.store.transaction((state) => state.accounts[a.id].revision, signal)
    if (!hasWaiters()) throw new DOMException("Aborted", "AbortError")
    let result: ExhaustionVerification
    try {
      result = await this.verify(a, signal)
    } catch {
      result = { status: "unknown", reason: "Quota verification failed" }
    }
    signal.throwIfAborted()
    if (result.status === "unknown")
      result = { status: "unknown", reason: "Quota verification unavailable" }
    else if (result.status === "exhausted") {
      result = sanitizeVerification(result, this.accounts)
      result.recheckAt = Math.max(result.recheckAt, result.knownResetAt ?? 0, this.now() + 30_000)
    } else if (result.status !== "available" || !Number.isFinite(result.observedAt))
      result = { status: "unknown", reason: "Invalid quota verification" }
    const committed = await this.store.transaction((state) => {
      const entry = state.accounts[a.id]
      if (entry.fingerprint !== a.fingerprint || entry.revision !== revision) return false
      if (result.status === "available") {
        if (entry.verification && result.observedAt < entry.verification.observedAt) return false
        delete entry.verification
      } else if (result.status === "exhausted") {
        if (entry.verification && result.observedAt < entry.verification.observedAt) return false
        entry.verification = result
      } else if (entry.verification) {
        entry.verification = {
          ...entry.verification,
          recheckAt: Math.max(entry.verification.recheckAt, this.now() + 30_000),
        }
      }
      entry.revision++
      return true
    }, signal)
    return committed
      ? result
      : { status: "unknown", reason: "Quota state changed during verification" }
  }
  private wait<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return task
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort)
        reject(new DOMException("Aborted", "AbortError"))
      }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      task.then(
        (value) => {
          signal.removeEventListener("abort", abort)
          if (!signal.aborted) resolve(value)
        },
        (error) => {
          signal.removeEventListener("abort", abort)
          if (!signal.aborted) reject(error)
        },
      )
    })
  }
  async getActiveAccount(
    excluded: ReadonlySet<string> = new Set(),
    signal?: AbortSignal,
  ): Promise<CommandCodeAccount> {
    const checked = new Set<string>()
    const unknown = new Set<string>()
    for (let i = 0; i <= this.accounts.length; i++) {
      signal?.throwIfAborted()
      const decision = await this.store.transaction((state) => {
        const activeIndex = this.accounts.findIndex((a) => a.id === state.activeAccountId)
        const ordered =
          activeIndex >= 0
            ? [...this.accounts.slice(activeIndex), ...this.accounts.slice(0, activeIndex)]
            : [...this.accounts]
        // Prefer an already usable global active even when another request has just failed.
        for (const a of ordered) {
          if (excluded.has(a.id)) continue
          const mark = state.accounts[a.id].verification
          if (!mark) {
            state.activeAccountId = a.id
            return { account: a }
          }
          if (mark.recheckAt <= this.now() && !checked.has(a.id)) return { recheck: a }
        }
        const marks = this.accounts
          .map((a) => state.accounts[a.id].verification)
          .filter((m): m is Exhausted => !!m)
        const earliest = marks.length ? Math.min(...marks.map((m) => m.recheckAt)) : undefined
        const details = this.accounts
          .flatMap((a) =>
            state.accounts[a.id].verification
              ? [`${a.id}: ${state.accounts[a.id].verification!.reasons.join("; ")}`]
              : [],
          )
          .join(" | ")
        return {
          error: `Command Code accounts unavailable (${this.accounts.map((a) => a.id).join(", ")}): confirmed exhausted ${marks.length}${unknown.size ? `; recovery verification failed for ${[...unknown].join(", ")}` : ""}; earliest recheck ${earliest === undefined ? "unknown (request candidates excluded)" : `${earliest} (in ${Math.max(0, Math.ceil((earliest - this.now()) / 1000))}s, recovery not guaranteed)`}${details ? `; ${details}` : ""}`,
        }
      }, signal)
      signal?.throwIfAborted()
      if (decision.account) return decision.account
      if (decision.recheck) {
        checked.add(decision.recheck.id)
        if ((await this.refresh(decision.recheck, signal)).status === "unknown")
          unknown.add(decision.recheck.id)
        continue
      }
      throw new Error(decision.error)
    }
    throw new Error("Command Code accounts unavailable after bounded recovery checks")
  }
}
