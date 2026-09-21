/**
 * pi extension: web_reader — Full-featured web reader backed by Playwright & Jev
 * -------------------------
 * A SPA-aware, anti-WAF web reader backed by the Playwright library.
 *
 * It drives a REAL browser (prefers your installed Chrome/Edge so the fingerprint
 * is genuine) and extracts content from Playwright's **ARIA accessibility snapshot** — the
 * exact same data source `playwright-cli` uses for its snapshots. Using the accessibility
 * tree means hidden/hover-only UI (menus, "not interested" buttons, aria-hidden clutter)
 * is naturally excluded, so the output is clean.
 *
 * Cloudflare challenges ("Just a moment" / 安全验证 / Turnstile) are handled by a dedicated
 * branch in ./cloudflare.ts, which uses Jev to decide both whether the page really is a
 * challenge and which element to click, then clicks it with a human-like mouse path.
 *
 * Config (env vars):
 *   PI_WEBREADER_UA       Override User-Agent. UNSET by default — spoofing one that
 *                         contradicts the real platform is itself a bot signal.
 *   PI_WEBREADER_STEALTH  "1" to inject stealth patches. Off by default for the same
 *                         reason: overriding native navigator values is inconsistent.
 *   PI_WEBREADER_CF       "off" to disable the Cloudflare challenge branch.
 *   PI_WEBREADER_CF_ROUNDS     Max click/verify rounds (default 8).
 *   PI_WEBREADER_CF_TIMEOUT_MS Challenge branch deadline (default 40000).
 *   PI_WEBREADER_LOCALE   Locale / Accept-Language base (default: zh-CN).
 *   PI_WEBREADER_HEADED   "1" to show the browser window (headed is the default).
 *   PI_WEBREADER_HEADLESS "1" to force headless (challenges will usually fail).
 *   PI_WEBREADER_NO_XVFB  "1" to never auto-start Xvfb for headed mode.
 *   PI_WEBREADER_CDP      Connect to an external browser over CDP instead of launching
 *                         the bundled Chromium, e.g. "http://localhost:9222".
 *   PI_WEBREADER_MAXURL  Max URL length kept in markdown output (default: 120;
 *                         longer URLs — typically ad/tracking — are dropped).
 *   PI_WEBREADER_DEBUG    "1" to print debug logs to stderr.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { resolveJevService } from "../shared/jev/service.ts";
import { fileURLToPath } from "node:url";
import {
  chooseScopeCandidate,
  decideAriaScope,
  type ScopeCandidate,
  type ScopeDecision,
} from "./selection.js";
import { handleCloudflareChallenge, type CfOutcome } from "./cloudflare.js";

const DEBUG = /^(1|true|yes)$/i.test(process.env.PI_WEBREADER_DEBUG || "");
function log(...a: unknown[]) {
  if (DEBUG) console.error("[web-reader]", ...a);
}

// ---- environment-driven config -------------------------------------------
// NOTE: we deliberately do NOT spoof a User-Agent by default. Spoofing while the real
// browser reports a different platform (e.g. claiming Windows on a Linux Chrome) creates a
// self-contradictory fingerprint that Cloudflare's challenge rejects outright — verified
// empirically: spoofing alone turns a passing challenge into a failing one. Use
// PI_WEBREADER_UA only if you genuinely run a browser matching that UA.
const UA = process.env.PI_WEBREADER_UA?.trim() || "";
const LOCALE = process.env.PI_WEBREADER_LOCALE || "zh-CN";
// Headed by default: Cloudflare's stronger challenges reject headless browsers. In a
// headless environment ensureBrowser() starts an Xvfb so "headed" still works.
// Set PI_WEBREADER_HEADLESS=1 to force headless (or PI_WEBREADER_HEADED=0).
const HEADLESS_ENV = process.env.PI_WEBREADER_HEADLESS;
const HEADED =
  HEADLESS_ENV !== undefined
    ? !/^(1|true|yes)$/i.test(HEADLESS_ENV)
    : !/^(0|false|no)$/i.test(process.env.PI_WEBREADER_HEADED || "");
const CDP = process.env.PI_WEBREADER_CDP?.trim() || "";
const MAX_URL = parseInt(process.env.PI_WEBREADER_MAXURL || "120", 10);
// Resolve the extension's own directory (works for both local dev installs and
// `pi install` git/npm packages, which land under different paths).
const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.join(tmpdir(), "pi-web-reader");

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process,AutomationControlled",
  "--disable-infobars",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
];

// Playwright's BUNDLED Chromium only. We deliberately do not fall back to a system
// chrome/msedge: the plugin must work on a machine that has nothing but its own
// dependencies installed.
//
// Version pinning is load-bearing, not cosmetic. Cloudflare rejects Chromium builds that
// are newer than the current stable channel (Playwright ships dev-channel "Chrome for
// Testing"). Measured on a live Turnstile challenge, 3/3 passes each:
//   chromium-1219 (147) / 1223 (148) / 1228 (149)  -> PASS
//   chromium-1234 (151) / 1243 (153)               -> FAIL 0/3
// `playwright` is therefore pinned to 1.61.0, which bundles revision 1228.
const PLAYWRIGHT_PIN_NOTE =
  "playwright is pinned to 1.61.0 (chromium 1228) because newer bundled Chromium " +
  "revisions are rejected by Cloudflare challenges";

// ---- browser lifecycle ----------------------------------------------------
interface AnyBrowser {
  newContext(opts?: unknown): Promise<AnyContext>;
  close(): Promise<void>;
  contexts(): AnyContext[];
}
interface AnyContext {
  newPage(): Promise<AnyPage>;
  close(): Promise<void>;
  addInitScript(fn: unknown): Promise<void>;
  newCDPSession?(page: unknown): Promise<{ send(method: string, params?: unknown): Promise<unknown> }>;
}
interface AnyPage {
  goto(url: string, opts?: unknown): Promise<{ status(): number; headers?(): Record<string, string> } | null>;
  waitForLoadState(state: string, opts?: unknown): Promise<void>;
  waitForSelector(sel: string, opts?: unknown): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  ariaSnapshot(opts?: unknown): Promise<string>;
  content(): Promise<string>;
  screenshot(opts?: unknown): Promise<Buffer>;
  evaluate<T, A = void>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  url(): string;
  title(): Promise<string>;
  mouse?: {
    move(x: number, y: number, opts?: { steps?: number }): Promise<void>;
    down(): Promise<void>;
    up(): Promise<void>;
  };
  locator(sel: string): {
    first(): { ariaSnapshot(opts?: unknown): Promise<string> };
    nth(index: number): { ariaSnapshot(opts?: unknown): Promise<string> };
  };
  close(): Promise<void>;
}

let browser: AnyBrowser | null = null;
let context: AnyContext | null = null;
let activeChannel = "";
let viaCdp = false;
let opening: Promise<void> | null = null;
// Token for the launch that `opening` currently refers to (see ensureBrowser).
let openingToken: object | null = null;
// Bumped by closeBrowser(). A browser launch that was already in flight when a
// session shut down must not publish its handles afterwards, or the process
// would be orphaned with no reference left to close it.
let generation = 0;
let autoInstallTriggered = false;

// ---------------------------------------------------------------------------
// Virtual display
// ---------------------------------------------------------------------------
// Cloudflare's stronger challenges only pass for a HEADED browser: a headless
// Chromium advertises `HeadlessChrome` in its UA and exposes no WebGL, and both
// are trivially detectable. Verified empirically on a live Turnstile challenge:
// every headless variant failed, while headed msedge passed on the first click.
// On a machine without a real X server we therefore start our own Xvfb and point
// the browser at it, so "headed" works in a headless environment.
let xvfbProc: { pid?: number; kill(): void } | null = null;
let virtualDisplay: string | null = null;

function displayWorks(display: string): boolean {
  try {
    // An X socket must exist for the display, e.g. ":99" or "localhost:99" -> /tmp/.X11-unix/X99.
    const m = /:(\d+)/.exec(display);
    if (!m) return false;
    return existsSync(`/tmp/.X11-unix/X${m[1]}`);
  } catch {
    return false;
  }
}

/** Ensure some usable X display exists for a headed browser; start Xvfb if needed. */
async function ensureDisplay(): Promise<void> {
  if (process.env.PI_WEBREADER_NO_XVFB === "1") return;
  // An explicitly working DISPLAY (including a forwarded one) wins.
  if (process.env.DISPLAY && displayWorks(process.env.DISPLAY)) return;

  if (virtualDisplay) {
    process.env.DISPLAY = virtualDisplay;
    return;
  }

  // Pick a free display number.
  for (let n = 90; n < 130; n++) {
    if (existsSync(`/tmp/.X11-unix/X${n}`)) continue;
    const display = `:${n}`;
    try {
      const child = spawn("Xvfb", [display, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"], {
        stdio: "ignore",
        detached: false,
      });
      child.unref?.();
      // Wait briefly for the socket to appear.
      for (let i = 0; i < 40; i++) {
        if (existsSync(`/tmp/.X11-unix/X${n}`)) {
          xvfbProc = child as unknown as { pid?: number; kill(): void };
          virtualDisplay = display;
          process.env.DISPLAY = display;
          log("started Xvfb on", display, "(pid:", child.pid, ")");
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    } catch (e) {
      log("Xvfb launch failed:", (e as Error).message);
      return;
    }
  }
  log("could not obtain an X display; headed browser will likely fail");
}

function stopDisplay() {
  if (!xvfbProc) return;
  try {
    xvfbProc.kill();
  } catch {
    /* ignore */
  }
  xvfbProc = null;
  virtualDisplay = null;
}

function triggerBackgroundChromiumInstall() {
  if (autoInstallTriggered) return;
  autoInstallTriggered = true;
  try {
    let cliPath = path.resolve(EXT_DIR, "node_modules/playwright/cli.js");
    if (!require("node:fs").existsSync(cliPath)) {
      cliPath = path.resolve(EXT_DIR, "../../node_modules/playwright/cli.js");
    }
    const child = spawn(process.execPath, [cliPath, "install", "chromium", "chromium-headless-shell"], {
      cwd: EXT_DIR,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    log("triggered background Playwright Chromium installation (pid:", child.pid, ")");
  } catch (err) {
    log("failed to trigger background chromium install:", (err as Error).message);
  }
}

function contextOpts() {
  return {
    // Only override the UA when the user explicitly asked for one; otherwise keep the
    // browser's native (self-consistent) user agent.
    ...(UA ? { userAgent: UA } : {}),
    locale: LOCALE,
    viewport: { width: 1920, height: 1080 },
    javaScriptEnabled: true,
    extraHTTPHeaders: { "Accept-Language": `${LOCALE},${LOCALE.split("-")[0]};q=0.9,en;q=0.8` },
  };
}

async function ensureBrowser(): Promise<AnyContext> {
  if (context) return context;
  if (opening) {
    await opening;
    if (context) return context;
  }
  const myGeneration = generation;
  // Unique token identifying this launch, so the finally block can tell whether
  // `opening` still refers to us and avoid clobbering a newer launch.
  const token = { generation: myGeneration };
  let started: Promise<void>;
  started = (async () => {
    // Launch into locals and publish only at the end: if session_shutdown runs
    // while we are starting up, the half-built browser is closed here instead of
    // being written into the module-level handles.
    let launched: AnyBrowser | null = null;
    let launchedContext: AnyContext | null = null;
    let channel = "";
    let isCdp = false;
    try {
      let chromium: any;
      try {
        ({ chromium } = await import("playwright"));
      } catch {
        throw new Error(
          "Playwright is not installed. Run `npm install` inside " +
            "~/.pi/agent/extensions/web-reader-spa (and `npx playwright install chromium` if needed).",
        );
      }

      if (CDP) {
        log("connecting over CDP:", CDP);
        launched = (await chromium.connectOverCDP(CDP)) as AnyBrowser;
        isCdp = true;
        channel = "cdp";
        launchedContext = launched.contexts()[0] || (await launched.newContext(contextOpts()));
      } else {
        // A headed browser needs an X display; start Xvfb if the machine has none.
        if (HEADED) await ensureDisplay();
        try {
          log("launching bundled chromium, headless:", !HEADED);
          launched = (await chromium.launch({
            headless: !HEADED,
            args: LAUNCH_ARGS,
          })) as AnyBrowser;
          channel = "chromium";
        } catch (e) {
          const msg = (e as Error).message || String(e);
          if (/Executable doesn't exist|browserType\.launch.*chromium|browser was not found|Looks like Playwright was installed/i.test(msg)) {
            triggerBackgroundChromiumInstall();
            throw new Error(
              "The bundled Chromium is not installed. Run:\n" +
                `  cd ${EXT_DIR} && npx playwright install chromium\n` +
                `(note: ${PLAYWRIGHT_PIN_NOTE})\n\nOriginal error: ${msg}`,
            );
          }
          throw e;
        }
        launchedContext = await launched.newContext(contextOpts());
      }

      // No stealth patches by default: overriding navigator.plugins / languages / WebGL
      // on a real browser makes the fingerprint internally inconsistent, which is itself
      // a strong bot signal (and measurably breaks the Cloudflare challenge). Set
      // PI_WEBREADER_STEALTH=1 to opt back in for cases that need it.
      if (/^(1|true|yes)$/i.test(process.env.PI_WEBREADER_STEALTH || "")) {
        await launchedContext!.addInitScript(stealth);
      }

      if (myGeneration !== generation) {
        // The session that asked for this browser is gone; close it rather than
        // leaking an unreferenced Chromium process.
        await launched.close().catch(() => {});
        return;
      }

      browser = launched;
      context = launchedContext;
      activeChannel = channel;
      viaCdp = isCdp;
      log("ready. channel:", activeChannel, "cdp:", viaCdp);
    } finally {
      // Only clear our own marker: closeBrowser() may have replaced it with a
      // newer launch's promise, which must stay awaitable by other callers.
      if (openingToken === token) {
        opening = null;
        openingToken = null;
      }
    }
  })();
  opening = started;
  openingToken = token;
  await started;
  if (!context) throw new Error("Failed to start browser");
  return context;
}

async function closeBrowser() {
  // Invalidate any in-flight launch BEFORE awaiting it: the starter sees the
  // generation change and closes its own browser instead of publishing it.
  generation += 1;
  const b = browser;
  const inFlight = opening;
  context = null;
  browser = null;
  activeChannel = "";
  viaCdp = false;
  opening = null;
  openingToken = null;
  if (inFlight) {
    try {
      await inFlight;
    } catch {
      /* the launch failed; nothing to close */
    }
  }
  if (b) {
    try {
      await b.close();
    } catch {
      /* ignore */
    }
  }
  stopDisplay();
}

// ---- per-fetch logic ------------------------------------------------------
interface FetchParams {
  url: string;
  format: "markdown" | "text" | "aria" | "html";
  selector?: string;
  autoSelector?: boolean;
  waitUntil: "load" | "domcontentloaded" | "networkidle";
  waitSelector?: string;
  extraWaitMs?: number;
  timeoutMs?: number;
  screenshot?: boolean;
  fullPage?: boolean;
  inlineImage?: boolean;
}

async function waitForReadableContentFallback(page: AnyPage, signal?: AbortSignal) {
  let previous = -1;
  let stableSamples = 0;
  const deadline = Date.now() + 8000;

  while (Date.now() < deadline && !signal?.aborted) {
    const state = await page.evaluate(() => {
      const mainElements = [
        ...document.querySelectorAll<HTMLElement>("main, [role=\"main\"], #main-content"),
      ];
      const mainText = mainElements.reduce(
        (max, element) => Math.max(max, (element.innerText || "").trim().length),
        0,
      );
      return {
        hasMain: mainElements.length > 0,
        mainText,
        bodyText: (document.body?.innerText || "").trim().length,
      };
    }).catch(() => ({ hasMain: false, mainText: 0, bodyText: 0 }));

    const readable = state.hasMain ? state.mainText > 200 : state.bodyText > 500;
    const current = state.hasMain ? state.mainText : state.bodyText;
    const tolerance = Math.max(30, Math.round(Math.max(previous, 0) * 0.02));
    stableSamples = readable && previous >= 0 && Math.abs(current - previous) <= tolerance
      ? stableSamples + 1
      : 0;
    if (stableSamples >= 2) return;

    previous = current;
    await page.waitForTimeout(350).catch(() => {});
  }
}

async function waitForReadableContent(page: AnyPage, url: string, signal?: AbortSignal): Promise<{ jevScore?: number; fallback?: boolean }> {
  const jev = resolveJevService();
  if (!jev) {
    await waitForReadableContentFallback(page, signal);
    return { fallback: true };
  }

  // Jev semantic recognition loop
  const deadline = Date.now() + 8000;
  let consecutiveHighConfidence = 0;
  let lastJevScore: number | undefined;

  while (Date.now() < deadline && !signal?.aborted) {
    // 1. Snapshot lightweight DOM state
    const snapshot = await page.evaluate(() => {
      const bodyText = (document.body?.innerText || "").trim();
      const main = document.querySelector("main, [role=\"main\"], #main-content, #__next, #app") || document.body;
      const mainText = (main ? main.innerText : "").trim();
      return {
        title: document.title,
        readyState: document.readyState,
        textSample: (mainText || bodyText).slice(0, 500).replace(/\s+/g, " "),
        textLength: bodyText.length,
      };
    }).catch(() => null);

    // Initial blank/connecting gate: don't waste Jev calls if completely empty
    if (!snapshot || snapshot.textLength === 0) {
      await page.waitForTimeout(300).catch(() => {});
      continue;
    }

    // 2. Query Jev
    try {
      const res = await jev.evaluate({
        state: {
          url,
          title: snapshot.title,
          readyState: snapshot.readyState,
          contentLength: snapshot.textLength,
          contentExcerpt: snapshot.textSample,
        },
        questions: {
          is_ready: {
            type: "noul",
            instructions: "Determine whether the target webpage content is fully loaded, rendered, and ready for reading, as opposed to displaying placeholders, skeletons, spinners, or loading messages.",
          },
        },
      }, { timeoutMs: 1500, signal });

      const noul = res.answers?.is_ready?.type === "noul" ? res.answers.is_ready.noul : 0;
      lastJevScore = noul;
      if (noul >= 0.8) {
        consecutiveHighConfidence++;
        if (consecutiveHighConfidence >= 1) {
          log(`Jev verified page loaded (noul: ${noul.toFixed(2)}, len: ${snapshot.textLength})`);
          return { jevScore: noul };
        }
      } else {
        consecutiveHighConfidence = 0;
      }
    } catch (e) {
      // If Jev throws (quota exhausted, network failure, 429, etc.), log and fall back to mechanical heuristics
      log("Jev evaluation failed or unavailable, falling back to heuristic wait:", (e as Error).message);
      await waitForReadableContentFallback(page, signal);
      return { fallback: true, jevScore: lastJevScore };
    }

    // Poll interval between evaluations (~500ms)
    await page.waitForTimeout(500).catch(() => {});
  }
  return { jevScore: lastJevScore };
}

async function fetchPage(p: FetchParams, signal?: AbortSignal) {
  const ctx = await ensureBrowser();
  const timeout = p.timeoutMs ?? 45000;
  const page = await ctx.newPage();

  const onAbort = () => {
    try {
      void page.close();
    } catch {
      /* ignore */
    }
  };
  if (signal) {
    if (signal.aborted) {
      await page.close().catch(() => {});
      throw new Error("aborted");
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  let status: number | null = null;
  let cfMitigated = false;
  try {
    let resp: { status(): number; headers?(): Record<string, string> } | null = null;
    try {
      resp = await page.goto(p.url, { waitUntil: p.waitUntil, timeout });
    } catch (e) {
      log("goto threw (continuing):", (e as Error).message);
    }
    if (resp) {
      status = resp.status();
      try {
        const h = resp.headers?.() ?? {};
        cfMitigated = String(h["cf-mitigated"] || "").toLowerCase().includes("challenge");
      } catch {
        /* headers unavailable */
      }
    }

    // 1. Wait for page load state (domcontentloaded is already fulfilled, wait briefly for load/settle)
    if (p.waitUntil === "networkidle") {
      await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 8000) }).catch(() => {});
    } else {
      await page.waitForLoadState("load", { timeout: Math.min(timeout, 3000) }).catch(() => {});
    }

    // 1b. Cloudflare challenge branch. Jev decides whether this is really a challenge
    // and, if so, which element to click; we then re-check state each round.
    let cf: CfOutcome | undefined;
    const jevService = resolveJevService();
    if (jevService) {
      try {
        cf = await handleCloudflareChallenge({
          page,
          context: ctx as unknown as { newCDPSession?(page: unknown): Promise<{ send(m: string, p?: unknown): Promise<unknown> }> },
          url: p.url,
          jev: jevService,
          signal,
          log,
          headerHint: cfMitigated,
        });
        if (cf.detected) {
          log(
            `cloudflare challenge branch: detected=true solved=${cf.solved} ` +
              `rounds=${cf.rounds}${cf.reason ? ` reason=${cf.reason}` : ""}`,
          );
          // Give the page a moment to finish rendering the real content after the challenge.
          if (cf.solved) await page.waitForLoadState("load", { timeout: 3000 }).catch(() => {});
        }
      } catch (e) {
        log("cloudflare challenge branch threw:", (e as Error).message);
      }
    } else {
      // No Jev available: fall back to the cheap structural signal so we at least warn.
      cfMitigated = cfMitigated || /just a moment|请稍候|安全验证/i.test(await page.title().catch(() => ""));
    }
    
    // 2. Custom wait selector if provided
    if (p.waitSelector) await page.waitForSelector(p.waitSelector, { timeout }).catch(() => {});

    // 3. Dynamic SPA hydration, code block formatting, lazy content auto-wait, & table span annotation
    try {
      await page.evaluate(async () => {
        // Annotate table colspan/rowspan attributes with explicit semantic tags
        try {
          const tables = document.querySelectorAll("table");
          for (const table of tables) {
            const rows = table.querySelectorAll("tr");
            for (const tr of rows) {
              const cells = tr.querySelectorAll("th, td");
              for (const cell of cells) {
                const colSpan = cell.getAttribute("colspan")
                  ? parseInt(cell.getAttribute("colspan")!, 10)
                  : 1;
                const rowSpan = cell.getAttribute("rowspan")
                  ? parseInt(cell.getAttribute("rowspan")!, 10)
                  : 1;
                const badges: string[] = [];
                if (colSpan > 1) badges.push(`colspan=${colSpan}`);
                if (rowSpan > 1) badges.push(`rowspan=${rowSpan}`);
                if (badges.length > 0) {
                  const tag = `[${badges.join(", ")}] `;
                  const textNode = document.createTextNode(tag);
                  cell.insertBefore(textNode, cell.firstChild);
                }
              }
            }
          }
        } catch {
          /* ignore */
        }

        // Preserve newlines in multi-line <pre> / <code> blocks for ARIA snapshot
        try {
          const pres = document.querySelectorAll("pre, code");
          for (const pre of pres) {
            const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              if (node.nodeValue && node.nodeValue.includes("\n")) {
                node.nodeValue = node.nodeValue.replace(/\n/g, " __PI_NL__ ");
              }
            }
          }
        } catch {
          /* ignore */
        }

        // Trigger lazy loading by smooth gentle scrolling
        const scrollH = document.body?.scrollHeight || 0;
        if (scrollH > 1000) {
          window.scrollTo(0, Math.min(scrollH, 2000));
          await new Promise((r) => setTimeout(r, 100));
          window.scrollTo(0, 0);
        }
      });
    } catch {
      /* ignore evaluate errors on unusual pages */
    }

    // 4. Extra wait (at least small pause for hydration if not specified)
    const extraWait = p.extraWaitMs ?? 400;
    if (extraWait > 0) await page.waitForTimeout(extraWait).catch(() => {});
    const loadVerdict = await waitForReadableContent(page, p.url, signal);

    // Content extraction = Playwright ARIA accessibility snapshot (same source as
    // playwright-cli). Hidden/aria-hidden/hover-only nodes are excluded by design.
    let aria = "";
    let effectiveSelector = p.selector;
    let selection: ScopeDecision | undefined;
    let candidate: ScopeCandidate | undefined;

    // Take the full snapshot as a completeness baseline. Automatic scoping is accepted only
    // when it retains a meaningful share of this tree; this prevents a review card, resource
    // card, or first feed item from being mistaken for the whole page.
    let fullAria = "";
    try {
      fullAria = await page.ariaSnapshot({ timeout: Math.min(timeout, 10000) });
    } catch (e) {
      log("full-page ariaSnapshot failed:", (e as Error).message);
    }

    // Auto-detect the broadest substantive content container. Inspect every matching element
    // instead of document.querySelector(...)/locator.first(), which loses multi-article feeds.
    if (!effectiveSelector && p.autoSelector !== false) {
      try {
        const selectors = [
          "#main-content",
          "main",
          "[role=\"main\"]",
          "article.markdown",
          "[class*=\"prose-doc\"]",
          "[class*=\"markdown-body\"]",
          "[class*=\"doc-content\"]",
          ".prose",
          "main article",
          ".content-container",
          ".main-content",
          "article",
        ];
        const candidates = await page.evaluate((sels: string[]) => {
          const found: ScopeCandidate[] = [];
          sels.forEach((selector, priority) => {
            const elements = [...document.querySelectorAll<HTMLElement>(selector)];
            const lengths = elements.map((element) => (element.innerText || "").trim().length);
            const substantiveMatches = lengths.filter((length) => length > 200).length;
            elements.forEach((element, index) => {
              found.push({ selector, index, textLength: lengths[index], priority, substantiveMatches });
            });
          });
          return found;
        }, selectors);
        candidate = chooseScopeCandidate(candidates);
        if (candidate) {
          effectiveSelector = candidate.selector;
          log("auto-detected content candidate:", candidate);
        }
      } catch (e) {
        log("auto-detection threw (falling back to full page):", (e as Error).message);
      }
    }

    if (effectiveSelector) {
      try {
        const locator = page.locator(effectiveSelector);
        const scopedAria = p.selector
          ? await locator.first().ariaSnapshot({ timeout: Math.min(timeout, 4000) })
          : await locator.nth(candidate?.index ?? 0).ariaSnapshot({ timeout: Math.min(timeout, 4000) });

        // Explicit user selectors are authoritative. Automatic selectors must pass the
        // coverage guard before they are allowed to discard the full-page snapshot.
        if (p.selector) {
          aria = scopedAria;
        } else {
          selection = decideAriaScope(fullAria, scopedAria, candidate);
          if (selection.useScoped) {
            aria = scopedAria;
          } else {
            aria = fullAria;
            log("rejected auto scope:", selection.reason, selection.coverage);
            effectiveSelector = undefined;
          }
        }
      } catch (e) {
        log("locator ariaSnapshot failed, falling back to full page:", (e as Error).message);
      }
    }
    if (!aria || !aria.trim()) aria = fullAria;
    if (!aria || !aria.trim()) aria = await page.ariaSnapshot({ timeout: Math.min(timeout, 10000) });

    let html: string | undefined;
    if (p.format === "html") {
      try {
        html = await page.content();
      } catch {
        /* ignore */
      }
    }

    let screenshotB64: string | null = null;
    let screenshotPath: string | null = null;
    if (p.screenshot || p.inlineImage) {
      const buf = await page.screenshot({ fullPage: !!p.fullPage, type: "png", timeout });
      screenshotB64 = buf.toString("base64");
      try {
        await mkdir(SHOT_DIR, { recursive: true });
        screenshotPath = path.join(
          SHOT_DIR,
          `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
        );
        await writeFile(screenshotPath, buf);
      } catch (e) {
        log("save screenshot failed:", (e as Error).message);
      }
    }

    const title = await page.title().catch(() => "");
    return {
      status,
      title,
      url: page.url(),
      aria,
      html,
      effectiveSelector,
      selection,
      screenshot: screenshotB64,
      screenshotPath,
      loadVerdict,
      cloudflare: cf,
    };
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    try {
      await page.close();
    } catch {
      /* ignore */
    }
  }
}

// ==========================================================================
// ARIA YAML parser + Markdown / text renderer (runs in Node, not the browser)
// Format produced by Playwright's page.ariaSnapshot():
//   - role ["accessible name"] [flags like [level=3]]:
//     - /url: <url>
//     - text: <raw text>
//     - child role ...
// ==========================================================================

interface AriaNode {
  role: string;
  name: string;
  level: number;
  url?: string;
  children: AriaNode[];
}

function parseAria(yaml: string): AriaNode {
  const root: AriaNode = { role: "root", name: "", level: 0, children: [] };
  const stack: { indent: number; node: AriaNode }[] = [{ indent: -1, node: root }];
  for (const line of yaml.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(\s*)-\s+(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    let rest = m[2].trim();

    if (rest.startsWith("/url:")) {
      const parent = stack[stack.length - 1].node;
      if (parent) {
        let u = rest.slice(5).trim();
        if (
          (u.startsWith("\"") && u.endsWith("\"")) ||
          (u.startsWith("'") && u.endsWith("'"))
        ) {
          u = u.slice(1, -1);
        }
        parent.url = u;
      }
      continue;
    }

    // Strip wrapping quotes and trailing colons that YAML emitters produce for lines with special chars
    if (rest.endsWith(":")) rest = rest.slice(0, -1).trim();
    if (
      (rest.startsWith("'") && rest.endsWith("'")) ||
      (rest.startsWith("\"") && rest.endsWith("\""))
    ) {
      rest = rest.slice(1, -1).trim();
    }
    if (rest.endsWith(":")) rest = rest.slice(0, -1).trim();

    let node: AriaNode;
    if (rest.startsWith("text:")) {
      let t = rest.slice(5).trim();
      if (
        (t.startsWith("\"") && t.endsWith("\"")) ||
        (t.startsWith("'") && t.endsWith("'"))
      ) {
        t = t.slice(1, -1);
      }
      node = { role: "text", name: t, level: 0, children: [] };
    } else if (rest.startsWith("code:")) {
      let t = rest.slice(5).trim();
      if (
        (t.startsWith("\"") && t.endsWith("\"")) ||
        (t.startsWith("'") && t.endsWith("'"))
      ) {
        t = t.slice(1, -1);
      }
      node = { role: "code", name: t, level: 0, children: [] };
    } else {
      const match = rest.match(/^([a-zA-Z0-9_-]+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/);
      if (!match) {
        node = { role: rest, name: "", level: 0, children: [] };
      } else {
        const role = match[1];
        let name = match[2] != null ? match[2] : "";
        const tail = match[3] || "";
        const lvlM = tail.match(/\[level=(\d+)\]/);
        const level = lvlM ? parseInt(lvlM[1], 10) : 0;
        const colonIdx = tail.indexOf(":");
        if (colonIdx !== -1) {
          let inline = tail.slice(colonIdx + 1).trim();
          if (
            (inline.startsWith("\"") && inline.endsWith("\"")) ||
            (inline.startsWith("'") && inline.endsWith("'"))
          ) {
            inline = inline.slice(1, -1);
          }
          if (inline) name = name ? `${name} ${inline}` : inline;
        }
        node = { role, name, level, children: [] };
      }
    }

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
  }
  return root;
}

const CONTAINER = new Set([
  "root", "generic", "main", "section", "article", "group", "region", "navigation",
  "banner", "contentinfo", "complementary", "figure", "figcaption", "form",
  "application", "document", "presentation", "none", "toolbar", "rowgroup",
]);
const SKIP = new Set(["img", "graphic"]);

function inlineText(node: AriaNode): string {
  let s = node.name || "";
  for (const c of node.children) {
    if (c.role === "text" || c.role === "code") {
      s = s ? `${s} ${c.name}` : c.name;
    } else if (c.role === "link") {
      const t = c.name || inlineText(c);
      s = s ? `${s} ${t}` : t;
    } else if (!SKIP.has(c.role) && !c.url) {
      const t = inlineText(c);
      if (t) s = s ? `${s} ${t}` : t;
    }
  }
  return s;
}

function linkText(url: string | undefined, text: string): string {
  if (url && url.length > 0 && url.length <= MAX_URL) return `[${text}](${url})`;
  return text;
}

function renderTable(tableNode: AriaNode, out: string[]) {
  const rows: AriaNode[] = [];
  function collectRows(n: AriaNode) {
    if (n.role === "row") {
      rows.push(n);
    } else {
      for (const c of n.children) collectRows(c);
    }
  }
  collectRows(tableNode);
  if (rows.length === 0) return;

  const rawRows: { text: string; colspan: number; rowspan: number }[][] = [];
  for (const row of rows) {
    const cells: { text: string; colspan: number; rowspan: number }[] = [];
    for (const c of row.children) {
      if (c.role === "cell" || c.role === "columnheader" || c.role === "rowheader") {
        let cellText = (c.name || inlineText(c)).trim();
        cellText = cellText.replace(/\|/g, "\\|").replace(/\n+/g, " ");

        let colspan = 1;
        let rowspan = 1;
        const colM = cellText.match(/\[(?:.*?\b)?colspan=(\d+)(?:.*?)?\]/i);
        if (colM) colspan = Math.max(1, parseInt(colM[1], 10));
        const rowM = cellText.match(/\[(?:.*?\b)?rowspan=(\d+)(?:.*?)?\]/i);
        if (rowM) rowspan = Math.max(1, parseInt(rowM[1], 10));

        cells.push({ text: cellText, colspan, rowspan });
      }
    }
    if (cells.length > 0) {
      rawRows.push(cells);
    }
  }
  if (rawRows.length === 0) return;

  // Build a true 2D matrix accounting for spans
  const grid: (string | undefined)[][] = [];
  for (let r = 0; r < rawRows.length; r++) {
    if (!grid[r]) grid[r] = [];
    const row = rawRows[r];
    let colIndex = 0;

    for (const cell of row) {
      while (grid[r][colIndex] !== undefined) {
        colIndex++;
      }

      grid[r][colIndex] = cell.text;

      // Fill spanned grid cells with merge continuation indicators
      for (let dr = 0; dr < cell.rowspan; dr++) {
        for (let dc = 0; dc < cell.colspan; dc++) {
          if (dr === 0 && dc === 0) continue;
          const tr = r + dr;
          const tc = colIndex + dc;
          if (!grid[tr]) grid[tr] = [];
          // '»' denotes merged from left, '«' denotes merged from above
          grid[tr][tc] = dr === 0 ? "»" : "«";
        }
      }

      colIndex += cell.colspan;
    }
  }

  let maxCols = 0;
  for (const row of grid) {
    if (row && row.length > maxCols) maxCols = row.length;
  }
  if (maxCols === 0) return;

  out.push("\n\n");
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    const cellTexts: string[] = [];
    for (let c = 0; c < maxCols; c++) {
      cellTexts.push(row[c] !== undefined ? row[c]! : "");
    }
    out.push("| " + cellTexts.join(" | ") + " |\n");
    if (r === 0) {
      out.push("| " + cellTexts.map(() => "---").join(" | ") + " |\n");
    }
  }
  out.push("\n");
}

function renderMarkdown(node: AriaNode, out: string[], listDepth: number) {
  for (const n of node.children) {
    switch (n.role) {
      case "heading": {
        const lvl = n.level > 0 && n.level <= 6 ? n.level : 2;
        out.push("\n\n" + "#".repeat(lvl) + " " + (n.name || inlineText(n)).trim() + "\n\n");
        break;
      }
      case "link": {
        const txt = (n.name || inlineText(n)).trim();
        if (txt) out.push(linkText(n.url, txt) + " ");
        for (const c of n.children)
          if (c.role !== "text" && c.role !== "code" && !c.url && !SKIP.has(c.role))
            renderMarkdown({ role: "x", name: "", level: 0, children: [c] }, out, listDepth);
        break;
      }
      case "list":
        renderMarkdown(n, out, listDepth);
        out.push("\n");
        break;
      case "listitem": {
        const pad = "  ".repeat(listDepth);
        const nested: AriaNode[] = [];
        const bodyParts: string[] = [];
        for (const c of n.children) {
          if (c.role === "list") nested.push(c);
          else if ((c.role === "text" || c.role === "code") && c.name.trim()) {
            bodyParts.push(c.role === "code" ? `\`${c.name.trim()}\`` : c.name.trim());
          } else {
            const t = (c.name || inlineText(c)).trim();
            if (t) bodyParts.push(c.url ? linkText(c.url, t) : t);
          }
        }
        const body = bodyParts.join(" ").trim();
        if (body) out.push(`\n${pad}- ${body}`);
        else if (nested.length) out.push(`\n${pad}-`);
        for (const c of nested) renderMarkdown(c, out, listDepth + 1);
        break;
      }
      case "paragraph": {
        const body = inlineText(n).trim();
        if (body) out.push("\n" + body + "\n");
        break;
      }
      case "table":
        renderTable(n, out);
        break;
      case "code": {
        let txt = n.name.trim();
        if (txt) {
          if (txt.includes("__PI_NL__") || txt.includes("\n")) {
            const restored = txt.replace(/\s*__PI_NL__\s*/g, "\n").trim();
            out.push("\n\n```\n" + restored + "\n```\n\n");
          } else {
            out.push("`" + txt + "` ");
          }
        }
        break;
      }
      case "text":
        if (n.name.trim()) out.push(n.name.trim() + " ");
        break;
      case "textbox":
        if (n.name.trim()) out.push(`[输入框:${n.name.trim()}] `);
        break;
      case "button":
        if (n.name.trim()) out.push(`[按钮:${n.name.trim()}] `);
        break;
      case "separator":
        out.push("\n\n---\n\n");
        break;
      default:
        if (SKIP.has(n.role)) break;
        if (CONTAINER.has(n.role)) {
          renderMarkdown(n, out, listDepth);
        } else {
          if (n.name.trim()) out.push(n.name.trim() + " ");
          renderMarkdown(n, out, listDepth);
        }
    }
  }
}

