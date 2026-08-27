/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * pi extension: web_reader_local — Local HTML→Markdown web reader
 * -----------------------------------------------------------------
 * Fetches a URL with a realistic User-Agent + anti-bot headers, extracts
 * the main content (strips nav/ads/scripts/styles), and converts to clean
 * Markdown.  No external API key required — runs entirely on your machine.
 *
 * Config (env vars):
 *   PI_LOCAL_READER_UA       Override User-Agent.
 *   PI_LOCAL_READER_TIMEOUT  Fetch timeout in ms (default 30000).
 *   PI_LOCAL_READER_DEBUG    "1" to print debug logs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseHTML } from "linkedom";

const DEBUG = /^(1|true|yes)$/i.test(process.env.PI_LOCAL_READER_DEBUG || "");
function log(...a: unknown[]) {
  if (DEBUG) console.error("[web-reader-local]", ...a);
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA = process.env.PI_LOCAL_READER_UA || DEFAULT_UA;
const DEFAULT_TIMEOUT = parseInt(process.env.PI_LOCAL_READER_TIMEOUT || "30000", 10);

// ==========================================================================
// HTML fetch
// ==========================================================================

async function fetchHtml(url: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  const effectiveSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  try {
    const resp = await fetch(url, {
      signal: effectiveSignal,
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "follow",
    });
    const html = await resp.text();
    return { html, finalUrl: resp.url, status: resp.status };
  } finally {
    clearTimeout(timer);
  }
}

// ==========================================================================
// Content extraction (linkedom DOM)
// ==========================================================================

const BOILERPLATE_ROLES = new Set([
  "navigation", "banner", "contentinfo", "complementary",
  "search", "alert", "alertdialog", "dialog", "log", "status", "timer",
]);

const BOILERPLATE_TAGS = new Set(["nav", "footer", "aside"]);

const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "main", "figure", "figcaption", "blockquote",
  "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "pre", "hr", "dl", "dt", "dd", "details", "summary",
  "h1", "h2", "h3", "h4", "h5", "h6", "form", "fieldset", "address",
  "hgroup", "header", "footer", "aside", "nav",
]);

function getRole(el: Element): string | null {
  return el.getAttribute("role") || el.getAttribute("aria-role") || null;
}

/**
 * Visibility / position boilerplate heuristics.
 * Token-based: '2-sidebars-inline' must NOT match 'sidebar'; 'overflow-hidden'
 * intentionally should match 'hidden'. Match on word tokens, plus two
 * industry-idiom substrings (sr-only, visually-hidden) that tokenize badly.
 */
const HIDDEN_TOKENS = new Set(["hidden", "sidebar", "cookie", "modal", "popup", "offscreen"]);
function isHidden(el: Element): boolean {
  const style = el.getAttribute("style") || "";
  const lstyle = style.toLowerCase().replace(/\s/g, "");
  if (
    lstyle.includes("display:none") || lstyle.includes("visibility:hidden") ||
    lstyle.includes("opacity:0")
  ) return true;
  for (const raw of [el.className, el.id]) {
    const l = String(raw).toLowerCase();
    if (!l) continue;
    if (l.includes("sr-only") || l.includes("visually-hidden")) return true;
    for (const tok of l.split(/[^a-z0-9]+/)) {
      if (tok && HIDDEN_TOKENS.has(tok)) return true;
    }
  }
  return false;
}

function isAd(el: Element): boolean {
  const sig = ((el.className || "") + " " + (el.id || "")).toLowerCase();
  const tokens = sig.split(/[^a-z0-9]+/);
  const AD_TOKENS = new Set(["ad", "ads", "advert", "advertisement", "advertising", "sponsor", "sponsored", "promo", "promos", "newsletter"]);
  if (tokens.some((t) => AD_TOKENS.has(t))) return true;
  return /share-buttons|social-share|related-posts/.test(sig);
}

interface Candidate {
  el: Element;
  score: number;
}

/**
 * Generic content-location (Readability-style, leaf-accumulation).
 *
 * Containers don't score themselves — real content nodes do. Each qualifying
 * leaf (<p>, <pre>, heading, <blockquote>) earns a prose score that is
 * propagated up its ancestor chain with decay. This naturally favours
 * tight wrappers of dense text over both layout husks and the whole body,
 * regardless of how a site is built.
 */
