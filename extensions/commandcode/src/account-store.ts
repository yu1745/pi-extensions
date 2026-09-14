import { createHash, randomUUID } from "node:crypto"
import {
  readFileSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
  existsSync,
  chmodSync,
  rmdirSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import type { ExhaustionVerification } from "./exhaustion.ts"

export interface CommandCodeAccount {
  id: string
  apiKey: string
  fingerprint: string
}
export interface AccountPoolConfig {
  accounts: CommandCodeAccount[]
  remainingCreditsThreshold: number
  activeAccountId?: string
  poolId?: string
}
type Exhausted = Extract<ExhaustionVerification, { status: "exhausted" }>
export interface AccountState {
  fingerprint: string
  revision: number
  verification?: Exhausted
}
export interface PoolState {
  version: number
  activeAccountId?: string
  accounts: Record<string, AccountState>
}
const safeId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)
const object = (x: unknown): x is Record<string, any> =>
  !!x && typeof x === "object" && !Array.isArray(x)
export function loadAccountPool(
  options: { env?: NodeJS.ProcessEnv; agentDir?: string; homeDir?: string } = {},
): AccountPoolConfig | undefined {
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  let raw: any
  let source: string | undefined
  if (env.COMMAND_CODE_API_KEYS !== undefined)
    raw = {
      accounts: env.COMMAND_CODE_API_KEYS.split(/[,\n]/)
        .map((key) => key.trim())
        .filter(Boolean)
        .map((apiKey) => ({ apiKey })),
    }
  else {
    for (const path of [
      join(
        options.agentDir ?? env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"),
        "commandcode-accounts.json",
      ),
      join(home, ".commandcode", "accounts.json"),
    ]) {
      try {
        raw = JSON.parse(readFileSync(path, "utf8"))
        source = `file:${resolve(path)}`
        break
      } catch (e: any) {
        if (e?.code === "ENOENT") continue
        throw new Error("Invalid or unreadable Command Code account configuration")
      }
    }
    if (raw === undefined) return undefined
  }
  return parseAccountPool(raw, source)
}

export function parseAccountPool(raw: unknown, source?: string): AccountPoolConfig {
  try {
    if (!object(raw) || !Array.isArray(raw.accounts) || !raw.accounts.length) throw 0
    const threshold = raw.policy?.remainingCreditsThreshold ?? 0.1
    if (raw.policy !== undefined && !object(raw.policy)) throw 0
    if (
      typeof threshold !== "number" ||
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      raw.policy?.remainingCreditsThreshold === null
    )
      throw 0
    const accounts: CommandCodeAccount[] = [],
      keys = new Map<string, CommandCodeAccount>(),
      ids = new Set<string>()
    const mapped: string[] = []
    for (const entry of raw.accounts) {
      if (
        !object(entry) ||
        typeof entry.apiKey !== "string" ||
        !entry.apiKey.trim() ||
        /[\r\n\x00]/.test(entry.apiKey.trim())
      )
        throw 0
      if (entry.id !== undefined && !safeId(entry.id)) throw 0
      const apiKey = entry.apiKey.trim()
      const fingerprint = createHash("sha256").update(apiKey).digest("hex")
      const id = entry.id ?? fingerprint
      const duplicate = keys.get(apiKey)
      if (ids.has(id) && (!duplicate || duplicate.id !== id)) throw 0
      ids.add(id)
      if (duplicate) {
        mapped.push(duplicate.id)
        continue
      }
      const account = { id, apiKey, fingerprint }
      accounts.push(account)
      keys.set(apiKey, account)
      mapped.push(id)
    }
    let activeAccountId = raw.activeAccountId
    if (
      activeAccountId !== undefined &&
      (!safeId(activeAccountId) || !accounts.some((a) => a.id === activeAccountId))
    )
      throw 0
    if (raw.activeIndex !== undefined) {
      if (
        !Number.isInteger(raw.activeIndex) ||
        raw.activeIndex < 0 ||
        raw.activeIndex >= mapped.length
      )
        throw 0
      activeAccountId ??= mapped[raw.activeIndex]
    }
    const poolId = createHash("sha256")
      .update(
        source ??
          `env:${accounts
            .map((a) => a.fingerprint)
            .sort()
            .join(",")}`,
      )
      .digest("hex")
    return { accounts, remainingCreditsThreshold: threshold, activeAccountId, poolId }
  } catch {
    throw new Error("Invalid Command Code account configuration")
  }
}

export function sanitizeVerification(
  value: Exhausted,
  accounts: readonly CommandCodeAccount[],
): Exhausted {
  if (
    !object(value) ||
    value.status !== "exhausted" ||
    !Array.isArray(value.reasons) ||
    !value.reasons.every((v: unknown) => typeof v === "string") ||
    !Number.isFinite(value.observedAt) ||
    value.observedAt < 0 ||
    !Number.isFinite(value.recheckAt) ||
    value.recheckAt < 0 ||
    (value.knownResetAt !== undefined &&
      (!Number.isFinite(value.knownResetAt) || value.knownResetAt < 0))
  )
    throw new Error("Invalid Command Code exhaustion state")
  const scrub = (text: string) =>
    accounts
      .reduce((s, a) => s.split(a.apiKey).join("[redacted]"), text)
      .replace(/cmd_[A-Za-z0-9_-]+/g, "[redacted]")
  return {
    status: "exhausted",
    reasons: value.reasons.map(scrub),
    observedAt: value.observedAt,
    recheckAt: value.recheckAt,
    ...(value.knownResetAt === undefined ? {} : { knownResetAt: value.knownResetAt }),
  }
}