function renderText(node: AriaNode, out: string[]) {
  for (const n of node.children) {
    switch (n.role) {
      case "heading":
      case "paragraph":
      case "text":
      case "code": {
        const t = (n.name || inlineText(n)).trim();
        if (t) out.push(t + "\n");
        for (const c of n.children) renderText({ role: "x", name: "", level: 0, children: [c] }, out);
        break;
      }
      case "link": {
        const t = (n.name || inlineText(n)).trim();
        if (t) out.push(t + " ");
        for (const c of n.children) renderText({ role: "x", name: "", level: 0, children: [c] }, out);
        break;
      }
      case "listitem": {
        const t = (n.name || inlineText(n)).trim();
        if (t) out.push("- " + t + "\n");
        for (const c of n.children) renderText({ role: "x", name: "", level: 0, children: [c] }, out);
        break;
      }
      case "textbox":
      case "button":
        break;
      default:
        if (SKIP.has(n.role)) break;
        for (const c of n.children) renderText({ role: "x", name: "", level: 0, children: [c] }, out);
    }
  }
}

function ariaToMarkdown(yaml: string): string {
  const out: string[] = [];
  renderMarkdown(parseAria(yaml), out, 0);
  return out
    .join("")
    .replace(/\s*__PI_NL__\s*/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

function ariaToText(yaml: string): string {
  const out: string[] = [];
  renderText(parseAria(yaml), out);
  return out
    .join("")
    .replace(/\s*__PI_NL__\s*/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- browser-side: stealth init script (self-contained) -------------------
function stealth() {
  try {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true });
  } catch {}
  try {
    Object.defineProperty(navigator, "languages", {
      get: () => ["zh-CN", "zh", "en-US", "en"],
      configurable: true,
    });
  } catch {}
  try {
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5].map((i) => ({ name: "Plugin " + i, filename: "np" + i + ".dll" })),
      configurable: true,
    });
  } catch {}
  try {
    const w = window as any;
    w.chrome = w.chrome || { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} };
  } catch {}
  try {
    const orig = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (p: any): any =>
      p && p.name === "notifications"
        ? Promise.resolve({ state: (Notification as any).permission })
        : orig(p);
  } catch {}
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p: number) {
      if (p === 37445) return "Intel Inc.";
      if (p === 37446) return "Intel Iris OpenGL Engine";
      return getParameter.call(this, p);
    };
  } catch {}
}

