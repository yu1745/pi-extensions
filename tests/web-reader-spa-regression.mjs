/**
 * Regression test: the Cloudflare branch must NOT fire on ordinary SPA / SSR pages,
 * and content extraction must still work.
 *
 * The main risk introduced by the challenge branch is a false positive in its pre-gate:
 * if `looksLikeChallenge()` returns true for a normal page, we burn Jev calls, add latency,
 * and may even click something on a site that has no challenge at all.
 *
 * Drives the REAL extensions/web-reader/cloudflare.ts (not a copy).
 *
 * Run: node tests/web-reader-spa-regression.mjs
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const piRequire = createRequire(
  "/home/wangyu/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/index.js",
);
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { handleCloudflareChallenge } = await jiti.import("../extensions/web-reader/cloudflare.ts");
const { createJevClient } = await jiti.import("../extensions/shared/jev/client.ts");

const KEY = JSON.parse(readFileSync("/home/wangyu/.pi/agent/auth.json", "utf8"))["typesafe-jev"].key;

// Count Jev calls so we can assert the pre-gate short-circuits before spending any.
let jevCalls = 0;
const realJev = createJevClient({ apiKey: KEY });
const jev = {
  version: realJev.version,
  async evaluate(req, opts) {
    jevCalls++;
    return realJev.evaluate(req, opts);
  },
};

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process,AutomationControlled",
  "--disable-infobars",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
];

const SITES = [
  { name: "vuejs docs (SPA, VitePress)", url: "https://vuejs.org/guide/introduction.html", min: 1500 },
  { name: "react.dev (SPA, Next.js)", url: "https://react.dev/learn", min: 1500 },
  { name: "svelte docs (SvelteKit SSR)", url: "https://svelte.dev/docs/svelte/overview", min: 1000 },
  { name: "excalidraw (heavy client-side app)", url: "https://excalidraw.com", min: 50 },
  { name: "MDN JS guide (SSR)", url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript", min: 2000 },
  { name: "Hacker News (static)", url: "https://news.ycombinator.com", min: 1500 },
  { name: "tailwind docs (Next.js)", url: "https://tailwindcss.com/docs/installation", min: 1000 },
];

const browser = await chromium.launch({ headless: false, args: LAUNCH_ARGS });
const results = [];

for (const site of SITES) {
  const before = jevCalls;
  const t0 = Date.now();
  let ok = true;
  const notes = [];
  let context;
  try {
    context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1920, height: 1080 },
      extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    });
    const page = await context.newPage();
    try {
      await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e) {
      notes.push(`goto: ${e.message.split("\n")[0]}`);
    }
    // Give client-side hydration a moment, mirroring the extension's flow.
    await page.waitForTimeout(1200);

    const bodyLen = await page.evaluate(() => (document.body?.innerText || "").trim().length);
    const title = await page.title();

    const outcome = await handleCloudflareChallenge({ page, context, url: site.url, jev, log: () => {} });
    const spent = jevCalls - before;

    // Regression assertions
    if (outcome.detected) {
      ok = false;
      notes.push(`FALSE POSITIVE: detected=true (state=${outcome.state}, reason=${outcome.reason})`);
    }
    if (spent > 0) {
      ok = false;
      notes.push(`wasted ${spent} Jev call(s) on a non-challenge page`);
    }
    if (bodyLen < site.min) {
      ok = false;
      notes.push(`thin content: bodyLen=${bodyLen} < ${site.min}`);
    }

    // Content extraction (ARIA snapshot) must still work.
    let ariaLen = 0;
    try {
      ariaLen = (await page.ariaSnapshot({ timeout: 10000 })).length;
    } catch (e) {
      ok = false;
      notes.push(`ariaSnapshot failed: ${e.message.split("\n")[0]}`);
    }
    if (ariaLen < 200) {
      ok = false;
      notes.push(`thin aria: ${ariaLen}`);
    }

    results.push({ site: site.name, ok, ms: Date.now() - t0, jevCalls: spent, bodyLen, ariaLen, title, notes });
  } catch (e) {
    results.push({ site: site.name, ok: false, ms: Date.now() - t0, jevCalls: jevCalls - before, notes: [`threw: ${e.message.split("\n")[0]}`] });
  } finally {
    await context?.close().catch(() => {});
  }
}

await browser.close();

console.log("\n=== SPA regression results ===");
let failures = 0;
for (const r of results) {
  if (!r.ok) failures++;
  console.log(
    `${r.ok ? "PASS" : "FAIL"}  ${r.site.padEnd(36)} ${String(r.ms).padStart(5)}ms  ` +
      `jev=${r.jevCalls}  bodyLen=${r.bodyLen ?? "-"}  aria=${r.ariaLen ?? "-"}`,
  );
  for (const n of r.notes || []) console.log(`        - ${n}`);
}
console.log(`\n${results.length - failures}/${results.length} passed; total Jev calls: ${jevCalls}`);
process.exit(failures === 0 ? 0 : 1);