/** A lock is never held while a quota request is running. Errors deliberately omit paths/content. */
export class AccountStore {
  private readonly path: string
  private readonly config: AccountPoolConfig
  constructor(path: string, config: AccountPoolConfig) {
    this.path = path
    this.config = config
  }
  async transaction<T>(fn: (state: PoolState) => T, signal?: AbortSignal): Promise<T> {
    const lock = this.path + ".lock",
      token = randomUUID()
    let owned = false
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const deadline = Date.now() + 2000
      while (!owned) {
        signal?.throwIfAborted()
        let gated = false
        try {
          // Serialize acquisition and dead-owner recovery, so two recoverers cannot
          // unlink a newly acquired live lock. A crashed gate fails closed (timeout).
          mkdirSync(lock + ".gate", { mode: 0o700 })
          gated = true
          const fd = openSync(lock, "wx", 0o600)
          try {
            writeFileSync(fd, JSON.stringify({ pid: process.pid, token }))
            owned = true
          } finally {
            closeSync(fd)
          }
        } catch (e: any) {
          if (e?.code !== "EEXIST") throw e
          // Only a provably dead PID is recoverable. Unknown/partially written locks time out.
          try {
            if (!gated) throw 0
            const before = statSync(lock),
              owner = JSON.parse(readFileSync(lock, "utf8"))
            if (Number.isInteger(owner.pid) && owner.pid > 0) {
              let dead = false
              try {
                process.kill(owner.pid, 0)
              } catch (e: any) {
                dead = e?.code === "ESRCH"
              }
              if (dead) {
                const after = statSync(lock)
                if (before.ino === after.ino && before.dev === after.dev) unlinkSync(lock)
              }
            }
          } catch {
            /* bounded wait for malformed or concurrently removed locks */
          }
          if (gated) {
            rmdirSync(lock + ".gate")
            gated = false
          }
          if (Date.now() >= deadline) throw new Error("lock timeout")
          await new Promise<void>((resolve, reject) => {
            const done = () => {
              signal?.removeEventListener("abort", abort)
              resolve()
            }
            const timer = setTimeout(done, 15)
            const abort = () => {
              clearTimeout(timer)
              signal?.removeEventListener("abort", abort)
              reject(new DOMException("Aborted", "AbortError"))
            }
            signal?.addEventListener("abort", abort, { once: true })
            if (signal?.aborted) abort()
          })
        } finally {
          if (gated) rmdirSync(lock + ".gate")
        }
      }
      signal?.throwIfAborted()
      // File-backed pools retain identity across list edits. Environment pools use
      // a key-set fingerprint, so independent processes cannot prune each other's state.
      const poolId = this.config.poolId ?? "default"
      if (!safeId(poolId)) throw new Error("invalid pool identity")
      let document: { schemaVersion: 1; pools: Record<string, PoolState> }
      let before: string | undefined
      try {
        const raw = JSON.parse(readFileSync(this.path, "utf8"))
        before = JSON.stringify(raw)
        if (!object(raw)) throw 0
        document =
          raw.schemaVersion === undefined && raw.accounts !== undefined
            ? { schemaVersion: 1, pools: { [poolId]: raw as PoolState } }
            : (raw as typeof document)
        if (document.schemaVersion !== 1 || !object(document.pools)) throw 0
        for (const [namespace, pool] of Object.entries(document.pools)) {
          if (
            !safeId(namespace) ||
            !object(pool) ||
            !Number.isSafeInteger(pool.version) ||
            pool.version < 0 ||
            !object(pool.accounts) ||
            (pool.activeAccountId !== undefined && !safeId(pool.activeAccountId))
          )
            throw 0
          for (const [id, entry] of Object.entries(pool.accounts)) {
            if (
              !safeId(id) ||
              !object(entry) ||
              typeof entry.fingerprint !== "string" ||
              !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
              !Number.isSafeInteger(entry.revision) ||
              entry.revision < 0
            )
              throw 0
            if (entry.verification !== undefined)
              entry.verification = sanitizeVerification(entry.verification, this.config.accounts)
          }
        }
      } catch (e: any) {
        if (e?.code !== "ENOENT") throw new Error("corrupt state")
        document = { schemaVersion: 1, pools: {} }
      }
      const state: PoolState = Object.hasOwn(document.pools, poolId)
        ? document.pools[poolId]
        : { version: 0, activeAccountId: this.config.activeAccountId, accounts: {} }
      document.pools[poolId] = state
      const next: Record<string, AccountState> = Object.create(null)
      for (const a of this.config.accounts) {
        const prior = state.accounts[a.id]
        next[a.id] =
          prior?.fingerprint === a.fingerprint
            ? {
                fingerprint: prior.fingerprint,
                revision: prior.revision,
                ...(prior.verification ? { verification: prior.verification } : {}),
              }
            : { fingerprint: a.fingerprint, revision: state.version + 1 }
      }
      state.accounts = next
      if (!this.config.accounts.some((a) => a.id === state.activeAccountId))
        delete state.activeAccountId
      const result = fn(state)
      if (JSON.stringify(document) === before) return result
      state.version++
      const temp = this.path + "." + token + ".tmp"
      try {
        writeFileSync(temp, JSON.stringify(document), { mode: 0o600, flag: "wx" })
        chmodSync(temp, 0o600)
        renameSync(temp, this.path)
      } finally {
        if (existsSync(temp)) unlinkSync(temp)
      }
      return result
    } catch (e: any) {
      if (signal?.aborted || e?.name === "AbortError")
        throw new DOMException("Aborted", "AbortError")
      throw new Error(
        "Command Code account state unavailable (invalid state, write failure, or lock timeout)",
      )
    } finally {
      if (owned) {
        try {
          if (JSON.parse(readFileSync(lock, "utf8")).token === token) unlinkSync(lock)
        } catch {
          /* never remove another owner's lock */
        }
      }
    }
  }
}
