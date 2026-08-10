/**
 * pi extension: web_reader_spa — SPA-aware companion to the built-in web_reader
 * -------------------------
 * A SPA-aware, anti-WAF web reader backed by the Playwright library.
 *
 * It drives a REAL browser (prefers your installed Chrome/Edge so the fingerprint
 * is genuine), spoofs a realistic User-Agent, injects a stealth init script, and
 * then extracts content from Playwright's **ARIA accessibility snapshot** — the
 * exact same data source `playwright-cli` uses for its snapshots. Using the
 * accessibility tree means hidden/hover-only UI (menus, "not interested" buttons,
 * aria-hidden clutter) is naturally excluded, so the output is clean.
 *
 * Config (env vars):
 *   PI_WEBREADER_UA       Override User-Agent (default: recent Windows Chrome).
 *   PI_WEBREADER_LOCALE   Locale / Accept-Language base (default: zh-CN).
 *   PI_WEBREADER_HEADED   "1" to show the browser window (default: headless).
 *   PI_WEBREADER_CHANNEL  Comma list, e.g. "chrome,msedge" or "chromium" for the
 *                         bundled headless shell. Default: chrome,msedge,chromium.
 *   PI_WEBREADER_CDP      Connect to a real browser over CDP, e.g.
 *                         "http://localhost:9222" (strongest anti-detection).
 *   PI_WEBREADER_MAXURL  Max URL length kept in markdown output (default: 120;
 *                         longer URLs — typically ad/tracking — are dropped).
 *   PI_WEBREADER_DEBUG    "1" to print debug logs to stderr.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const DEBUG = /^(1|true|yes)$/i.test(process.env.PI_WEBREADER_DEBUG || "");
function log(...a: unknown[]) {
  if (DEBUG) console.error("[web-reader-spa]", ...a);
}

// ---- environment-driven config -------------------------------------------
const UA =
  process.env.PI_WEBREADER_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const LOCALE = process.env.PI_WEBREADER_LOCALE || "zh-CN";
const HEADED = /^(1|true|yes)$/i.test(process.env.PI_WEBREADER_HEADED || "");
const CDP = process.env.PI_WEBREADER_CDP?.trim() || "";
const MAX_URL = parseInt(process.env.PI_WEBREADER_MAXURL || "120", 10);
// Resolve the extension's own directory (works for both local dev installs and
// `pi install` git/npm packages, which land under different paths).
const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.join(tmpdir(), "pi-web-reader-spa");

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process,AutomationControlled",
  "--disable-infobars",
];

function channelList(): string[] {
  const env = process.env.PI_WEBREADER_CHANNEL?.trim();
  if (env) {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((c) => (c.toLowerCase() === "chromium" ? "" : c));
  }
  return ["chrome", "msedge", ""];
}

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
}
interface AnyPage {
  goto(url: string, opts?: unknown): Promise<{ status(): number } | null>;
  waitForLoadState(state: string, opts?: unknown): Promise<void>;
  waitForSelector(sel: string, opts?: unknown): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  ariaSnapshot(opts?: unknown): Promise<string>;
  content(): Promise<string>;
  screenshot(opts?: unknown): Promise<Buffer>;
  url(): string;
  title(): Promise<string>;
  locator(sel: string): { ariaSnapshot(opts?: unknown): Promise<string> };
  close(): Promise<void>;
}

let browser: AnyBrowser | null = null;
let context: AnyContext | null = null;
let activeChannel = "";
let viaCdp = false;
let opening: Promise<void> | null = null;

function contextOpts() {
  return {
    userAgent: UA,
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
  opening = (async () => {
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
        browser = (await chromium.connectOverCDP(CDP)) as AnyBrowser;
        viaCdp = true;
        activeChannel = "cdp";
        context = browser.contexts()[0] || (await browser.newContext(contextOpts()));
      } else {
        let lastErr: unknown;
        for (const ch of channelList()) {
          try {
            log("launching channel:", ch || "bundled-chromium", "headless:", !HEADED);
            browser = (await chromium.launch({
              ...(ch ? { channel: ch } : {}),
              headless: !HEADED,
              args: LAUNCH_ARGS,
            })) as AnyBrowser;
            activeChannel = ch || "chromium";
            break;
          } catch (e) {
            lastErr = e;
            log("channel unavailable:", ch || "bundled", "=>", (e as Error).message);
          }
        }
        if (!browser) throw lastErr;
        context = await browser.newContext(contextOpts());
      }

      await context!.addInitScript(stealth);
      log("ready. channel:", activeChannel, "cdp:", viaCdp);
    } finally {
      opening = null;
    }
  })();
  await opening;
  if (!context) throw new Error("Failed to start browser");
  return context;
}

async function closeBrowser() {
  const b = browser;
  context = null;
  browser = null;
  activeChannel = "";
  viaCdp = false;
  opening = null;
  if (b) {
    try {
      await b.close();
    } catch {
      /* ignore */
    }
  }
}

