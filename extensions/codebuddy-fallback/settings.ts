/**
 * CodeBuddy → DeepSeek 官方备用模型的持久化设置。
 *
 * 持久化位置：`<agent-dir>/settings.json` 的 `codebuddyFallback` 键
 * （与 codebuddy-fp / web-search 同一套写法：临时文件 + rename 原子写）。
 *
 * - `true`（默认）— 开启：codebuddy 的 DeepSeek V4.1 Flash 出现任何不可用
 *   （429 / 配额 / 5xx / 网络 / 模型下架 …）时，本轮立刻改用 DeepSeek 官方的
 *   `deepseek-flash` 重发，并在后台每 5 分钟探测一次 codebuddy，恢复后自动切回。
 * - `false` — 关闭：不拦截任何错误，行为与没装本扩展时完全一致。
 *
 * 每次读取都重新读文件，因此 `/codebuddy-fallback` 切换后无需重启即时生效。
 * 环境变量 `CODEBUDDY_FALLBACK`（on|off）优先于设置文件。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SETTINGS_KEY = "codebuddyFallback";

function settingsPath(): string {
  try {
    return join(getAgentDir(), "settings.json");
  } catch {
    return join(homedir(), ".pi", "agent", "settings.json");
  }
}

function readSettings(): Record<string, unknown> {
  try {
    const file = settingsPath();
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  } catch {
    // 不可读 / 非法 JSON → 落到默认值
  }
  return {};
}

function normalize(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "on" || v === "true" || v === "1" || v === "enable" || v === "enabled") return true;
  if (v === "off" || v === "false" || v === "0" || v === "disable" || v === "disabled") return false;
  return undefined;
}

/** 当前是否开启自动 fallback；默认开启。 */
export function getCodebuddyFallbackEnabled(): boolean {
  const fromEnv = normalize(process.env.CODEBUDDY_FALLBACK);
  if (fromEnv !== undefined) return fromEnv;
  return normalize(readSettings()[SETTINGS_KEY]) ?? true;
}

/** 持久化开关（原子写，避免半截 JSON 覆盖用户设置）。 */
export function setCodebuddyFallbackEnabled(enabled: boolean): void {
  const file = settingsPath();
  const dir = dirname(file);
  const settings = readSettings();
  settings[SETTINGS_KEY] = enabled;
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.settings.json.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, file);
}

/** 环境变量是否覆盖了设置文件（用于状态提示）。 */
export function isFallbackEnvForced(): boolean {
  return normalize(process.env.CODEBUDDY_FALLBACK) !== undefined;
}