const CONTENT_LEAF_SEL = "p, pre, blockquote, h1, h2, h3, h4, h5, h6, li, figcaption";
/** container child tags eligible for the structural listing bonus */
const ROW_ITEM_TAGS = new Set(["A", "LI", "TR", "DD", "DT", "DIV", "ARTICLE", "SECTION", "P", "SPAN"]);
const CANDIDATE_TAGS = new Set(["div", "section", "article", "main", "body"]);

/** Is this node inside any boilerplate/hidden/ad subtree? (walks ancestors) */
function inBoilerplate(el: Element): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (isHidden(cur) || isAd(cur)) return true;
    const tag = cur.tagName.toLowerCase();
    if (BOILERPLATE_TAGS.has(tag)) return true;
    const role = getRole(cur);
    if (role && BOILERPLATE_ROLES.has(role)) return true;
    const sig = ((cur.className || "") + " " + (cur.id || "")).toLowerCase();
    if (/\b(sidebar|breadcrumb|site-header|site-footer|topbar|navbar|mega-menu|skip-link|cookie|consent|paywall|signup-modal)\b/.test(sig)) return true;
  }
  return false;
}

function linkDensityOf(el: Element): number {
  const text = (el.textContent || "").trim();
  if (!text.length) return 0;
  let linkText = 0;
  for (const a of el.querySelectorAll("a")) linkText += (a.textContent || "").trim().length;
  return linkText / text.length;
}

interface Candidate { el: Element; score: number; }

function findMainContent(doc: Document, rootOverride?: Element): Element {
  const body = rootOverride || doc.body || doc.querySelector("main") || doc.documentElement;

  // ---- Phase 1: semantic shortcut — exactly one <article> holding the page.
  // Blogs/docs wrap their post in a single <article>; when present and
  // substantial, it IS the content. Multiple <article>s = index page: skip.
  const articles = Array.from(doc.querySelectorAll("article"));
  const liveArticles = articles.filter((a) => !inBoilerplate(a));
  const bodyLen = (body.textContent || "").trim().length;
  if (liveArticles.length === 1 && bodyLen > 200) {
    const len = (liveArticles[0].textContent || "").trim().length;
    if (len >= bodyLen * 0.3 && linkDensityOf(liveArticles[0]) < 0.5) return liveArticles[0];
  }

  // ---- Phase 2: accumulate prose scores from leaves upward.
  const scores = new Map<Element, number>();
  for (const leaf of doc.querySelectorAll(CONTENT_LEAF_SEL)) {
    if (inBoilerplate(leaf)) continue;
    const text = (leaf.textContent || "").trim();
    if (text.length < 40) continue;
    // Prose signals: length, punctuation density.
    // Headings are frequently legitimate pure links (index/blog teasers);
    // only apply the nav-killing link-density penalty to non-heading prose.
    const commas = (text.match(/[,\u3001\u3002.;\uFF1B]/g) || []).length;
    let s = 1 + commas + Math.min(Math.floor(text.length / 100), 10);
    const isHeading = /^h[1-6]$/.test(leaf.tagName.toLowerCase());
    const ld = linkDensityOf(leaf);
    if (ld > 0.8 && !isHeading) continue;
    if (ld > 0.25 && !isHeading) s *= 1 - ld * 0.9;

    let factor = 1;
    for (let anc: Element | null = leaf.parentElement; anc; anc = anc.parentElement) {
      scores.set(anc, (scores.get(anc) || 0) + s * factor);
      factor *= 0.7;
      if (factor < 0.05) break;
    }
  }

  // ---- Phase 2b: structural signal — indices/listing pages often express
  // content as rows of substantial links (post tables, card grids, archive
  // lists) with no qualifying prose at all. Reward containers holding MANY
  // uniform-ish entries that each carry real link text.
  for (const parent of doc.querySelectorAll("ul, ol, table, dl, div")) {
    if (inBoilerplate(parent)) continue;
    const kids = Array.from(parent.children);
    if (kids.length < 4) continue;
    const tags = new Set(kids.map((k) => k.tagName));
    if (tags.size !== 1) continue;
    const t0 = tags.values().next().value as string;
    if (!ROW_ITEM_TAGS.has(t0)) continue;
    let linked = 0;
    for (const k of kids) {
      const a = k.matches("a") ? k : k.querySelector("a");
      const len = ((a && a.textContent) || "").trim().length;
      if (len >= 8 && len <= 300) linked++;
    }
    if (linked < Math.max(4, Math.ceil(kids.length * 0.6))) continue;
    const bonus = Math.min((linked * linked) / 4 + 4, 150);
    let bf = 1;
    for (let anc: Element | null = parent.parentElement; anc; anc = anc.parentElement) {
      scores.set(anc, (scores.get(anc) || 0) + bonus * bf);
      bf *= 0.7;
      if (bf < 0.05) break;
    }
  }
  if (scores.size === 0) {
    return doc.querySelector("article") || body;
  }

  // ---- Phase 3: keep container candidates, apply small structural priors.
  const cands: Candidate[] = [];
  for (const [el, raw] of scores) {
    const tag = el.tagName.toLowerCase();
    if (!CANDIDATE_TAGS.has(tag)) continue;
    let sc = raw;
    if (tag === "article") sc *= 1.3;
    else if (tag === "main") sc *= 1.15;
    const sig = ((el.className || "") + " " + (el.id || "")).toLowerCase();
    if (/\b(article|post|entry|story|blog|prose|markdown|content)\b/.test(sig)) sc *= 1.25;
    cands.push({ el, score: sc });
  }
  if (!cands.length) return body;
  cands.sort((a, b) => b.score - a.score);

  // ---- Phase 4: trim outer husk — descend while one child keeps >=80% of the
  // parent's accumulated score (drop empty wrappers around the content).
  let best = cands[0].el;
  for (;;) {
    const own = scores.get(best) || 0;
    let topKid: Element | null = null;
    let topScore = 0;
    for (const kid of best.children) {
      const s = scores.get(kid) || 0;
      if (s > topScore) { topScore = s; topKid = kid; }
    }
    if (!topKid || topScore < own * 0.8) break;
    const t = topKid.tagName.toLowerCase();
    if (t === "tbody" || t === "tr" || t === "thead" || t === "td") break; // stay above table internals
    best = topKid;
  }
  return best;
}