// ---- per-fetch logic ------------------------------------------------------
interface FetchParams {
  url: string;
  format: "markdown" | "text" | "aria" | "html";
  selector?: string;
  waitUntil: "load" | "domcontentloaded" | "networkidle";
  waitSelector?: string;
  extraWaitMs?: number;
  timeoutMs?: number;
  screenshot?: boolean;
  fullPage?: boolean;
  inlineImage?: boolean;
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
  try {
    let resp: { status(): number } | null = null;
    try {
      resp = await page.goto(p.url, { waitUntil: p.waitUntil, timeout });
    } catch (e) {
      log("goto threw (continuing):", (e as Error).message);
    }
    if (resp) status = resp.status();

    await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 12000) }).catch(() => {});
    if (p.waitSelector) await page.waitForSelector(p.waitSelector, { timeout }).catch(() => {});
    if (p.extraWaitMs && p.extraWaitMs > 0) await page.waitForTimeout(p.extraWaitMs).catch(() => {});

    // Content extraction = Playwright ARIA accessibility snapshot (same source as
    // playwright-cli). Hidden/aria-hidden/hover-only nodes are excluded by design.
    let aria = "";
    if (p.selector) {
      try {
        aria = await page.locator(p.selector).ariaSnapshot({ timeout });
      } catch (e) {
        log("locator ariaSnapshot failed, falling back to full page:", (e as Error).message);
      }
    }
    if (!aria || !aria.trim()) aria = await page.ariaSnapshot({ timeout });

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
    if (p.screenshot) {
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
    return { status, title, url: page.url(), aria, html, screenshot: screenshotB64, screenshotPath };
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
  for (const raw of yaml.split("\n")) {
    if (!raw.trim()) continue;
    const m = raw.match(/^(\s*)- (.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const rest = m[2];

    if (rest.startsWith("/url:")) {
      const parent = stack[stack.length - 1].node;
      if (parent) parent.url = rest.slice(5).trim();
      continue;
    }

    let node: AriaNode;
    if (rest.startsWith("text:")) {
      node = { role: "text", name: rest.slice(5).trim(), level: 0, children: [] };
    } else {
      const nm = rest.match(/^([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/);
      const role = nm ? nm[1] : rest;
      const name = nm && nm[2] != null ? nm[2] : "";
      const lvlM = nm ? nm[3].match(/\[level=(\d+)\]/) : null;
      node = { role, name, level: lvlM ? parseInt(lvlM[1], 10) : 0, children: [] };
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
  "application", "document", "presentation", "none", "toolbar",
]);
const SKIP = new Set(["img", "graphic"]);

function inlineText(node: AriaNode): string {
  let s = node.name || "";
  for (const c of node.children) {
    if (c.role === "text") s += c.name;
    else if (c.role === "link") s += c.name || inlineText(c);
    else if (!SKIP.has(c.role) && !c.url) s += inlineText(c);
  }
  return s;
}

function linkText(url: string | undefined, text: string): string {
  if (url && url.length > 0 && url.length <= MAX_URL) return `[${text}](${url})`;
  return text;
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
          if (c.role !== "text" && !c.url && !SKIP.has(c.role))
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
          else if (c.role === "text" && c.name.trim()) bodyParts.push(c.name.trim());
          else {
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
      case "text": {
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
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

function ariaToText(yaml: string): string {
  const out: string[] = [];
  renderText(parseAria(yaml), out);
  return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
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
      if (active.length > 0 && !active.includes("web_reader_spa"))
        pi.setActiveTools([...active, "web_reader_spa"]);
    } catch {
      /* ignore */
    }
  });

  pi.on("session_shutdown", async () => {
    await closeBrowser();
  });

  // Couple with the built-in web_reader: append a fallback hint to its tool
  // description so the model reaches for web_reader_spa when web_reader can't
  // render a JS/SPA page. Handles both Anthropic/Google ({name,description}) and
  // OpenAI ({function:{name,description}}) tool shapes.
  const WEBREADER_FALLBACK =
    "\n\nIf this returns empty/garbled content, only a JS shell/skeleton (e.g. <div id=root>), a login/bot " +
    "interstitial with no real content, OR the output is low-readability (e.g. a raw table dumped as rows of " +
    "`| | |` with no readable text, huge base64 blobs, mostly metadata/boilerplate with no real body, or " +
    "otherwise needs a human to clean up before it's usable), retry the SAME url with the `web_reader_spa` " +
    "tool, which drives a real browser and returns clean Markdown.";
  pi.on("before_provider_request", (event) => {
    const tools = (event.payload as { tools?: unknown })?.tools;
    if (!Array.isArray(tools)) return;
    for (const t of tools as Array<Record<string, any>>) {
      const name = t?.name || t?.function?.name;
      if (name !== "web_reader") continue;
      if (typeof t?.description === "string") t.description += WEBREADER_FALLBACK;
      else if (t?.function && typeof t.function.description === "string")
        t.function.description += WEBREADER_FALLBACK;
    }
    return event.payload;
  });

  pi.registerTool({
    name: "web_reader_spa",
    label: "Web Reader (SPA)",
    description:
      "SPA-aware companion to web_reader: fetch and fully render a page with a real headless browser (handles " +
      "JavaScript / single-page apps and bot-blocking WAFs via a spoofed User-Agent + stealth patches). Content " +
      "is extracted from Playwright's ARIA accessibility snapshot — the same source playwright-cli uses — so " +
      "hidden/hover-only UI is excluded and the output is clean Markdown. Use this whenever web_reader can't " +
      "handle a page: single-page apps, JS-rendered content, login-wall interstitials, or pages that block " +
      "plain HTTP clients.",
    promptSnippet: "Real-browser render for SPAs; clean Markdown via ARIA snapshot (use when web_reader fails)",
    promptGuidelines: [
      "Use web_reader_spa instead of web_reader for single-page apps, JavaScript-rendered sites, or pages where " +
        "web_reader returns empty/blocked/garbled content or just a JS shell/skeleton.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL to render (http/https; protocol auto-added)." }),
      format: Type.Optional(StringEnum(["markdown", "text", "aria", "html"] as const)),
      selector: Type.Optional(
        Type.String({
          description: "Optional CSS selector: snapshot only that subtree (default: whole page).",
        }),
      ),
      waitUntil: Type.Optional(StringEnum(["load", "domcontentloaded", "networkidle"] as const)),
      waitSelector: Type.Optional(
        Type.String({ description: "Optional CSS selector to wait for before extracting." }),
      ),
      extraWaitMs: Type.Optional(
        Type.Number({ description: "Extra fixed wait (ms) after network idle, for lazy content." }),
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

      const header =
        `URL: ${result.url}\n` +
        `Title: ${result.title}\n` +
        `HTTP: ${result.status ?? "?"}\n` +
        `Browser: ${activeChannel}${viaCdp ? " (cdp)" : ""}${truncated ? "  [truncated]" : ""}` +
        (result.screenshotPath ? `\nScreenshot: ${result.screenshotPath}` : "") +
        `\n\n`;

      const content: any[] = [
        { type: "text", text: header + body },
      ];
      // Inline base64 is opt-in (bloats the session and is useless for non-vision models).
      // By default only the file path above is returned; feed it to analyze_image.
      if (p.inlineImage && result.screenshot) {
        content.push({
          type: "image",
          source: { type: "base64", mediaType: "image/png", data: result.screenshot },
        });
      }

      return {
        content,
        details: {
          url: result.url,
          title: result.title,
          status: result.status,
          browser: activeChannel,
          truncated,
          format,
          ariaBytes: result.aria?.length ?? 0,
          screenshotPath: result.screenshotPath,
        },
      };
    },
  });
}