// ---- extension factory ----------------------------------------------------
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    try {
      const active = pi.getActiveTools();
      if (active.length > 0 && !active.includes("web_reader"))
        pi.setActiveTools([...active, "web_reader"]);
    } catch {
      /* ignore */
    }
    // Eagerly pre-warm the browser in the background to eliminate cold-start latency
    ensureBrowser().catch((e) => {
      log("pre-warm browser failed:", (e as Error).message);
    });
  });

  pi.on("session_shutdown", async () => {
    await closeBrowser();
  });

  pi.registerTool({
    name: "web_reader",
    label: "Web Reader",
    description:
      "Fetch and fully render web page content with a real headless browser (handles " +
      "JavaScript / single-page apps, dynamic hydration, and bot-blocking WAFs). Cloudflare " +
      "challenges (Turnstile / 'Just a moment') are detected and solved automatically. Content " +
      "is extracted from Playwright's ARIA accessibility snapshot and Jev semantic load verification — so " +
      "hidden/hover-only UI is excluded and the output is clean, readable Markdown.",
    promptSnippet: "Real-browser web reader; clean Markdown via ARIA snapshot and Jev semantic load verification",
    promptGuidelines: [
      "Use web_reader to fetch and read web page content, including JavaScript-heavy SPAs, dynamic sites, and documentation.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL to render (http/https; protocol auto-added)." }),
      format: Type.Optional(StringEnum(["markdown", "text", "aria", "html"] as const)),
      selector: Type.Optional(
        Type.String({
          description: "Optional CSS selector: snapshot only that subtree (e.g. 'main', 'article', '.content'). By default, intelligent main content auto-detection is used.",
        }),
      ),
      autoSelector: Type.Optional(
        Type.Boolean({
          description: "Whether to automatically detect main content container (defaults to true). Set false to snapshot whole page.",
        }),
      ),
      waitUntil: Type.Optional(StringEnum(["load", "domcontentloaded", "networkidle"] as const)),
      waitSelector: Type.Optional(
        Type.String({ description: "Optional CSS selector to wait for before extracting." }),
      ),
      extraWaitMs: Type.Optional(
        Type.Number({ description: "Extra fixed wait (ms) after network idle, for lazy content (default: 400ms)." }),
      ),
      timeoutMs: Type.Optional(Type.Number({ description: "Navigation timeout in ms (default 45000)." })),
      screenshot: Type.Optional(
        Type.Boolean({ description: "Capture a PNG screenshot (saved to OS temp dir; path returned)." }),
      ),
      inlineImage: Type.Optional(
        Type.Boolean({
          description: "Also return the screenshot as an inline base64 image block (for multimodal models). Default false — only the file path is returned.",
        }),
      ),
      fullPage: Type.Optional(Type.Boolean({ description: "Full-page screenshot (default viewport only)." })),
      maxChars: Type.Optional(
        Type.Number({ description: "Max characters of returned text/markdown (default 60000)." }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }], details: {} };

      let url = (params as { url: string }).url?.trim();
      if (!url) return { content: [{ type: "text", text: "Error: `url` is required." }], isError: true, details: {} };
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;

      const p = params as FetchParams;
      const format = (p.format ?? "markdown") as FetchParams["format"];
      p.url = url;
      p.format = format;
      p.waitUntil = (p.waitUntil ?? "domcontentloaded") as FetchParams["waitUntil"];

      onUpdate?.({ content: [{ type: "text", text: `Rendering ${url} …` }], details: {} });

      let result;
      try {
        result = await fetchPage(p, signal);
      } catch (e) {
        const msg = (e as Error).message || String(e);
        if (/Executable doesn't exist|browserType\.launch.*chromium|browser was not found|Looks like Playwright was installed/i.test(msg)) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Browser binary not found. The Playwright library was installed, but the bundled Chromium " +
                  "was NOT (npm skips the playwright postinstall script that downloads it). Fix it by running " +
                  "ONE of these from this extension's directory:\n" +
                  "  cd " + EXT_DIR + " && npx playwright install chromium\n" +
                  "...or install a real Chrome/Edge on the system (preferred for anti-detection).\n\n" +
                  "Original error: " + msg,
              },
            ],
            isError: true,
            details: {},
          };
        }
        return { content: [{ type: "text", text: `Error rendering page: ${msg}` }], isError: true, details: {} };
      }

      let body = "";
      if (format === "aria") body = result.aria || "";
      else if (format === "html") body = result.html || "";
      else if (format === "text") body = ariaToText(result.aria || "");
      else body = ariaToMarkdown(result.aria || "");

      if (!body.trim() && result.aria) body = result.aria;

      const maxChars = (params as { maxChars?: number }).maxChars ?? 60000;
      let truncated = false;
      if (body.length > maxChars) {
        body = body.slice(0, maxChars);
        truncated = true;
      }

      const hasSpans = body.includes("[colspan=") || body.includes("[rowspan=") || body.includes("»") || body.includes("«");
      const spanLegend = hasSpans
        ? "Note: Tables contain merged cells annotated with [colspan=N]/[rowspan=N], '»' (horizontal continuation), and '«' (vertical continuation).\n"
        : "";

      const selectionNote = result.selection && !result.selection.useScoped
        ? result.selection.reason === "low-coverage"
          ? `  [full-page fallback: ${result.selection.candidate?.selector ?? "candidate"} covered ${Math.round((result.selection.coverage ?? 0) * 100)}%]`
          : `  [full-page fallback: ${result.selection.reason}]`
        : "";
      const jevNote = result.loadVerdict?.jevScore !== undefined
        ? `Jev Score: ${result.loadVerdict.jevScore.toFixed(2)}${result.loadVerdict.fallback ? " (fallback)" : ""}\n`
        : "";
      const cfNote = result.cloudflare?.detected
        ? `Cloudflare: challenge detected — ${result.cloudflare.solved
            ? `passed after ${result.cloudflare.rounds} click round(s)`
            : `NOT passed (rounds=${result.cloudflare.rounds}${result.cloudflare.reason ? `, ${result.cloudflare.reason}` : ""})`}\n`
        : "";
      // A 403 on a solved challenge is the *challenge* response's status; the content below
      // is the real page. Say so, otherwise the bare 403 reads as a failure.
      const statusNote =
        result.cloudflare?.detected && result.cloudflare.solved && (result.status ?? 0) >= 400
          ? ` (initial challenge response; page rendered successfully)`
          : "";
      const header =
        `URL: ${result.url}\n` +
        `Title: ${result.title}\n` +
        `HTTP: ${result.status ?? "?"}${statusNote}\n` +
        `Browser: ${activeChannel}${viaCdp ? " (cdp)" : ""}${result.effectiveSelector ? `  [scope: ${result.effectiveSelector}]` : ""}${selectionNote}${truncated ? "  [truncated]" : ""}\n` +
        jevNote +
        cfNote +
        (result.screenshotPath ? `Screenshot: ${result.screenshotPath}\n` : "") +
        spanLegend +
        `\n`;

      const content: any[] = [
        { type: "text", text: header + body },
      ];
      // Inline base64 is opt-in (bloats the session and is useless for non-vision models).
      // By default only the file path above is returned; feed it to analyze_image.
      if (p.inlineImage && result.screenshot) {
        content.push({
          type: "image",
          data: result.screenshot,
          mimeType: "image/png",
        });
      }

      return {
        content,
        details: {
          url: result.url,
          title: result.title,
          status: result.status,
          browser: activeChannel,
          jevScore: result.loadVerdict?.jevScore,
          truncated,
          format,
          ariaBytes: result.aria?.length ?? 0,
          selection: result.selection,
          screenshotPath: result.screenshotPath,
          cloudflare: result.cloudflare,
        },
      };
    },
  });
}
