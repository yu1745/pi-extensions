/**
 * Lightweight diagnostic log for the web-tool coordination changes.
 * Appends to /tmp/pi-web-tools.log — both this fork and the (user-owned)
 * pi-extensions web-search write here with distinct tags so a single file
 * shows the full registration/coordination picture per pi process.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LOG_PATH = "/tmp/pi-web-tools.log";

export function weblog(message: string): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    const ts = new Date().toISOString();
    appendFileSync(LOG_PATH, `${ts} [antigravity-fork] ${message}\n`);
  } catch {
    // logging must never break the tool
  }
}
