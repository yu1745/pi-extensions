import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Like Pi, load the source-only OAuth/helper boundary through a TS-aware loader.
const peers = ["@earendil-works/pi-ai", "@earendil-works/pi-ai/compat", "@earendil-works/pi-tui", "typebox"];
const jiti = createJiti(import.meta.url, {
  alias: Object.fromEntries(peers.map((name) => [name, fileURLToPath(import.meta.resolve(name))])),
});
const antigravity = await jiti.import("../bundle/antigravity.js", { default: true });
const webSearch = await jiti.import("../bundle/web-search.js", { default: true });

const root = new URL("../", import.meta.url);

function capture() {
  const providers = new Map();
  const commands = new Map();
  const tools = new Map();
  const events = new Map();
  const renderers = new Map();
  const entries = [];
  return {
    providers, commands, tools, events, renderers, entries,
    api: {
      registerProvider: (id, config) => providers.set(id, config),
      registerCommand: (name, config) => commands.set(name, config),
      registerTool: (config) => tools.set(config.name, config),
      registerEntryRenderer: (name, renderer) => renderers.set(name, renderer),
      on: (name, handler) => events.set(name, handler),
      appendEntry: (name, data) => entries.push({ name, data }),
    },
  };
}

test("package discovers each compiled entry exactly once and ships bundles", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  for (const name of ["antigravity", "web-search"]) {
    assert.equal(pkg.pi.extensions.filter((entry) => entry === `bundle/${name}.js`).length, 1);
    assert.ok(!pkg.pi.extensions.includes(`extensions/${name}/index.ts`));
  }
  assert.ok(pkg.files.includes("bundle"));
});

test("compiled entries retain shared helpers in source and do not duplicate OAuth constants", async () => {
  const sources = await Promise.all(["antigravity", "web-search"].map((name) =>
    readFile(new URL(`bundle/${name}.js`, root), "utf8")));
  const shared = sources.map((source) => [...source.matchAll(/from "(\.\/chunk-[^"\n]+\.js)"/g)].map((match) => match[1]));
  assert.ok(shared[0].some((path) => shared[1].includes(path)));
  const files = await readdir(new URL("bundle/", root));
  const all = await Promise.all(files.map((file) => readFile(new URL(`bundle/${file}`, root), "utf8")));
  assert.doesNotMatch(all.join("\n"), /(?:let|var) dispatcherPromise|CLIENT_SECRET|CLIENT_ID/);
  assert.ok(all.some((source) => source.includes("extensions/antigravity/auth/")));
  assert.ok(all.some((source) => source.includes("extensions/antigravity/client/")));
  assert.match(all.join("\n"), /from "@earendil-works\/pi-ai/);
});

test("bundled provider preserves OAuth, model registration and deferred transcript entries", async () => {
  const old = process.env.ANTIGRAVITY_NO_PREWARM;
  process.env.ANTIGRAVITY_NO_PREWARM = "1";
  try {
    const h = capture();
    antigravity(h.api);
    const provider = h.providers.get("antigravity");
    assert.ok(provider.models.length > 0);
    assert.equal(typeof provider.oauth.login, "function");
    assert.equal(typeof provider.oauth.refreshToken, "function");
    assert.equal(typeof provider.streamSimple, "function");
    assert.deepEqual([...h.commands.keys()].sort(), ["antigravity.doctor", "antigravity.models", "antigravity.usage"]);
    h.events.get("message_end")({ message: {
      role: "assistant", provider: "antigravity", model: "requested", responseModel: "served",
    } });
    assert.deepEqual(h.entries, []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(h.entries, [{ name: "antigravity-model-version", data: { requested: "requested", served: "served" } }]);
    assert.equal(typeof h.renderers.get("antigravity-model-version"), "function");
  } finally {
    if (old === undefined) delete process.env.ANTIGRAVITY_NO_PREWARM;
    else process.env.ANTIGRAVITY_NO_PREWARM = old;
  }
});

test("bundled web search registers its tool and backend selector without a request", () => {
  const h = capture();
  webSearch(h.api);
  assert.deepEqual([...h.tools.keys()], ["web_search"]);
  assert.deepEqual([...h.commands.keys()], ["websearch.backend"]);
  const tool = h.tools.get("web_search");
  assert.equal(tool.parameters.properties.query.type, "string");
  assert.equal(typeof tool.execute, "function");
});
