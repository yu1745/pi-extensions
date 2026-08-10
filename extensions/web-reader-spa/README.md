# web-reader-spa

A **pi extension** that adds a `web_reader_spa` tool: a SPA-aware, anti-WAF companion to the
backed by the [Playwright](https://playwright.dev) library driving a **real browser**.

It is a drop-in upgrade for the built-in `web_reader` when a page is a JavaScript
single-page app, renders content dynamically, or blocks plain HTTP clients (Cloudflare
and similar WAFs).

## Why

| | built-in `web_reader` | `web_reader_spa` |
|---|---|---|
| Renders JS / SPA | ❌ raw HTML only | ✅ full browser render |
| User-Agent | default client UA → blocked by WAFs | spoofed real-browser UA + stealth patches |
| `navigator.webdriver` | n/a | patched out |
| Extraction source | HTML parsing | **Playwright ARIA accessibility snapshot** (same as `playwright-cli`) |
| Hidden/hover UI | leaks into output | excluded by the a11y tree |
| Returns | markdown | markdown / text / aria YAML / html / screenshot |

The browser is launched **in-process** (no subprocess, no `.cmd`/shell issues on
Windows). It prefers your **installed Chrome or Edge** (genuine fingerprint) and falls
back to the bundled headless shell.

## Install

```bash
pi install git:github.com/yu1745/pi-web-reader-spa
# or: pi install https://github.com/yu1745/pi-web-reader-spa

# ⚠️ REQUIRED — install the browser binary:
cd ~/.pi/agent/git/github.com/yu1745/pi-web-reader-spa && npx playwright install chromium
```

> **Why the second step is needed:** `pi install` runs `npm install`, which installs the
> Playwright **library** but does **not** download the Chromium binary — npm 7+ skips
> dependencies' `postinstall` scripts (where Playwright's browser download lives), so the
> ~150 MB browser must be fetched with `npx playwright install chromium`. If you skip it,
> the first `web_reader_spa` call fails with a clear message showing the exact command to run.
>
> Better for anti-detection: install a **real** Chrome or Edge on the system. The extension
> prefers it over the bundled Chromium (genuine fingerprint) — see
> `PI_WEBREADER_CHANNEL` below.

`pi` auto-loads the extension. Run `/reload` inside pi (or restart) after installing.
The first call downloads/launches the browser (~1–2s cold start), then the browser
stays resident for the session.

`pi` auto-discovers the extension from `~/.pi/agent/extensions/web-reader-spa/index.ts`.
Run `/reload` inside pi (or restart) to load it.

## The `web_reader_spa` tool

| parameter | type | default | description |
|---|---|---|---|
| `url` | string | — | URL to render (`http(s)://...`; protocol auto-added) |
| `format` | `markdown`\|`text`\|`aria`\|`html` | `markdown` | output format (`aria` = raw playwright-cli-style YAML) |
| `selector` | string | auto | CSS selector to extract only a subtree |
| `waitUntil` | `load`\|`domcontentloaded`\|`networkidle` | `domcontentloaded` | goto wait strategy |
| `waitSelector` | string | — | extra: wait for this CSS to appear |
| `extraWaitMs` | number | — | extra fixed wait after network idle (lazy content) |
| `timeoutMs` | number | `45000` | navigation timeout |
| `screenshot` | boolean | `false` | capture a PNG (saved to the OS temp dir; the **path** is returned) |
| `inlineImage` | boolean | `false` | also return the screenshot as an inline base64 image block (for multimodal models). Default off — feed the returned path to `analyze_image` instead |
| `fullPage` | boolean | `false` | full-page screenshot |
| `maxChars` | number | `60000` | cap returned text/markdown length |

Returns: a header (`URL / Title / HTTP status / Browser` + `Screenshot` path if any) + the
content. Screenshots are written to the **OS temp dir** (`os.tmpdir()/pi-web-reader-spa/`)
so the OS reclaims them on reboot / disk cleanup — the extension does **not** manage its
own cleanup (a rolling window could delete files still referenced mid-conversation). By
default no base64 is inlined (keeps the session lean); set `inlineImage: true` if your model
reads inline images. The extension also appends a fallback hint to the built-in `web_reader`'s
own description, so when `web_reader` can't render a JS/SPA page the model is told to retry with
`web_reader_spa`.

