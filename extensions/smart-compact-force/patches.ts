/**
 * Canonical patch table + apply logic for pi-smart-compact's verification gate.
 *
 * pi-smart-compact is fail-closed by design: the post-synthesis / post-state
 * verification gates throw and block apply whenever the summary cannot be
 * verified losslessly (e.g. [missing-file, missing-error] gaps on very long
 * conversations). There is no built-in config to skip this.
 *
 * This module adds ONE opt-in switch, `allowUnverifiedApply`:
 *   - settings.json:  "smartCompact": { "allowUnverifiedApply": true }
 *   - env var:        SMART_COMPACT_FORCE_APPLY=1
 *
 * When enabled and verification STILL fails after all repair attempts
 * (deterministic repair → LLM patch → deterministic quality floor), the run
 * proceeds instead of throwing: the best available summary is kept, provenance
 * is marked `forced`, a warning is shown, and the normal approval screen
 * (`requireApproval`) still gates the actual apply.
 *
 * NOT touched: the yield check (target / >=10% saving still fail closed), CLI
 * parsing, extraction, or repair logic.
 *
 * Verified against pi-smart-compact v9.2.1 (dist/index.js, bundled single file).
 * All files are pure logic — no pi imports, so the same table is shared by the
 * auto-ensuring extension and the standalone CLI script.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PatchDef {
  name: string;
  /** Text as found in the ORIGINAL (unpatched) dist/index.js */
  find: string;
  /** Text as found after the patch is applied */
  replace: string;
}

export const PATCHES: PatchDef[] = [
  // 1) New config key in DEFAULT_CONFIG
  {
    name: "default-config",
    find: String.raw`  adaptiveDamageFeedback: false,
  onlineDamageMonitor: true,
  pinPaths: []`,
    replace: String.raw`  adaptiveDamageFeedback: false,
  onlineDamageMonitor: true,
  allowUnverifiedApply: false,
  pinPaths: []`,
  },
  // 2) Validate it as a boolean
  {
    name: "config-validation",
    find: String.raw`["requireApproval", "scrubSecrets", "scrubPii", "focusWeighting", "zeroCallEnabled", "contextGraphEnabled", "adaptiveDamageFeedback", "onlineDamageMonitor"]) {`,
    replace: String.raw`["requireApproval", "scrubSecrets", "scrubPii", "focusWeighting", "zeroCallEnabled", "contextGraphEnabled", "adaptiveDamageFeedback", "onlineDamageMonitor", "allowUnverifiedApply"]) {`,
  },
  // 3) Wire config + env into run flags
  {
    name: "makebase-flags",
    find: String.raw`      force: !!opts.force,
      overflowRecovery: !!opts.overflowRecovery
    },`,
    replace: String.raw`      force: !!opts.force,
      forceApply: !!opts.config?.allowUnverifiedApply || /^(?:1|true)$/i.test(process.env.SMART_COMPACT_FORCE_APPLY ?? ""),
      overflowRecovery: !!opts.overflowRecovery
    },`,
  },
  // 4) post-synthesis gate: skip the throw when forceApply is on
  {
    name: "verify-gate-post-synthesis",
    find: String.raw`  const failure = verificationFailureMessage(verification);
  if (failure)
    throw new VerificationGateError(verification, initialScore, "post-synthesis");
  showProgressOverlay(rc.ctx, {
    phase: 4,
    phaseName: "Verify",
    detail: "Passed " + verification.score + "/100 \xB7 0 unresolved gaps",
    explorationRounds: rc.explorationRounds
  });`,
    replace: String.raw`  const failure = verificationFailureMessage(verification);
  if (failure) {
    if (rc.flags.forceApply) {
      rc.flags.verificationForced = true;
      rc.notify("Force apply: " + verification.gaps.length + " unresolved verification gap(s) accepted at " + verification.score + "/100", "warning");
    } else {
      throw new VerificationGateError(verification, initialScore, "post-synthesis");
    }
  }
  showProgressOverlay(rc.ctx, {
    phase: 4,
    phaseName: "Verify",
    detail: rc.flags.verificationForced ? "Forced at " + verification.score + "/100 \xB7 " + verification.gaps.length + " unresolved gap(s) accepted" : "Passed " + verification.score + "/100 \xB7 0 unresolved gaps",
    explorationRounds: rc.explorationRounds
  });`,
  },
  // 5) post-state gate: skip the throw when forceApply is on
  {
    name: "verify-gate-post-state",
    find: String.raw`  const failure = verificationFailureMessage(postVerification);
  if (failure)
    throw new VerificationGateError(postVerification, postInitialScore, "post-state");`,
    replace: String.raw`  const failure = verificationFailureMessage(postVerification);
  if (failure) {
    if (rc.flags.forceApply) {
      rc.flags.verificationForced = true;
      rc.notify("Force apply: " + postVerification.gaps.length + " unresolved post-state verification gap(s) accepted at " + postVerification.score + "/100", "warning");
    } else {
      throw new VerificationGateError(postVerification, postInitialScore, "post-state");
    }
  }`,
  },
  // 6) Mark provenance so metrics/dashboard show the run was forced
  {
    name: "provenance-forced",
    find: String.raw`    deterministicPatched: [...rc.verificationProvenance.deterministicPatched, ...postRepair.patched],
    finalScore: postVerification.score,
    remainingGaps: postVerification.gaps
  };`,
    replace: String.raw`    deterministicPatched: [...rc.verificationProvenance.deterministicPatched, ...postRepair.patched],
    forced: rc.flags.verificationForced === true || undefined,
    finalScore: postVerification.score,
    remainingGaps: postVerification.gaps
  };`,
  },
];

