/**
 * Integration test: drives the REAL extensions/web-reader/cloudflare.ts against a live
 * Cloudflare-protected page, using the same Playwright launch path as web_reader.
 *
 * Run:  node tests/web-reader-cloudflare.integration.mjs [url]
 * Requires: network access, a Jev API key in ~/.pi/agent/auth.json, xvfb for headed mode.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const piRequire = createRequire(
  "/home/wangyu/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/index.js",
);
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);

const { handleCloudflareChallenge } = await jiti.import(
  "../extensions/web-reader/cloudflare.ts",
);
const { createJevClient } = await jiti.import("../extensions/shared/jev/client.ts");

const url = process.argv[2] || "https://linux.do/t/topic/2770639/11";
const KEY = JSON.parse(readFileSync("/home/wangyu/.pi/agent/auth.json", "utf8"))["typesafe-jev"].key;
const jev = createJevClient({ apiKey: KEY });

// Mirror web-reader's real launch path (LAUNCH_ARGS from index.ts).
const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process,AutomationControlled",
  "--disable-infobars",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
];
// The plugin now defaults to NO UA spoofing and NO stealth patches (both were found to
// break the Cloudflare challenge). Env toggles are kept so the A/B can be reproduced.
const SPOOF_UA = process.env.TEST_SPOOF_UA === "1";
const STEALTH = process.env.TEST_STEALTH === "1";
// Bundled Playwright Chromium only — the plugin never uses a system browser.
const CHANNEL = "bundled";
const HEADLESS = process.env.TEST_HEADLESS === "1";

function stealthInit() {
  try { Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true }); } catch {}
  try { Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en-US", "en"], configurable: true }); } catch {}
  try {
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5].map((i) => ({ name: "Plugin " + i, filename: "np" + i + ".dll" })),
      configurable: true,
    });
  } catch {}
  try { const w = window; w.chrome = w.chrome || { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} }; } catch {}
}

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// Bundled Playwright chromium, mirroring web-reader's single launch path.
const browser = await chromium.launch({ headless: HEADLESS, args: LAUNCH_ARGS });
const context = await browser.newContext({
  locale: "zh-CN",
  viewport: { width: 1920, height: 1080 },
  extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
  ...(SPOOF_UA
    ? {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      }
    : {}),
});
if (STEALTH) await context.addInitScript(stealthInit);
log(`config: bundled-chromium headless=${HEADLESS} spoofUA=${SPOOF_UA} stealth=${STEALTH}`);
const page = await context.newPage();

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
} catch (e) {
  log("goto threw:", e.message.split("\n")[0]);
}
log("loaded; title =", JSON.stringify(await page.title()));

const outcome = await handleCloudflareChallenge({
  page,
  context,
  url,
  jev,
  log,
});
log("outcome:", JSON.stringify(outcome));

const title = await page.title();
const text = await page.evaluate(() => document.body?.innerText || "");
log(`final title = ${JSON.stringify(title)}  bodyLen = ${text.length}`);
log("excerpt:", text.slice(0, 180).replace(/\n/g, " | "));

await browser.close();

// Exit code encodes the contract: solved OR legitimately not-a-challenge.
const pass = outcome.solved || !outcome.detected;
console.log(pass ? "\nRESULT: PASS" : "\nRESULT: FAIL");
process.exit(pass ? 0 : 1);