function cleanTree(root: Element): void {
  const removeSels = ["script", "style", "noscript", "iframe", "object", "embed", "svg", "math", "template", "slot"];
  for (const sel of removeSels) {
    for (const el of root.querySelectorAll(sel)) el.remove();
  }
  for (const el of root.querySelectorAll("nav, footer, aside")) el.remove();
  root.querySelectorAll(
    "[role=\"navigation\"],[role=\"banner\"],[role=\"contentinfo\"],[role=\"complementary\"],[role=\"search\"]",
  ).forEach((el) => el.remove());
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (isHidden(el) || isAd(el)) el.remove();
  }
}

function resolveAllUrls(root: Element, base: string): void {
  root.querySelectorAll("a[href], img[src]").forEach((el) => {
    const attr = el.tagName === "A" ? "href" : "src";
    const href = el.getAttribute(attr);
    if (!href || href.startsWith("data:") || href.startsWith("blob:")) return;
    try {
      el.setAttribute(attr, new URL(href, base).href);
    } catch {
      /* keep original */
    }
  });
}

// ==========================================================================
// HTML Element → Markdown
// ==========================================================================

function escapeMd(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`");
}

function isInsideBlock(el: Element): boolean {
  let cur: Element | null = el;
  while (cur) {
    if (BLOCK_TAGS.has(cur.tagName.toLowerCase())) return true;
    cur = cur.parentElement;
  }
  return false;
}

function inlineText(el: Element): string {
  let result = "";
  for (const child of el.childNodes) {
    if (child.nodeType === 3) {
      const t = child.textContent!.trim();
      if (t) result += (isInsideBlock(el) ? t + " " : escapeMd(t) + " ");
    } else if (child.nodeType === 1) {
      const ce = child as Element;
      if (BLOCK_TAGS.has(ce.tagName.toLowerCase())) {
        // Block inside inline context (e.g. whole-card <a><h2>Title</h2></a>):
        // keep its flat text — dropping it would erase card-link labels entirely.
        const t = ce.textContent!.trim();
        if (t) result += t + " ";
        continue;
      }
      result += nodeToMd(ce, "markdown", 0);
    }
  }
  return result;
}

/**
 * Layout tables (contain nested tables or block elements) should be recursively
 * unwrapped, not rendered as markdown data tables.
 */
function isLayoutTable(el: Element): boolean {
  if (el.querySelector("table")) return true;
  return el.querySelectorAll("ul, ol, dl, blockquote, pre, h1, h2, h3, h4, h5, h6").length > 0;
}

function nodeToMd(el: Element, format: "markdown" | "text", indent: number): string {
  const tag = el.tagName.toLowerCase();

  if (/^h[1-6]$/.test(tag)) {
    const level = parseInt(tag[1]);
    const text = inlineText(el).trim();
    return text ? "\n\n" + "#".repeat(level) + " " + text + "\n\n" : "";
  }

  if (tag === "p") {
    const text = inlineText(el).trim();
    return text ? "\n" + text + "\n\n" : "";
  }

  if (tag === "strong" || tag === "b") {
    const t = inlineText(el).trim();
    return t ? (format === "text" ? t : "**" + t + "**") : "";
  }
  if (tag === "em" || tag === "i") {
    const t = inlineText(el).trim();
    return t ? (format === "text" ? t : "*" + t + "*") : "";
  }

  if (tag === "code" && el.parentElement?.tagName?.toLowerCase() !== "pre") {
    const t = (el.textContent || "").trim();
    return t ? (format === "text" ? t : "`" + t + "`") : "";
  }

  if (tag === "pre") {
    const codeEl = el.querySelector("code");
    const raw = (codeEl || el).textContent!.trim();
    let lang = "";
    if (codeEl) {
      const m = (codeEl.className || "").match(/(?:language-|lang-|hljs\s+)([\w+#-]+)/);
      if (m) lang = m[1];
    }
    if (format === "text") return "\n\n" + raw + "\n\n";
    return "\n\n```" + lang + "\n" + raw + "\n```\n\n";
  }

  if (tag === "a") {
    const text = inlineText(el).trim();
    const href = el.getAttribute("href") || "";
    if (!text) return "";
    if (format === "text") return text;
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return text;
    return "[" + text + "](" + href + ")";
  }

  if (tag === "img") {
    const alt = el.getAttribute("alt") || "";
    const src = el.getAttribute("src") || "";
    if (!src) return "";
    if (format === "text") return alt ? "[image: " + alt + "]" : "[image]";
    return "![" + alt + "](" + src + ")";
  }

  if (tag === "br") return "\n";
  if (tag === "hr") return "\n\n---\n\n";

  if (tag === "blockquote") {
    const inner = childrenMd(el, format, indent).trim();
    return "\n\n" + inner.split("\n").map((l) => "> " + l).join("\n") + "\n\n";
  }

  if (tag === "ul") return renderList(el, format, indent, false);
  if (tag === "ol") return renderList(el, format, indent, true);
  if (tag === "li") return "\n- " + childrenMd(el, format, indent).trim() + "\n";

  if (tag === "table") {
    if (isLayoutTable(el)) return childrenMd(el, format, indent);
    const tableMd = renderTable(el, format);
    return tableMd || childrenMd(el, format, indent);
  }

  if (tag === "details") {
    const sumEl = el.querySelector(":scope > summary");
    const sumText = sumEl ? inlineText(sumEl).trim() : "Details";
    const restParts: string[] = [];
    for (const c of el.children) {
      if (c === sumEl) continue;
      if (c instanceof Element) {
        const md = childrenMd(c, format, indent).trim();
        if (md) restParts.push(md);
      }
    }
    const rest = restParts.join("\n");
    if (format === "text") return "\n" + sumText + ":\n" + rest + "\n";
    return "\n**<details>" + sumText + "</details>**\n" + rest + "\n";
  }
  if (tag === "summary") return inlineText(el);

  if (tag === "dl") return childrenMd(el, format, indent);
  if (tag === "dt") {
    const t = inlineText(el).trim();
    return format === "text" ? "\n" + t + "\n" : "\n**" + t + "**\n";
  }
  if (tag === "dd") {
    const t = childrenMd(el, format, indent).trim();
    return ": " + t + "\n\n";
  }

  if (tag === "del") {
    const t = inlineText(el).trim();
    return format === "text" ? t : "~~" + t + "~~";
  }
  if (tag === "ins") {
    const t = inlineText(el).trim();
    return format === "text" ? t : "<ins>" + t + "</ins>";
  }
  if (tag === "sup") {
    const t = inlineText(el).trim();
    return format === "text" ? t : "<sup>" + t + "</sup>";
  }
  if (tag === "sub") {
    const t = inlineText(el).trim();
    return format === "text" ? t : "<sub>" + t + "</sub>";
  }

  return childrenMd(el, format, indent);
}

function childrenMd(el: Element, format: "markdown" | "text", indent: number): string {
  const parts: string[] = [];
  for (const c of el.childNodes) {
    if (c.nodeType === 3) {
      // Text node: include if non-whitespace
      const t = c.textContent!.trim();
      if (t) parts.push(format === "text" ? t : escapeMd(t) + " ");
    } else if (c.nodeType === 1) {
      const md = nodeToMd(c as Element, format, indent);
      if (md) parts.push(md);
    }
  }
  return parts.join("");
}

function renderList(el: Element, format: "markdown" | "text", indent: number, ordered: boolean): string {
  const items: string[] = [];
  let idx = 1;
  for (const li of el.querySelectorAll(":scope > li")) {
    const pad = "  ".repeat(indent);
    const prefix = ordered ? idx + ". " : "- ";
    idx++;
    const inline: string[] = [];
    const nested: Element[] = [];
    for (const c of li.children) {
      if (c.nodeType === 3) {
        const t = c.textContent!.trim();
        if (t) inline.push(format === "text" ? t : escapeMd(t));
      } else if (c instanceof Element) {
        if (c.tagName === "UL" || c.tagName === "OL") nested.push(c);
        else {
          const md = nodeToMd(c, format, indent).trim();
          if (md) inline.push(md);
        }
      }
    }
    const body = inline.join(" ").trim();
    items.push(body ? "\n" + pad + prefix + body : "\n" + pad + prefix);
    for (const n of nested) {
      items.push(renderList(n, format, indent + 1, n.tagName === "OL"));
    }
  }
  return items.join("") + "\n";
}

function renderTable(el: Element, format: "markdown" | "text"): string {
  const rows: { cells: string[]; isHeader: boolean }[] = [];
  // Use childrenMd (recurses into nested tables/lists) then flatten — inlineText skips BLOCK
  // children like <table>, which breaks layout-table sites such as Hacker News.
  const cellText = (c: Element) =>
    childrenMd(c, format, 0).trim().replace(/[ \t]*\n+[ \t]*/g, " ").replace(/\|/g, "\\|");
  for (const section of ["thead", "tbody", "tfoot"]) {
    for (const tr of el.querySelectorAll(":scope > " + section + " > tr")) {
      rows.push({
        cells: Array.from(tr.querySelectorAll(":scope > th, :scope > td")).map(cellText),
        isHeader: section === "thead",
      });
    }
  }
  if (!rows.length && el.querySelector(":scope > tr")) {
    for (const tr of el.querySelectorAll(":scope > tr")) {
      const cells = Array.from(tr.children)
        .filter((c) => c.tagName === "TH" || c.tagName === "TD")
        .map(cellText);
      if (cells.length) rows.push({ cells, isHeader: false });
    }
  }
  // Drop spacer / empty rows (e.g. Hacker News layout tables)
  const nonEmpty = rows.filter((r) => r.cells.some((c) => c.trim().length > 0));
  if (!nonEmpty.length) return "";
  const maxC = Math.max(...nonEmpty.map((r) => r.cells.length));
  const lines: string[] = [];
  for (let i = 0; i < nonEmpty.length; i++) {
    const r = nonEmpty[i];
    while (r.cells.length < maxC) r.cells.push("");
    lines.push("| " + r.cells.join(" | ") + " |");
    if (i === 0) lines.push("| " + r.cells.map(() => "---").join(" | ") + " |");
  }
  return "\n\n" + lines.join("\n") + "\n\n";
}

// ==========================================================================
// Truncation
// ==========================================================================

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const total = [...text].length;
  if (total <= maxChars) return { text, truncated: false };
  let result = "";
  let count = 0;
  for (const ch of text) {
    if (count >= maxChars) break;
    result += ch;
    count++;
  }
  return {
    text: result +
      "\n\n[Content truncated: showing " + maxChars + " of " + total +
      " characters. Call web_reader_local again with a larger maxChars to fetch the remaining content.]",
    truncated: true,
  };
}

// ==========================================================================
// Main pipeline
// ==========================================================================

/**
 * Guarantee a usable content root. Minimal/hand-written pages may omit the
 * html/head/body skeleton entirely (e.g. danluu.com), leaving top-level
 * elements orphaned outside any <body>. Reparent everything under one
 * synthetic <main> so every downstream stage has a single subtree to walk.
 */
function ensureContentRoot(doc: Document): Element {
  const body = doc.body;
  if (body && (body.textContent || "").trim().length > 0) return body;
  const wrap = doc.createElement("main");
  while (doc.firstChild) wrap.appendChild(doc.firstChild);
  doc.appendChild(wrap);
  return wrap;
}

async function readPage(url: string, format: "markdown" | "text", maxChars: number, signal?: AbortSignal) {
  const { html, finalUrl, status } = await fetchHtml(url, signal);
  log("fetched", finalUrl, "status", status, "html length", html.length);

  const { document: doc } = parseHTML(html);

  let title = "";
  const titleEl = doc.querySelector("title");
  if (titleEl) {
    const raw = (titleEl.textContent || "").trim();
    title = raw.replace(/\s*[{(].*$/s, "").replace(/\s*<.*/, "").trim() || raw.split(/[({<]/)[0].trim();
  }

  const contentRoot = ensureContentRoot(doc);
  const mainEl = findMainContent(doc, contentRoot);
  cleanTree(mainEl);
  resolveAllUrls(mainEl, finalUrl);

  const md = nodeToMd(mainEl, format, 0)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim();

  const { text: body, truncated } = truncateText(md, maxChars);

  const headerParts: string[] = [];
  if (title) headerParts.push("Title: " + title);
  headerParts.push("URL: " + finalUrl);
  headerParts.push("HTTP: " + status);
  if (truncated) headerParts.push("[truncated]");
  return { result: headerParts.join("\n") + "\n\n" + body, title, finalUrl, status, truncated };
}

// ==========================================================================
// Extension
// ==========================================================================

export default function webReaderLocalExtension(pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    try {
      const active = pi.getActiveTools();
      if (active.length > 0 && !active.includes("web_reader_local"))
        pi.setActiveTools([...active, "web_reader_local"]);
    } catch {
      /* ignore */
    }
  });

  pi.registerTool({
    name: "web_reader_local",
    label: "Web Reader (Local)",
    description:
      "Locally fetch and convert a URL to markdown/text. No API key required — fetches HTML directly, " +
      "extracts the main content (strips navigation, ads, scripts, styles), and converts to clean Markdown. " +
      "Works well for most static and server-rendered pages. For JS-heavy SPAs or bot-blocking sites, " +
      "use web_reader_spa instead. Long pages are truncated to maxChars (default 50000).",
    promptSnippet: "Fetch and read a web page locally (no API key needed)",
    promptGuidelines: [
      "Use web_reader_local as a free, no-API-key alternative to web_reader for fetching web page content.",
      "Works best for static pages, blog posts, documentation, news articles, and server-rendered content.",
      "For JavaScript-heavy SPAs, pages behind bot-protection, or login walls, use web_reader_spa instead.",
      "Long pages are truncated by default (50000 chars). If important content is missing, re-call with a larger maxChars.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch and read" }),
      format: Type.Optional(
        Type.Union([Type.Literal("markdown"), Type.Literal("text")]),
      ),
      maxChars: Type.Optional(
        Type.Integer({
          description: "Maximum number of characters to return (default 50000).",
          minimum: 1000,
          maximum: 1_000_000,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      type Details = { url?: string; title?: string; status?: number; truncated?: boolean; source?: string; error?: string };
      const p = params as { url: string; format?: string; maxChars?: number };
      const url = p.url?.trim();
      if (!url) {
        return { content: [{ type: "text", text: "Error: `url` is required." }], isError: true, details: { error: "missing url" } as Details };
      }
      if (!/^https?:\/\//i.test(url)) {
        return { content: [{ type: "text", text: "Error: URL must start with http:// or https://" }], isError: true, details: { url, error: "invalid protocol" } as Details };
      }

      const format: "markdown" | "text" = p.format === "text" ? "text" : "markdown";
      const maxChars = p.maxChars ?? 50000;

      try {
        const result = await readPage(url, format, maxChars, signal);
        return {
          content: [{ type: "text", text: result.result }],
          details: { url: result.finalUrl, title: result.title, status: result.status, truncated: result.truncated, source: "local-fetch" } as Details,
        };
      } catch (e) {
        const msg = (e as Error).message || String(e);
        return { content: [{ type: "text", text: "Error fetching page: " + msg }], isError: true, details: { url, error: msg } as Details };
      }
    },
  });
}
