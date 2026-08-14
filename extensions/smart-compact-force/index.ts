/**
 * smart-compact-force — force pi-smart-compact past its verification gate
 *
 * pi-smart-compact is fail-closed: the post-synthesis / post-state gates throw
 * and block apply whenever the summary cannot be verified losslessly (e.g.
 * [missing-file, missing-error] gaps on very long conversations). There is no
 * built-in config to skip that.
 *
 * This extension ships the minimal patch (6 surgical replacements in
 * pi-smart-compact's bundled dist/index.js, canonical table in ./patches.ts)
 * and:
 *   1. Ensures the patch is applied on every pi start (idempotent; the file is
 *      patched before pi-smart-compact is imported in later sessions).
 *   2. Registers `/smart-compact-force [status|apply|revert]`.
 *
 * Enable the bypass via any of:
 *   - settings.json:  "smartCompact": { "allowUnverifiedApply": true }
 *   - env var:        SMART_COMPACT_FORCE_APPLY=1
 *
 * When enabled and verification STILL fails after all repair attempts, the run
 * proceeds: best summary kept, provenance marked `forced`, warning shown, and
 * the normal approval screen (requireApproval) still gates the actual apply.
 * The yield check (target / >=10% saving) is untouched and still fail-closed.
 *
 * Standalone CLI (same patch table, runnable with node >= 23.6 or bun):
 *   node scripts/smart-compact-force-patch.ts [status|apply|revert]
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyPatches, locateSmartCompactIndex, patchStatus, type PatchResult } from "./patches.js";

interface LoadOutcome {
  file: string | null;
  result: PatchResult | null;
}

function packageVersionOf(distIndex: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(distIndex), "..", "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "?";
  } catch {
    return "?";
  }
}

export default function (pi: ExtensionAPI): void {
  // 1) Ensure the patch at load time (sync + idempotent). If pi-smart-compact
  //    was already imported by this process the change applies from the next
  //    session on — `/smart-compact-force status` tells the truth either way.
  const loadOutcome: LoadOutcome = { file: null, result: null };
  const file = locateSmartCompactIndex();
  if (file) {
    try {
      loadOutcome.file = file;
      loadOutcome.result = applyPatches(file);
    } catch (err) {
      console.error("[smart-compact-force] load-time patch failed:", err);
    }
  }

  // Report a fresh patch / drift once per boot.
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (!loadOutcome.file || !loadOutcome.result) return;
    const { result } = loadOutcome;
    if (result.applied.length > 0) {
      ctx.ui.notify(`Smart Compact force-apply: ${result.applied.length} patch(es) applied`, "info");
    } else if (result.failed.length > 0) {
      ctx.ui.notify(`Smart Compact force-apply: anchor mismatch (${result.failed.join(", ")}) — pi-smart-compact may have been updated`, "warning");
    }
  });

  // 2) Manual control.
  pi.registerCommand("smart-compact-force", {
    description: "pi-smart-compact force-apply: status / apply / revert (usage: /smart-compact-force [status|apply|revert])",
    handler: async (args: string, ctx: ExtensionContext) => {
      const action = (args.trim() || "status").toLowerCase();
      const target = locateSmartCompactIndex();
      if (!target) {
        ctx.ui.notify("pi-smart-compact not found — nothing to patch (searched ~/.pi/agent/{npm/,}node_modules)", "warning");
        return;
      }
      if (action === "status") {
        const status = patchStatus(target);
        const kind = status === "patched" ? "info" : "warning";
        const label =
          status === "patched" ? "force-apply patch ACTIVE" : status === "unpatched" ? "NOT patched (fail-closed)" : "PARTIALLY patched (version drift)";
        ctx.ui.notify(`pi-smart-compact v${packageVersionOf(target)}: ${label} — ${status}`, kind);
      } else if (action === "apply" || action === "revert") {
        const result = applyPatches(target, action === "revert");
        if (result.failed.length > 0) {
          ctx.ui.notify(`smart-compact-force ${action}: ${result.failed.length} anchor(s) mismatch (${result.failed.join(", ")}) — file left unchanged`, "error");
        } else {
          ctx.ui.notify(`smart-compact-force ${action}: ${result.applied.length} changed, ${result.already} already in desired state`, "info");
        }
      } else {
        ctx.ui.notify("Usage: /smart-compact-force [status|apply|revert]", "warning");
      }
    },
  });
}
