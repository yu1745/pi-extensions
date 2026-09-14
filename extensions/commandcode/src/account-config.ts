import { createHash, randomUUID } from "node:crypto"
import {
  constants,
  lstatSync,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  mkdirSync,
  writeFileSync,
  fchmodSync,
  renameSync,
  unlinkSync,
  rmdirSync,
} from "node:fs"
import { dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { parseAccountPool } from "./account-store.ts"

export interface AccountConfigDraft {
  accounts: Array<{ id: string; apiKey: string }>
  remainingCreditsThreshold: number
}
export interface AccountConfigSnapshot {
  path: string
  revision: string
  draft: AccountConfigDraft
  raw: Record<string, unknown>
}
const invalid = "账号配置无效或无法安全读取，未修改配置文件。"
const conflict = "账号配置已被其他进程修改，请重新打开后再保存。"
const failed = "账号配置保存失败或保存锁超时，未覆盖配置文件。"
const missing = "missing"

/** Never follow a final-component symlink, including dangling links. */
function bytesAt(path: string): Buffer | undefined {
  let stat
  try {
    stat = lstatSync(path)
  } catch (e: any) {
    if (e?.code === "ENOENT") return undefined
    throw new Error(invalid)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(invalid)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new Error(invalid)
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}
function revision(bytes: Buffer | undefined): string {
  return bytes === undefined ? missing : createHash("sha256").update(bytes).digest("hex")
}
export function readAccountConfig(options: {
  agentDir: string
  homeDir?: string
  env?: NodeJS.ProcessEnv
}): AccountConfigSnapshot {
  if ((options.env ?? process.env).COMMAND_CODE_API_KEYS !== undefined)
    throw new Error(
      "COMMAND_CODE_API_KEYS 环境变量优先，无法编辑文件账号配置；未修改任何文件。请先移除该环境变量。",
    )
  try {
    const preferred = resolve(options.agentDir, "commandcode-accounts.json")
    for (const path of [
      preferred,
      resolve(options.homeDir ?? homedir(), ".commandcode", "accounts.json"),
    ]) {
      const bytes = bytesAt(path)
      if (bytes === undefined) continue
      const raw = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>
      const pool = parseAccountPool(raw, `file:${path}`)
      return {
        path,
        revision: revision(bytes),
        raw,
        draft: {
          accounts: pool.accounts.map(({ id, apiKey }) => ({ id, apiKey })),
          remainingCreditsThreshold: pool.remainingCreditsThreshold,
        },
      }
    }
    return {
      path: preferred,
      revision: missing,
      raw: {},
      draft: { accounts: [], remainingCreditsThreshold: 0.1 },
    }
  } catch {
    throw new Error(invalid)
  }
}
function documentFor(
  snapshot: AccountConfigSnapshot,
  draft: AccountConfigDraft,
): Record<string, unknown> {
  try {
    if (!Array.isArray(draft.accounts) || !draft.accounts.length) throw 0
    const ids = new Set<string>(),
      keys = new Set<string>()
    const accounts = draft.accounts.map((a) => {
      if (
        !a ||
        typeof a.id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(a.id) ||
        ids.has(a.id)
      )
        throw 0
      if (typeof a.apiKey !== "string" || !a.apiKey.trim() || /[\r\n\x00]/.test(a.apiKey)) throw 0
      const apiKey = a.apiKey.trim()
      if (keys.has(apiKey)) throw 0
      ids.add(a.id)
      keys.add(apiKey)
      return { id: a.id, apiKey }
    })
    if (
      typeof draft.remainingCreditsThreshold !== "number" ||
      !Number.isFinite(draft.remainingCreditsThreshold) ||
      draft.remainingCreditsThreshold < 0
    )
      throw 0
    const raw = snapshot.raw
    const next: Record<string, unknown> = {
      ...raw,
      accounts,
      policy: {
        ...(raw.policy as Record<string, unknown> | undefined),
        remainingCreditsThreshold: draft.remainingCreditsThreshold,
      },
    }
    delete next.activeIndex
    if (!accounts.some((a) => a.id === next.activeAccountId)) delete next.activeAccountId
    parseAccountPool(next, `file:${snapshot.path}`)
    return next
  } catch {
    throw new Error(invalid)
  }
}

export async function saveAccountConfig(
  snapshot: AccountConfigSnapshot,
  draft: AccountConfigDraft,
): Promise<void> {
  // Capture and validate before the first await; a mutable UI draft cannot change mid-save.
  const content = JSON.stringify(documentFor(snapshot, draft), null, 2) + "\n"
  const path = snapshot.path,
    expected = snapshot.revision
  const lock = path + ".edit.lock",
    temp = path + "." + randomUUID() + ".tmp"
  let owned = false,
    tempOwned = false
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const deadline = Date.now() + 2000
    while (!owned) {
      try {
        mkdirSync(lock, { mode: 0o700 })
        owned = true
      } catch (e: any) {
        if (e?.code !== "EEXIST" || Date.now() >= deadline) throw new Error(failed)
        await new Promise<void>((done) => setTimeout(done, 20))
      }
    }
    if (revision(bytesAt(path)) !== expected) throw new Error(conflict)
    const fd = openSync(temp, "wx", 0o600)
    tempOwned = true
    try {
      fchmodSync(fd, 0o600)
      writeFileSync(fd, content)
    } finally {
      closeSync(fd)
    }
    // Also detect non-cooperating writers during preparation of the atomic replacement.
    if (revision(bytesAt(path)) !== expected) throw new Error(conflict)
    renameSync(temp, path)
    tempOwned = false
  } catch (e) {
    throw new Error(e instanceof Error && e.message === conflict ? conflict : failed)
  } finally {
    if (tempOwned) {
      try {
        unlinkSync(temp)
      } catch {
        /* best-effort cleanup */
      }
    }
    if (owned) {
      try {
        rmdirSync(lock)
      } catch {
        /* never recursively remove a lock */
      }
    }
  }
}