export interface PatchResult {
  /** Names of patches whose text was actually changed (meaningful only when failed is empty) */
  applied: string[];
  /** Number of patches already in the desired state (no change needed) */
  already: number;
  /** Names of patches whose anchor could not be found (version drift) */
  failed: string[];
}

export type PatchStatus = "patched" | "unpatched" | "partial";

/** Locate the bundled pi-smart-compact entry. Honors SMART_COMPACT_PATCH_TARGET override. */
export function locateSmartCompactIndex(): string | null {
  const override = process.env.SMART_COMPACT_PATCH_TARGET;
  if (override && fs.existsSync(override)) return override;
  const home = os.homedir();
  const candidates = [
    path.join(home, ".pi", "agent", "npm", "node_modules", "pi-smart-compact", "dist", "index.js"),
    path.join(home, ".pi", "agent", "node_modules", "pi-smart-compact", "dist", "index.js"),
    path.join(home, ".pi", "node_modules", "pi-smart-compact", "dist", "index.js"),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * Apply (or revert) the patch table. Atomic: writes the file only when every
 * patch matched; on any anchor mismatch nothing is written and the failed
 * names are reported so a pi-smart-compact update can be detected.
 */
export function applyPatches(file: string, revert = false): PatchResult {
  let source = fs.readFileSync(file, "utf-8");
  const crlf = source.includes("\r\n");
  if (crlf) source = source.replace(/\r\n/g, "\n");
  const applied: string[] = [];
  const failed: string[] = [];
  let already = 0;
  for (const { name, find, replace } of PATCHES) {
    const from = revert ? replace : find;
    const to = revert ? find : replace;
    if (source.includes(to)) {
      already++;
      continue;
    }
    if (!source.includes(from)) {
      failed.push(name);
      continue;
    }
    source = source.split(from).join(to);
    applied.push(name);
  }
  if (failed.length === 0) {
    fs.writeFileSync(file, crlf ? source.replace(/\n/g, "\r\n") : source, "utf-8");
  }
  return { applied, already, failed };
}

export function patchStatus(file: string): PatchStatus {
  const source = fs.readFileSync(file, "utf-8");
  let patched = 0;
  let pristine = 0;
  for (const { find, replace } of PATCHES) {
    if (source.includes(replace)) patched++;
    else if (source.includes(find)) pristine++;
  }
  if (patched === PATCHES.length) return "patched";
  if (pristine === PATCHES.length) return "unpatched";
  return "partial";
}
