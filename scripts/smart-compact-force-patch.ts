#!/usr/bin/env node
/**
 * smart-compact-force-patch — standalone CLI for the pi-smart-compact
 * force-apply patch (canonical table lives in
 * extensions/smart-compact-force/patches.ts, shared with the extension).
 *
 * Usage:
 *   node scripts/smart-compact-force-patch.ts [status|apply|revert] [target]
 *
 *   status  (default) print whether the patch is active
 *   apply   ensure the patch is applied (idempotent)
 *   revert  remove the patch
 *   target  optional explicit path to pi-smart-compact's dist/index.js
 *           (default: auto-located under ~/.pi/agent{,/npm}/node_modules,
 *           or $SMART_COMPACT_PATCH_TARGET)
 *
 * Requires node >= 23.6 (native type stripping) or bun.
 * Run again after `npm update`/reinstall of pi-smart-compact.
 */

import fs from "node:fs";
import path from "node:path";
import { applyPatches, locateSmartCompactIndex, patchStatus } from "../extensions/smart-compact-force/patches.ts";

function packageVersionOf(distIndex: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(distIndex), "..", "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "?";
  } catch {
    return "?";
  }
}

const args = process.argv.slice(2);
const action = (args[0] ?? "status").toLowerCase();
const target = args[1] ?? locateSmartCompactIndex();

if (!target) {
  console.error("pi-smart-compact not found (searched ~/.pi/agent/{npm/,}node_modules, $SMART_COMPACT_PATCH_TARGET)");
  process.exit(1);
}

if (action === "status") {
  const status = patchStatus(target);
  console.log(`pi-smart-compact v${packageVersionOf(target)}: ${status}`);
  process.exit(status === "patched" ? 0 : 1);
}

if (action === "apply" || action === "revert") {
  const result = applyPatches(target, action === "revert");
  if (result.failed.length > 0) {
    console.error(`${action}: ${result.failed.length} anchor(s) mismatch (${result.failed.join(", ")}) — file left unchanged; pi-smart-compact may have been updated`);
    process.exit(1);
  }
  console.log(`${action}: ${result.applied.length} changed, ${result.already} already in desired state → ${target}`);
  process.exit(0);
}

console.error("usage: node scripts/smart-compact-force-patch.ts [status|apply|revert] [target]");
process.exit(2);
