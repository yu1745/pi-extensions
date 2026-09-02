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
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
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
  // Try fast headless chromium first, fall back to installed system channels
  return ["", "msedge", "chrome"];
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
  autoSelector?: boolean;
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

    // 1. Wait for page load state (domcontentloaded is already fulfilled, wait briefly for load/settle)
    if (p.waitUntil === "networkidle") {
      await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 8000) }).catch(() => {});
    } else {
      await page.waitForLoadState("load", { timeout: Math.min(timeout, 3000) }).catch(() => {});
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

    // Content extraction = Playwright ARIA accessibility snapshot (same source as
    // playwright-cli). Hidden/aria-hidden/hover-only nodes are excluded by design.
    let aria = "";
    let effectiveSelector = p.selector;

    // Auto-detect main content container if selector is not explicitly provided
    if (!effectiveSelector && p.autoSelector !== false) {
      try {
        const detected = await page.evaluate(() => {
          // Priority candidates: broad content boundaries first (main / #main-content) to ensure
          // both post body and top discussion comments are included, or specialized doc containers.
          const candidates = [
            "article.markdown",
            "main article",
            "[class*=\"prose-doc\"]",
            "[class*=\"markdown-body\"]",
            "[class*=\"doc-content\"]",
            ".prose",
            "#main-content",
            "main",
            "[role=\"main\"]",
            "article",
            ".content-container",
            ".main-content",
          ];
          for (const sel of candidates) {
            const el = document.querySelector(sel);
            if (el) {
              const text = (el.innerText || "").trim();
              // Must have substantive content
              if (text.length > 200) {
                return sel;
              }
            }
          }
          return undefined;
        });
        if (detected) {
          effectiveSelector = detected;
          log("auto-detected main content selector:", effectiveSelector);
        }
      } catch (e) {
        log("auto-detection threw (falling back to full page):", (e as Error).message);
      }
    }

    if (effectiveSelector) {
      try {
        // Use shorter timeout (max 4000ms) for locator to avoid blocking on non-existent selectors
        aria = await page.locator(effectiveSelector).first().ariaSnapshot({ timeout: Math.min(timeout, 4000) });
      } catch (e) {
        log("locator ariaSnapshot failed, falling back to full page:", (e as Error).message);
      }
    }
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
    return {
      status,
      title,
      url: page.url(),
      aria,
      html,
      effectiveSelector,
      screenshot: screenshotB64,
      screenshotPath,
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
      if (active.length > 0 && !active.includes("web_reader_spa"))
        pi.setActiveTools([...active, "web_reader_spa"]);
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

  // Couple with the built-in web_reader: append a fallback hint to its tool
  // description so the model reaches for web_reader_spa when web_reader can't
  // render a JS/SPA page. Handles both Anthropic/Google ({name,description}) and
  // OpenAI ({function:{name,description}}) tool shapes.
  const WEBREADER_FALLBACK =
    "\n\nIf this returns a network/connection error (e.g. timeout, connection reset, 403 Forbidden, 5xx, or SSL error), " +
    "empty/garbled content, only a JS shell/skeleton (e.g. <div id=root>), a login/bot interstitial with no real content, " +
    "OR the output is low-readability (e.g. a raw table dumped as rows of `| | |` with no readable text, huge base64 blobs, " +
    "mostly metadata/boilerplate with no real body, or otherwise needs a human to clean up before it's usable), " +
    "retry the SAME url with the `web_reader_spa` tool, which drives a real browser with anti-bot stealth patches and returns clean Markdown.";
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

      const header =
        `URL: ${result.url}\n` +
        `Title: ${result.title}\n` +
        `HTTP: ${result.status ?? "?"}\n` +
        `Browser: ${activeChannel}${viaCdp ? " (cdp)" : ""}${result.effectiveSelector ? `  [scope: ${result.effectiveSelector}]` : ""}${truncated ? "  [truncated]" : ""}\n` +
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
