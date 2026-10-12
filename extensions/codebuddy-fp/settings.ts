/**
 * CodeBuddy 出网伪装级别的持久化设置。
 *
 * 持久化位置：`<agent-dir>/settings.json` 的 `codebuddyFingerprint` 键
 * （与 web-search 的 `webSearchBackend` 同一套写法：临时文件 + rename 原子写）。
 *
 * - `"full"` — 最高伪装级别：首轮请求把 system 提示词与 tools 都换成官方 CLI
 *   抓包基线的那一份，首条消息与官方 CLI 完全一致。
 * - `"off"`  — 默认值。完全不替换：模型只会看到 pi 的一份提示词与一份工具，
 *   也不存在"首轮官方、次轮 pi"的双份历史。
 *
 * 每次读取都重新读文件，因此 `/codebuddy-fp` 切换后无需重启即时生效。
 * 环境变量 `CODEBUDDY_FINGERPRINT`（full|on|off）优先于设置文件。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type CodebuddyFingerprint = "full" | "off";

const SETTINGS_KEY = "codebuddyFingerprint";

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

function normalize(value: unknown): CodebuddyFingerprint | undefined {
  if (value === "full" || value === "on") return "full";
  if (value === "off") return "off";
  return undefined;
}

/** 当前伪装级别；默认 "off"（不伪装）。 */
export function getCodebuddyFingerprint(): CodebuddyFingerprint {
  const fromEnv = normalize(process.env.CODEBUDDY_FINGERPRINT?.trim().toLowerCase());
  if (fromEnv) return fromEnv;
  return normalize(readSettings()[SETTINGS_KEY]) ?? "off";
}

/** 持久化伪装级别（原子写，避免半截 JSON 覆盖用户设置）。 */
export function setCodebuddyFingerprint(mode: CodebuddyFingerprint): void {
  const file = settingsPath();
  const dir = dirname(file);
  const settings = readSettings();
  settings[SETTINGS_KEY] = mode;
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.settings.json.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, file);
}

/** 环境变量是否覆盖了设置文件（用于状态提示）。 */
export function isFingerprintEnvForced(): boolean {
  return normalize(process.env.CODEBUDDY_FINGERPRINT?.trim().toLowerCase()) !== undefined;
}
