/**
 * Shared web_search backend flag.
 *
 * Single source of truth for which backend serves the `web_search` tool:
 * Google (Antigravity grounding) or Z.AI Web Search Prime. The web-search
 * extension reads this flag at tool EXECUTE time (not registration time), so
 * `/antigravity.search 1|0` takes effect immediately — no pi restart.
 *
 * Precedence: env PI_ANTIGRAVITY_GOOGLE_SEARCH=1|0 > settings.json
 * `antigravityGoogleSearch` (default: on).
 *
 * This module is intentionally stateless (pure settings I/O): each extension
 * instance gets its own copy under jiti's moduleCache:false, which is fine.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const SETTINGS_KEY = "antigravityGoogleSearch";

function readSettings(): Record<string, unknown> {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
    }
  } catch {
    // unreadable settings — fall back to defaults
  }
  return {};
}

export function getGoogleSearchEnabled(): boolean {
  const env = process.env.PI_ANTIGRAVITY_GOOGLE_SEARCH;
  if (env === "1") return true;
  if (env === "0") return false;
  const value = readSettings()[SETTINGS_KEY];
  return value !== false && value !== 0; // default: on
}

export function setGoogleSearchEnabled(enabled: boolean): void {
  const settings = readSettings();
  settings[SETTINGS_KEY] = enabled;
  const dir = join(homedir(), ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  // Atomic write: tmp file + rename so a concurrent pi settings save can never
  // observe a half-written file.
  const tmp = join(dir, `.settings.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, SETTINGS_PATH);
}