## Configuration (env vars)

| var | default | purpose |
|---|---|---|
| `PI_WEBREADER_UA` | recent Windows Chrome | override User-Agent |
| `PI_WEBREADER_LOCALE` | `zh-CN` | locale + `Accept-Language` base |
| `PI_WEBREADER_HEADED` | `0` | `1` to show the browser window |
| `PI_WEBREADER_CHANNEL` | `chrome,msedge,chromium` | ordered browser channels (`chromium` = bundled shell) |
| `PI_WEBREADER_CDP` | — | connect to a **real** running browser, e.g. `http://localhost:9222` (strongest anti-detection; see below) |
| `PI_WEBREADER_MAXURL` | `120` | drop URLs longer than this from markdown (kills ad/tracking links) |
| `PI_WEBREADER_DEBUG` | `0` | `1` prints stderr logs |

Set these in your shell environment or pi's `settings.json` `env`.

## Anti-WAF strategy

1. **Real browser channel** — launches your installed Chrome/Edge, so the TLS/HTTP/JS
   fingerprint is genuine (not Playwright's bundled Chromium).
2. **Spoofed UA** — a realistic up-to-date Chrome UA instead of `HeadlessChrome`.
3. **Stealth init script** (injected on every page) — sets `navigator.webdriver =
   undefined`, patches `navigator.languages` / `plugins`, adds `window.chrome`, fixes
   `permissions.query`, and spoofs the WebGL vendor.
4. **Launch flags** — `--disable-blink-features=AutomationControlled` (removes the
   automation signal) and disables site isolation.

This clears most WAFs that block the default Playwright/`web_reader` fingerprint. For the
hardest cases (Cloudflare Enterprise "Turnstile" challenges), launch your own Chrome with
remote debugging and connect the extension to it:

```bash
# start your real Chrome with debugging
chrome --remote-debugging-port=9222
# tell the extension to use it
export PI_WEBREADER_CDP=http://localhost:9222
```

A 100% real user profile + fingerprint is essentially indistinguishable from a human.

## Behavior notes

- One browser + one context is kept alive for the session (cookies persist, helps with
  challenge cookies); a new page is opened per call so concurrent calls don't collide.
- The browser is closed automatically on `session_shutdown` (for CDP it disconnects,
  leaving your real browser running).
- **Extraction = `page.ariaSnapshot()`** (Playwright's ARIA accessibility snapshot, the
  same data `playwright-cli`/Playwright MCP use). The accessibility tree inherently skips
  `display:none`/`visibility:hidden`/`aria-hidden` nodes, so hover menus and "not
  interested"-style clutter never leak in. The YAML is parsed in-Node and rendered to
  Markdown (headings, links, lists, text). Long URLs (> `PI_WEBREADER_MAXURL`, typically
  ads/trackers) are dropped to keep output lean. Pass `format: "aria"` for the raw
  playwright-cli-style YAML.
- Very large pages may be truncated by Playwright's internal snapshot node cap.

## How the agent uses it

This extension also appends a fallback hint to the built-in `web_reader`'s own tool
description, so the agent automatically reaches for `web_reader_spa` when `web_reader`
fails on a page — no manual switching needed. Triggers for the fallback:

- empty / garbled output, or just a JS shell/skeleton (e.g. `<div id=root>`)
- a login/bot interstitial with no real content
- **low-readability output** — a raw table dumped as rows of `| | |`, huge base64 blobs,
  mostly metadata/boilerplate with no real body, or anything that needs human cleanup

## Example

```
> 抓一下 weibo.com 首页的热搜和正文

(web_reader returns only the JS shell — triggers fallback)
(web_reader_spa renders the page and returns the full feed + hot-search ranking)
```

Real-world pages verified: weibo.com, xiaohongshu.com/explore, douyin.com, bilibili.com —
all return real content (login-wall overlays are bypassed because the feed renders behind
the modal and the ARIA tree captures both layers).
