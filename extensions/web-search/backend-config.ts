/**
 * Shared web_search backend setting.
 *
 * Persisted backend selection:
 * - "google": Google via Antigravity Grounding
 * - "openai": OpenAI via Codex Responses API
 * - "deepseek": DeepSeek native search via Anthropic-compatible API
 * - "minimax": MiniMax Coding Plan search API
 * - "zai": 智谱 BigModel / Z.AI Web Search Prime
 *
 * Each backend defines its own native, truthful tool schema and prompt.
 * Changes take effect on next session start or /reload.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type WebSearchBackend = "google" | "openai" | "deepseek" | "minimax" | "zai";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const SETTINGS_KEY = "webSearchBackend";
const LEGACY_KEY = "antigravityGoogleSearch";

function readSettings(): Record<string, unknown> {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
    }
  } catch {
    // unreadable settings
  }
  return {};
}

export function getWebSearchBackend(): WebSearchBackend {
  const env = process.env.PI_WEB_SEARCH_BACKEND?.trim().toLowerCase();
  if (
    env === "google" ||
    env === "openai" ||
    env === "deepseek" ||
    env === "minimax" ||
    env === "zai"
  ) {
    return env as WebSearchBackend;
  }

  const settings = readSettings();
  const val = settings[SETTINGS_KEY];
  if (
    val === "google" ||
    val === "openai" ||
    val === "deepseek" ||
    val === "minimax" ||
    val === "zai"
  ) {
    return val as WebSearchBackend;
  }

  // Legacy fallback: true -> google, false -> zai
  if (settings[LEGACY_KEY] === false) return "zai";

  // Default is Google
  return "google";
}

export function setWebSearchBackend(backend: WebSearchBackend): void {
  const settings = readSettings();
  settings[SETTINGS_KEY] = backend;
  settings[LEGACY_KEY] = backend !== "zai";

  const dir = join(homedir(), ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.settings.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, SETTINGS_PATH);
}
