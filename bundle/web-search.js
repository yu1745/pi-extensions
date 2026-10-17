import {
  __name
} from "./chunk-SHUYVCID.js";

// extensions/web-search/index.ts
import { Type } from "typebox";
import { appendFileSync as appendFileSync6 } from "node:fs";

// extensions/web-search/backend-config.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
var SETTINGS_KEY = "webSearchBackend";
var LEGACY_KEY = "antigravityGoogleSearch";
function readSettings() {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    }
  } catch {
  }
  return {};
}
__name(readSettings, "readSettings");
function getWebSearchBackend() {
  const env = process.env.PI_WEB_SEARCH_BACKEND?.trim().toLowerCase();
  if (env === "google" || env === "openai" || env === "deepseek" || env === "deepseek-json" || env === "minimax" || env === "zai") {
    return env;
  }
  const settings = readSettings();
  const val = settings[SETTINGS_KEY];
  if (val === "google" || val === "openai" || val === "deepseek" || val === "deepseek-json" || val === "minimax" || val === "zai") {
    return val;
  }
  if (settings[LEGACY_KEY] === false) return "zai";
  return "google";
}
__name(getWebSearchBackend, "getWebSearchBackend");
function setWebSearchBackend(backend) {
  const settings = readSettings();
  settings[SETTINGS_KEY] = backend;
  settings[LEGACY_KEY] = backend !== "zai";
  const dir = join(homedir(), ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.settings.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, SETTINGS_PATH);
}
__name(setWebSearchBackend, "setWebSearchBackend");

// extensions/web-search/google-search.ts
import { antigravityFetch } from "./../extensions/antigravity/utils/http.ts";
import { weblog } from "./../extensions/antigravity/utils/weblog.ts";
import { antigravityHeaders, endpointCandidates, parseApiKey } from "./../extensions/antigravity/client/client.ts";
var DEFAULT_SEARCH_MODEL = "gemini-2.5-flash";
var GEO_RETRIES = 3;
var MAX_OUTPUT_CHARS = 5e4;
async function resolveAntigravityToken(ctx) {
  const auth = await ctx.modelRegistry.getProviderAuth("antigravity");
  const raw = auth?.auth?.apiKey;
  return parseApiKey(raw);
}
__name(resolveAntigravityToken, "resolveAntigravityToken");
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
__name(sleep, "sleep");
function geoBackoff() {
  return sleep(1e3 + Math.floor(Math.random() * 2e3));
}
__name(geoBackoff, "geoBackoff");
function isGroundingRedirectUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "vertexaisearch.cloud.google.com" && parsed.pathname.includes("/grounding-api-redirect");
  } catch {
    return false;
  }
}
__name(isGroundingRedirectUrl, "isGroundingRedirectUrl");
async function resolveGroundingRedirect(proxyUrl, signal) {
  try {
    const timeoutSignal = AbortSignal.timeout(5e3);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await antigravityFetch(proxyUrl, {
      method: "HEAD",
      redirect: "manual",
      signal: combinedSignal
    });
    const location = response.headers.get("location");
    if (!location) return proxyUrl;
    const resolved = new URL(location, proxyUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.toString() : proxyUrl;
  } catch {
    return proxyUrl;
  }
}
__name(resolveGroundingRedirect, "resolveGroundingRedirect");
async function finalizeGroundingSources(sources, signal) {
  const redirectUrls = /* @__PURE__ */ new Set();
  for (const s of sources) {
    if (s.uri && isGroundingRedirectUrl(s.uri)) redirectUrls.add(s.uri);
  }
  if (redirectUrls.size === 0) return sources;
  signal?.throwIfAborted();
  const resolvedEntries = await Promise.all(
    [...redirectUrls].map(async (url) => [url, await resolveGroundingRedirect(url, signal)])
  );
  signal?.throwIfAborted();
  const resolvedMap = new Map(resolvedEntries);
  const seen = /* @__PURE__ */ new Set();
  const finalSources = [];
  for (const s of sources) {
    const realUri = (s.uri && resolvedMap.get(s.uri)) ?? s.uri;
    if (!realUri || seen.has(realUri)) continue;
    seen.add(realUri);
    finalSources.push({
      ...s,
      uri: realUri
    });
  }
  return finalSources;
}
__name(finalizeGroundingSources, "finalizeGroundingSources");
async function googleGroundingSearch(token, projectId, query, signal) {
  const model = process.env.ANTIGRAVITY_SEARCH_MODEL?.trim() || DEFAULT_SEARCH_MODEL;
  const body = JSON.stringify({
    project: projectId,
    model,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: `agent-${Date.now()}`,
    request: {
      contents: [{ role: "user", parts: [{ text: query }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0 }
    }
  });
  let lastError = "";
  let lastStatus;
  for (let attempt = 0; attempt <= GEO_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error("Request was aborted");
    if (attempt > 0) await geoBackoff();
    for (const endpoint of endpointCandidates()) {
      const res = await antigravityFetch(`${endpoint}/v1internal:generateContent`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body,
        signal
      });
      if (res.ok) {
        const data = await res.json();
        const cand = data.response?.candidates?.[0];
        const text = (cand?.content?.parts ?? []).filter((p) => typeof p.text === "string" && p.thought !== true).map((p) => p.text).join("\n");
        const gm = cand?.groundingMetadata ?? {};
        const rawSources = (gm.groundingChunks ?? []).map((c) => c.web).filter((w) => Boolean(w?.uri));
        const sources = await finalizeGroundingSources(rawSources, signal);
        return {
          text: text.trim(),
          queries: gm.webSearchQueries ?? [],
          sources
        };
      }
      lastStatus = res.status;
      lastError = await res.text();
      if (res.status === 429) break;
      if (![403, 500, 502, 503, 504].includes(res.status)) break;
    }
    if (lastStatus === 429 && attempt === 0) {
      await sleep(2e3);
      continue;
    }
    const geoBlocked = lastStatus === 400 && /User location is not supported/i.test(lastError);
    if (geoBlocked && attempt < GEO_RETRIES) {
      weblog(`geo-blocked (400), retry ${attempt + 1}/${GEO_RETRIES} after backoff`);
    }
    if (!geoBlocked) break;
  }
  throw new Error(
    `Antigravity Google search failed (${lastStatus ?? "no response"}): ${lastError.slice(0, 300)}`
  );
}
__name(googleGroundingSearch, "googleGroundingSearch");
function truncate(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + "\n\n[Output truncated at 50000 chars]";
}
__name(truncate, "truncate");
function formatGoogleAnswer(answer, query) {
  const lines = [];
  if (answer.queries.length) {
    lines.push(`Google search queries: ${answer.queries.join(" | ")}`);
    lines.push("");
  }
  lines.push(answer.text || `(No synthesized answer for query: ${query})`);
  if (answer.sources.length) {
    lines.push("");
    lines.push("Sources:");
    const seen = /* @__PURE__ */ new Set();
    let n = 0;
    for (const s of answer.sources) {
      if (!s.uri || seen.has(s.uri)) continue;
      seen.add(s.uri);
      n++;
      lines.push(`[${n}] ${s.title || "(untitled)"} \u2014 ${s.uri}`);
    }
  }
  return truncate(lines.join("\n"));
}
__name(formatGoogleAnswer, "formatGoogleAnswer");

// extensions/web-search/openai-search.ts
import os from "node:os";
import { appendFileSync } from "node:fs";
function getPiUserAgent() {
  return `pi (${os.platform()} ${os.release()}; ${os.arch()})`;
}
__name(getPiUserAgent, "getPiUserAgent");
function weblog2(message) {
  try {
    appendFileSync("/tmp/pi-web-tools.log", `${(/* @__PURE__ */ new Date()).toISOString()} [web-search:openai] ${message}
`);
  } catch {
  }
}
__name(weblog2, "weblog");
var DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
var CODEX_CLIENT_VERSION = "0.144.1";
var DEFAULT_CANDIDATE_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5-codex"
];
var JWT_CLAIM_PATH = "https://api.openai.com/auth";
var MAX_OUTPUT_CHARS2 = 5e4;
function resolveCodexResponsesUrl(baseUrl) {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}
__name(resolveCodexResponsesUrl, "resolveCodexResponsesUrl");
function extractAccountId(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return void 0;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    const authData = payload?.[JWT_CLAIM_PATH];
    return authData?.chatgpt_account_id || void 0;
  } catch {
    return void 0;
  }
}
__name(extractAccountId, "extractAccountId");
async function resolveOpenAICodexAuth(ctx) {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) {
    return { token: envKey, accountId: extractAccountId(envKey) };
  }
  const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
  const rawKey = auth?.auth?.apiKey?.trim();
  if (!rawKey) {
    throw new Error(
      "No OpenAI credentials found: set OPENAI_API_KEY env var or run /login openai-codex."
    );
  }
  return {
    token: rawKey,
    accountId: extractAccountId(rawKey)
  };
}
__name(resolveOpenAICodexAuth, "resolveOpenAICodexAuth");
function extractCitationSnippet(text, start, end) {
  if (start === void 0 || end === void 0 || !text) return void 0;
  const before = Math.max(0, start - 100);
  const after = Math.min(text.length, end + 100);
  const snippet = text.slice(before, after).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
  if (!snippet) return void 0;
  return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}
__name(extractCitationSnippet, "extractCitationSnippet");
async function callSingleModel(url, model, token, accountId, query, signal) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "OpenAI-Beta": "responses=experimental",
    originator: "pi",
    version: CODEX_CLIENT_VERSION,
    "User-Agent": getPiUserAgent(),
    Accept: "text/event-stream",
    "Content-Type": "application/json"
  };
  if (accountId) {
    headers["chatgpt-account-id"] = accountId;
  }
  const body = {
    model,
    stream: true,
    store: false,
    include: ["web_search_call.action.sources"],
    parallel_tool_calls: true,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: query }]
      }
    ],
    tools: [
      {
        type: "web_search",
        search_context_size: "high"
      }
    ],
    tool_choice: { type: "web_search" },
    instructions: "You are a helpful assistant with web search capabilities. Search the web to answer the user's question accurately and cite your sources."
  };
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI Codex error (${res.status}): ${errText.slice(0, 300)}`);
  }
  if (!res.body) {
    throw new Error("OpenAI Codex returned no response body");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const answerParts = [];
  const sources = [];
  const seenUrls = /* @__PURE__ */ new Set();
  const addSource = /* @__PURE__ */ __name((src) => {
    if (!src.url || seenUrls.has(src.url)) return;
    seenUrls.add(src.url);
    sources.push(src);
  }, "addSource");
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(dataStr);
      } catch {
        continue;
      }
      const eventType = typeof event.type === "string" ? event.type : "";
      if (eventType === "response.output_item.done") {
        const item = event.item;
        if (!item) continue;
        if (item.type === "web_search_call") {
          const groups = [item.action?.sources, item.sources, item.results];
          for (const g of groups) {
            for (const s of g ?? []) {
              const u = s.url ?? s.source_website_url;
              if (u) addSource({ url: u, title: s.title ?? s.caption ?? u });
            }
          }
        }
        if (item.type === "message" && item.content) {
          for (const part of item.content) {
            if (part.type === "output_text" && part.text) {
              answerParts.push(part.text);
              if (part.annotations) {
                for (const ann of part.annotations) {
                  if (ann.type === "url_citation" && ann.url) {
                    addSource({
                      url: ann.url,
                      title: ann.title ?? ann.url,
                      snippet: extractCitationSnippet(part.text, ann.start_index, ann.end_index)
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return {
    answer: answerParts.join("\n\n").trim(),
    sources
  };
}
__name(callSingleModel, "callSingleModel");
async function openAiCodexSearch(token, accountId, query, signal) {
  const url = resolveCodexResponsesUrl(process.env.OPENAI_CODEX_BASE_URL);
  const configuredModel = process.env.OPENAI_CODEX_SEARCH_MODEL?.trim();
  const models = configuredModel ? [configuredModel] : DEFAULT_CANDIDATE_MODELS;
  let lastError;
  for (const model of models) {
    try {
      weblog2(`trying model=${model} query="${query.slice(0, 80)}"`);
      const result = await callSingleModel(url, model, token, accountId, query, signal);
      const lines = [];
      if (result.answer) {
        lines.push(result.answer);
        lines.push("");
      }
      if (result.sources.length > 0) {
        lines.push("Sources:");
        for (let i = 0; i < result.sources.length; i++) {
          const s = result.sources[i];
          lines.push(`[${i + 1}] ${s.title || "(untitled)"} \u2014 ${s.url}`);
          if (s.snippet) {
            lines.push(`    ${s.snippet}`);
          }
        }
      }
      let text = lines.join("\n").trim();
      if (!text) {
        text = `(No synthesized answer for query: ${query})`;
      }
      if (text.length > MAX_OUTPUT_CHARS2) {
        text = text.slice(0, MAX_OUTPUT_CHARS2) + "\n\n[Output truncated at 50000 chars]";
      }
      return {
        text,
        count: result.sources.length,
        answer: result.answer || void 0
      };
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      weblog2(`model ${model} failed: ${msg}`);
      if (configuredModel) throw err;
      if (!/model is not supported|invalid_request_error|not found|400|404/i.test(msg)) {
        throw err;
      }
    }
  }
  throw lastError || new Error("All OpenAI Codex search model candidates failed");
}
__name(openAiCodexSearch, "openAiCodexSearch");

// extensions/web-search/deepseek-search.ts
import { appendFileSync as appendFileSync2 } from "node:fs";
function weblog3(message) {
  try {
    appendFileSync2("/tmp/pi-web-tools.log", `${(/* @__PURE__ */ new Date()).toISOString()} [web-search:deepseek] ${message}
`);
  } catch {
  }
}
__name(weblog3, "weblog");
var DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic/v1";
var DEFAULT_MODEL = "deepseek-v4-flash";
var DEFAULT_API_VERSION = "2023-06-01";
var MAX_OUTPUT_CHARS3 = 5e4;
async function resolveDeepSeekApiKey(ctx) {
  const envKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (envKey) return envKey;
  const auth = await ctx.modelRegistry.getProviderAuth("deepseek");
  const key = auth?.auth?.apiKey?.trim();
  if (key) return key;
  throw new Error(
    "No DeepSeek API key found: set DEEPSEEK_API_KEY env var, or run /login deepseek."
  );
}
__name(resolveDeepSeekApiKey, "resolveDeepSeekApiKey");
function extractSnippets(blocks) {
  const map = /* @__PURE__ */ new Map();
  for (const block of blocks) {
    if (block.type !== "text") continue;
    const textBlock = block;
    for (const cite of textBlock.citations ?? []) {
      if (cite.url && cite.cited_text && !map.has(cite.url)) {
        map.set(cite.url, cite.cited_text);
      }
    }
  }
  return map;
}
__name(extractSnippets, "extractSnippets");
async function deepseekSearch(apiKey, query, signal) {
  const baseURL = (process.env.DEEPSEEK_SEARCH_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = process.env.DEEPSEEK_SEARCH_MODEL?.trim() || DEFAULT_MODEL;
  const endpoint = `${baseURL}/messages`;
  weblog3(`deepseekSearch endpoint=${endpoint} model=${model} query="${query.slice(0, 80)}"`);
  const body = {
    model,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `Perform a web search for the query: ${query}` }]
      }
    ],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 5
      }
    ]
  };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      authorization: `Bearer ${apiKey}`,
      "anthropic-version": DEFAULT_API_VERSION,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "deepseek-harness/0.0.1 (pi-web-search)"
    },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const errJson = await res.json();
      detail = typeof errJson.error === "string" ? errJson.error : errJson.error?.message ?? errJson.message ?? detail;
    } catch {
    }
    throw new Error(`DeepSeek search failed: ${detail}`);
  }
  const payload = await res.json();
  const blocks = payload.content ?? [];
  const answerParts = [];
  for (const block of blocks) {
    if (block.type === "text") {
      const t = block.text;
      if (t) answerParts.push(t);
    }
  }
  const resultBlocks = blocks.filter(
    (b) => b.type === "web_search_tool_result"
  );
  const snippets = extractSnippets(blocks);
  const seen = /* @__PURE__ */ new Set();
  const sources = [];
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== "web_search_result" || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      sources.push({
        url: item.url,
        title: item.title ?? void 0,
        snippet: snippets.get(item.url),
        publishedAt: item.page_age ?? void 0
      });
    }
  }
  const lines = [];
  const synthesized = answerParts.join("\n\n").trim();
  if (synthesized) {
    lines.push(synthesized);
    lines.push("");
  }
  if (sources.length > 0) {
    lines.push("Sources:");
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const title = s.title || "(untitled)";
      const age = s.publishedAt ? ` (${s.publishedAt})` : "";
      lines.push(`[${i + 1}] ${title}${age} \u2014 ${s.url}`);
      if (s.snippet) {
        lines.push(`    ${s.snippet}`);
      }
    }
  }
  let text = lines.join("\n").trim();
  if (!text) {
    text = `(No results returned for query: ${query})`;
  }
  if (text.length > MAX_OUTPUT_CHARS3) {
    text = text.slice(0, MAX_OUTPUT_CHARS3) + "\n\n[Output truncated at 50000 chars]";
  }
  return {
    text,
    count: sources.length,
    answer: synthesized || void 0
  };
}
__name(deepseekSearch, "deepseekSearch");

// extensions/web-search/deepseek-json-search.ts
import { appendFileSync as appendFileSync3 } from "node:fs";
function weblog4(message) {
  try {
    appendFileSync3("/tmp/pi-web-tools.log", `${(/* @__PURE__ */ new Date()).toISOString()} [web-search:deepseek-json] ${message}
`);
  } catch {
  }
}
__name(weblog4, "weblog");
var DEFAULT_BASE_URL2 = "https://api.deepseek.com/v1/tools";
var DEFAULT_COUNT = 10;
var MAX_OUTPUT_CHARS4 = 5e4;
var MAX_CONTENT_CHARS = 4e3;
function truncate2(text, limit) {
  return text.length > limit ? text.slice(0, limit) + "..." : text;
}
__name(truncate2, "truncate");
function formatMeta(item) {
  const parts = [];
  if (item.site_name) parts.push(item.site_name);
  if (typeof item.rerank_score === "number") parts.push(`rerank ${item.rerank_score.toFixed(2)}`);
  if (typeof item.authority === "number" && item.authority >= 0) parts.push(`authority ${item.authority}`);
  if (item.date) parts.push(item.date);
  return parts.join(" | ");
}
__name(formatMeta, "formatMeta");
function formatDeepSeekJsonResults(results, query) {
  if (results.length === 0) {
    return `(No results returned for query: ${query})`;
  }
  const lines = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const title = r.title?.trim() || "(untitled)";
    lines.push(`[${i + 1}] ${title}`);
    if (r.url) lines.push(`    ${r.url}`);
    const meta = formatMeta(r);
    if (meta) lines.push(`    ${meta}`);
    if (r.snippet?.trim()) lines.push(`    Snippet: ${r.snippet.trim()}`);
    if (r.summary?.trim()) lines.push(`    Summary: ${r.summary.trim()}`);
    if (r.content?.trim()) {
      lines.push(`    Content: ${truncate2(r.content.trim(), MAX_CONTENT_CHARS)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
__name(formatDeepSeekJsonResults, "formatDeepSeekJsonResults");
async function deepseekJsonSearch(apiKey, params, signal) {
  const baseURL = (process.env.DEEPSEEK_SEARCH_JSON_BASE_URL?.trim() || DEFAULT_BASE_URL2).replace(/\/+$/, "");
  const endpoint = `${baseURL}/search`;
  const body = {
    query: params.query,
    count: params.count ?? DEFAULT_COUNT
  };
  if (params.need_content !== void 0) body.need_content = params.need_content;
  if (params.ori_question?.trim()) body.ori_question = params.ori_question.trim();
  if (params.localization?.trim()) body.localization = params.localization.trim();
  weblog4(
    `deepseekJsonSearch endpoint=${endpoint} query="${params.query.slice(0, 80)}" body=${JSON.stringify(body)}`
  );
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "pi-web-search/1.0 (deepseek-search-json)"
    },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const errJson = await res.json();
      detail = typeof errJson.error === "string" ? errJson.error : errJson.error?.message ?? errJson.message ?? detail;
    } catch {
    }
    const hint = res.status === 429 ? " (rate limited: 5 QPS per account, retry shortly)" : res.status === 402 ? " (insufficient balance)" : res.status === 401 ? " (missing or invalid API key)" : "";
    throw new Error(`DeepSeek Search JSON API failed: ${detail}${hint}`);
  }
  const payload = await res.json();
  const results = payload.results ?? [];
  let text = formatDeepSeekJsonResults(results, params.query);
  if (text.length > MAX_OUTPUT_CHARS4) {
    text = text.slice(0, MAX_OUTPUT_CHARS4) + "\n\n[Output truncated at 50000 chars]";
  }
  weblog4(`deepseekJsonSearch done results=${results.length}`);
  return { text, count: results.length, results };
}
__name(deepseekJsonSearch, "deepseekJsonSearch");

// extensions/web-search/minimax-search.ts
import { appendFileSync as appendFileSync4 } from "node:fs";
function weblog5(message) {
  try {
    appendFileSync4("/tmp/pi-web-tools.log", `${(/* @__PURE__ */ new Date()).toISOString()} [web-search:minimax] ${message}
`);
  } catch {
  }
}
__name(weblog5, "weblog");
var DEFAULT_MINIMAX_HOST = "https://api.minimaxi.com";
var MAX_OUTPUT_CHARS5 = 5e4;
async function resolveMinimaxAuth(ctx) {
  let apiKey = process.env.MINIMAX_API_KEY?.trim();
  let apiHost = process.env.MINIMAX_API_HOST?.trim() || DEFAULT_MINIMAX_HOST;
  if (!apiKey) {
    const cnAuth = await ctx.modelRegistry.getProviderAuth("minimax-cn");
    apiKey = cnAuth?.auth?.apiKey?.trim();
  }
  if (!apiKey) {
    const globalAuth = await ctx.modelRegistry.getProviderAuth("minimax");
    apiKey = globalAuth?.auth?.apiKey?.trim();
    if (apiKey && !process.env.MINIMAX_API_HOST) {
      apiHost = "https://api.minimax.io";
    }
  }
  if (!apiKey) {
    throw new Error(
      "No MiniMax credentials found: set MINIMAX_API_KEY env var or run /login minimax-cn (or /login minimax)."
    );
  }
  return { apiKey, apiHost: apiHost.replace(/\/+$/, "") };
}
__name(resolveMinimaxAuth, "resolveMinimaxAuth");
async function minimaxSearch(apiKey, apiHost, query, signal) {
  const url = `${apiHost}/v1/coding_plan/search`;
  weblog5(`minimaxSearch calling url=${url} query="${query.slice(0, 80)}"`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "MM-API-Source": "Minimax-MCP",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ q: query }),
    signal
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MiniMax search request failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const baseResp = data.base_resp;
  if (baseResp && baseResp.status_code !== void 0 && baseResp.status_code !== 0) {
    if (baseResp.status_code === 1004) {
      throw new Error(`MiniMax search auth error: ${baseResp.status_msg} (check MINIMAX_API_KEY and host)`);
    }
    if (baseResp.status_code === 2038) {
      throw new Error(`MiniMax search error: real-name verification required (${baseResp.status_msg})`);
    }
    throw new Error(`MiniMax API error (${baseResp.status_code}): ${baseResp.status_msg}`);
  }
  const organic = data.organic ?? [];
  const lines = [];
  for (let i = 0; i < organic.length; i++) {
    const item = organic[i];
    const num = `[${i + 1}]`;
    const title = item.title?.trim() || "Untitled";
    const link = item.link?.trim() || "";
    const date = item.date ? ` (${item.date})` : "";
    const snippet = item.snippet?.trim() || "";
    lines.push(`${num} ${title}${date}`);
    if (link) lines.push(`    ${link}`);
    if (snippet) lines.push(`    ${snippet}`);
    lines.push("");
  }
  if (data.related_searches && data.related_searches.length > 0) {
    lines.push("Related searches:");
    for (const rel of data.related_searches) {
      if (rel.query) lines.push(`- ${rel.query}`);
    }
    lines.push("");
  }
  let text = lines.join("\n").trim();
  if (!text) {
    text = `(No results returned for query: ${query})`;
  }
  if (text.length > MAX_OUTPUT_CHARS5) {
    text = text.slice(0, MAX_OUTPUT_CHARS5) + "\n\n[Output truncated at 50000 chars]";
  }
  return { text, count: organic.length };
}
__name(minimaxSearch, "minimaxSearch");

// extensions/web-search/zai-search.ts
import { appendFileSync as appendFileSync5 } from "node:fs";
function weblog6(message) {
  try {
    appendFileSync5("/tmp/pi-web-tools.log", `${(/* @__PURE__ */ new Date()).toISOString()} [pi-extensions] ${message}
`);
  } catch {
  }
}
__name(weblog6, "weblog");
var MCP_SEARCH_URL = "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp";
var MAX_OUTPUT_BYTES = 5e4;
var MAX_OUTPUT_CHARS6 = 8e4;
async function resolveZaiApiKey(ctx) {
  const envKey = process.env.Z_AI_MCP_API_KEY;
  if (envKey) return envKey;
  const result = await ctx.modelRegistry.getProviderAuth("zai-coding-cn");
  const key = result?.auth?.apiKey;
  if (!key) {
    throw new Error(
      "No Z.AI API key: set Z_AI_MCP_API_KEY env var, or run /login zai-coding-cn (or configure its API key) and retry."
    );
  }
  return key;
}
__name(resolveZaiApiKey, "resolveZaiApiKey");
function parseSSE(text) {
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      const jsonStr = trimmed.slice(5).trim();
      if (!jsonStr) continue;
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed === "object" && "result" in parsed) {
          const result = parsed.result;
          if (result && typeof result === "object" && "content" in result) {
            const content = result.content;
            if (Array.isArray(content) && content.length > 0) {
              const raw = content[0].text;
              try {
                return JSON.parse(raw);
              } catch {
                return raw;
              }
            }
          }
          return result;
        }
      } catch {
      }
    }
  }
  return text;
}
__name(parseSSE, "parseSSE");
async function mcpCall(apiKey, method, params, signal) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream"
  };
  const initPayload = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-web-search-ext", version: "1.0.0" }
    }
  };
  const initResp = await fetch(MCP_SEARCH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(initPayload),
    signal
  });
  if (!initResp.ok) {
    throw new Error(`MCP initialize failed: ${initResp.status} ${initResp.statusText}`);
  }
  const sessionId = initResp.headers.get("mcp-session-id") ?? initResp.headers.get("Mcp-Session-Id") ?? "";
  const callPayload = {
    jsonrpc: "2.0",
    id: 2,
    method,
    params
  };
  const callHeaders = { ...headers };
  if (sessionId) {
    callHeaders["Mcp-Session-Id"] = sessionId;
  }
  const callResp = await fetch(MCP_SEARCH_URL, {
    method: "POST",
    headers: callHeaders,
    body: JSON.stringify(callPayload),
    signal
  });
  if (!callResp.ok) {
    throw new Error(`MCP call failed: ${callResp.status} ${callResp.statusText}`);
  }
  const callText = await callResp.text();
  const data = parseSSE(callText);
  return { sessionId, data };
}
__name(mcpCall, "mcpCall");
function formatSearchResults(results) {
  const lines = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const num = `${i + 1}.`;
    const title = r.title ?? "Untitled";
    const url = r.link ?? r.url ?? "";
    const desc = r.content ?? r.snippet ?? r.description ?? "";
    lines.push(`${num} **${title}**`);
    if (url) lines.push(`   ${url}`);
    if (desc) {
      const trimmed = desc.length > 300 ? desc.slice(0, 300) + "..." : desc;
      lines.push(`   ${trimmed}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
__name(formatSearchResults, "formatSearchResults");
function truncateOutput(text) {
  if (text.length <= MAX_OUTPUT_CHARS6 && Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) {
    return text;
  }
  let truncated = "";
  let byteLen = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (byteLen + charBytes > MAX_OUTPUT_BYTES) break;
    truncated += char;
    byteLen += charBytes;
  }
  return truncated + `

[Output truncated: ${byteLen} bytes of ${Buffer.byteLength(text, "utf8")} bytes]`;
}
__name(truncateOutput, "truncateOutput");
async function zaiSearch(apiKey, params, signal) {
  const args = {
    search_query: params.query
  };
  if (params.location) args.location = params.location;
  if (params.recency) args.search_recency_filter = params.recency;
  if (params.domain_filter) args.search_domain_filter = params.domain_filter;
  if (params.content_size) args.content_size = params.content_size;
  weblog6(`zaiSearch query="${params.query.slice(0, 80)}"`);
  const result = await mcpCall(
    apiKey,
    "tools/call",
    {
      name: "web_search_prime",
      arguments: args
    },
    signal
  );
  let outputText;
  if (typeof result.data === "string") {
    outputText = result.data;
  } else if (result.data && typeof result.data === "object" && "content" in result.data) {
    const content = result.data.content;
    if (Array.isArray(content) && content.length > 0) {
      const raw = content[0].text;
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            outputText = formatSearchResults(parsed);
          } else {
            outputText = JSON.stringify(parsed, null, 2);
          }
        } catch {
          outputText = raw;
        }
      } else {
        outputText = JSON.stringify(content, null, 2);
      }
    } else {
      outputText = JSON.stringify(result.data, null, 2);
    }
  } else if (Array.isArray(result.data)) {
    outputText = formatSearchResults(result.data);
  } else {
    outputText = JSON.stringify(result.data, null, 2);
  }
  return { text: truncateOutput(outputText) };
}
__name(zaiSearch, "zaiSearch");

// extensions/web-search/index.ts
function weblog7(message) {
  try {
    appendFileSync6("/tmp/pi-web-tools.log", `${(/* @__PURE__ */ new Date()).toISOString()} [web-search] ${message}
`);
  } catch {
  }
}
__name(weblog7, "weblog");
function emitOutput(ctx, text, type = "info") {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (type === "warning" || type === "error") console.error(text);
  else console.log(text);
}
__name(emitOutput, "emitOutput");
function webSearchExtension(pi) {
  const currentBackend = getWebSearchBackend();
  pi.registerCommand("websearch.backend", {
    description: "Select web_search backend (Google, OpenAI, DeepSeek, DeepSeek JSON, MiniMax, Z.AI) via interactive menu or argument.",
    handler: /* @__PURE__ */ __name(async (args, ctx) => {
      const rawArg = (args || "").trim().toLowerCase();
      const active = getWebSearchBackend();
      const applySelection = /* @__PURE__ */ __name((selected) => {
        setWebSearchBackend(selected);
        const tip = selected === active ? `web_search backend remains: ${selected}` : `web_search backend set to: ${selected} (\u5DF2\u4FDD\u5B58\u81F3 settings.json)\u3002
\u63D0\u793A\uFF1A\u4E3A\u4FDD\u8BC1\u5DE5\u5177 Schema \u4E0E\u7CFB\u7EDF\u63D0\u793A\u8BCD\u7EDD\u5BF9\u7CBE\u51C6\uFF0C\u53D8\u66F4\u5C06\u5728 /reload \u6216\u4E0B\u6B21\u4F1A\u8BDD\u751F\u6548\u3002`;
        emitOutput(ctx, tip);
      }, "applySelection");
      if (rawArg === "google" || rawArg === "1" || rawArg === "on") {
        applySelection("google");
        return;
      }
      if (rawArg === "openai" || rawArg === "codex") {
        applySelection("openai");
        return;
      }
      if (rawArg === "deepseek" || rawArg === "ds") {
        applySelection("deepseek");
        return;
      }
      if (rawArg === "deepseek-json" || rawArg === "ds-json" || rawArg === "dsjson") {
        applySelection("deepseek-json");
        return;
      }
      if (rawArg === "minimax" || rawArg === "mm") {
        applySelection("minimax");
        return;
      }
      if (rawArg === "zai" || rawArg === "bigmodel" || rawArg === "0" || rawArg === "off") {
        applySelection("zai");
        return;
      }
      if (ctx.hasUI) {
        const options = [
          `google   - Google (Antigravity Grounding / Gemini \u5B9E\u65F6\u68C0\u7D22)${active === "google" ? " (\u5F53\u524D\u751F\u6548)" : ""}`,
          `openai   - OpenAI (Codex Responses API / GPT-5.6 \u5B9E\u65F6\u68C0\u7D22)${active === "openai" ? " (\u5F53\u524D\u751F\u6548)" : ""}`,
          `deepseek - DeepSeek (Anthropic \u534F\u8BAE\u539F\u751F web_search \u5DE5\u5177)${active === "deepseek" ? " (\u5F53\u524D\u751F\u6548)" : ""}`,
          `deepseek-json - DeepSeek \u7ED3\u6784\u5316\u68C0\u7D22 (/v1/tools/search\uFF0C\u65E0\u6A21\u578B\u8C03\u7528)${active === "deepseek-json" ? " (\u5F53\u524D\u751F\u6548)" : ""}`,
          `minimax  - MiniMax (Coding Plan \u5FEB\u901F\u4EE3\u7801/\u5DE5\u7A0B\u5B9E\u65F6\u68C0\u7D22)${active === "minimax" ? " (\u5F53\u524D\u751F\u6548)" : ""}`,
          `zai      - \u667A\u8C31 BigModel / Z.AI (\u5E26\u5730\u57DF/\u65F6\u6548\u539F\u751F\u53C2\u6570\u8FC7\u6EE4)${active === "zai" ? " (\u5F53\u524D\u751F\u6548)" : ""}`
        ];
        const choice = await ctx.ui.select(
          `\u9009\u62E9 web_search \u540E\u7AEF (\u5F53\u524D\u4F1A\u8BDD\u751F\u6548: ${active}):`,
          options
        );
        if (!choice) return;
        let selected = "google";
        if (choice.startsWith("google")) selected = "google";
        else if (choice.startsWith("openai")) selected = "openai";
        else if (choice.startsWith("deepseek-json")) selected = "deepseek-json";
        else if (choice.startsWith("deepseek")) selected = "deepseek";
        else if (choice.startsWith("minimax")) selected = "minimax";
        else if (choice.startsWith("zai")) selected = "zai";
        applySelection(selected);
        return;
      }
      emitOutput(
        ctx,
        `Current backend: ${active}
Usage: /websearch.backend [google | openai | deepseek | deepseek-json | minimax | zai]`
      );
    }, "handler")
  });
  switch (currentBackend) {
    // ── 1. Google (Antigravity Grounding)
    case "google": {
      pi.registerTool({
        name: "web_search",
        label: "Web Search (Google)",
        description: `Search the web using Google Search via Antigravity Grounding. Returns real-time search synthesis and verified destination URLs. Supports Google search operators natively (e.g. 'site:example.com', '"exact quote"', '-exclude', 'after:2026-01').`,
        promptSnippet: "Search Google for up-to-date web content, documentation, or facts",
        promptGuidelines: [
          "Use web_search when you need real-time data, official documentation, current news, or external technical references.",
          "Supports native Google search operators directly in the query: site:github.com, quotes, etc."
        ],
        parameters: Type.Object({
          query: Type.String({
            description: "Google search query. Supports Google syntax (e.g. 'query site:github.com', quotes, after:YYYY-MM)."
          })
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          weblog7(`Google search execute: query="${params.query.slice(0, 80)}"`);
          const creds = await resolveAntigravityToken(ctx);
          const answer = await googleGroundingSearch(
            creds.token,
            creds.projectId,
            params.query,
            signal
          );
          return {
            content: [{ type: "text", text: formatGoogleAnswer(answer, params.query) }],
            details: {
              query: params.query,
              source: "Google Search (Antigravity Grounding)",
              googleQueries: answer.queries,
              sourceCount: answer.sources.length
            }
          };
        }
      });
      break;
    }
    // ── 2. OpenAI (Codex Responses API)
    case "openai": {
      pi.registerTool({
        name: "web_search",
        label: "Web Search (OpenAI)",
        description: "Search the web using OpenAI Codex web search. Executes real-time web retrieval with synthesized answers and cited web sources.",
        promptSnippet: "Search the web with OpenAI for real-time information",
        promptGuidelines: [
          "Use web_search when you need up-to-date information, documentation, or facts.",
          "Write clean, keyword-dense queries for best retrieval accuracy."
        ],
        parameters: Type.Object({
          query: Type.String({
            description: "Search query. Supports standard search operators and keywords."
          })
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          weblog7(`OpenAI search execute: query="${params.query.slice(0, 80)}"`);
          const { token, accountId } = await resolveOpenAICodexAuth(ctx);
          const { text, count } = await openAiCodexSearch(token, accountId, params.query, signal);
          return {
            content: [{ type: "text", text }],
            details: {
              query: params.query,
              source: "OpenAI Codex Responses Search",
              sourceCount: count
            }
          };
        }
      });
      break;
    }
    // ── 3. DeepSeek (Anthropic-Compatible Native Tool)
    case "deepseek": {
      pi.registerTool({
        name: "web_search",
        label: "Web Search (DeepSeek)",
        description: "Search the web using DeepSeek's native web search capability. Returns grounded web findings, relevant citations, and source URLs.",
        promptSnippet: "Perform a web search using DeepSeek's native search engine",
        promptGuidelines: [
          "Use web_search when answering questions requiring real-time data or latest technical releases."
        ],
        parameters: Type.Object({
          query: Type.String({
            description: "The search query to look up on the web."
          })
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          weblog7(`DeepSeek search execute: query="${params.query.slice(0, 80)}"`);
          const apiKey = await resolveDeepSeekApiKey(ctx);
          const { text, count } = await deepseekSearch(apiKey, params.query, signal);
          return {
            content: [{ type: "text", text }],
            details: {
              query: params.query,
              source: "DeepSeek native web search",
              sourceCount: count
            }
          };
        }
      });
      break;
    }
    // ── 3b. DeepSeek Search JSON (stateless /v1/tools/search)
    case "deepseek-json": {
      pi.registerTool({
        name: "web_search",
        label: "Web Search (DeepSeek JSON)",
        description: "Search the web with the official DeepSeek Search JSON endpoint (/v1/tools/search). Returns structured, reranked results (title, url, date, authority, snippet, long summary) from a single stateless request: no model call, no token cost, nothing rewritten. Supports native search syntax: site:example.com, -site:example.com, -word, lang:zh,en, after:2025-01-01, before:2026-06-01, or an exact phrase wrapped in double quotes.",
        promptSnippet: "Search the web for structured, source-rich results (DeepSeek JSON)",
        promptGuidelines: [
          "Use web_search when you want raw, structured results instead of a model-written answer: fresh news, official docs, or a list of sources to cite.",
          "Search operators can be passed directly in the query: site:, -site:, -word, lang:zh,en, after:YYYY[-MM-DD], before:YYYY[-MM-DD], or an exact phrase wrapped in double quotes.",
          "Read the long summary attached to each result (600-800 chars); set need_content to true when the page body itself is needed.",
          "Weigh rerank_score (1.5 and above is good) and authority (3 and above is highly authoritative) when choosing which sources to trust.",
          "Dates come from upstream indexing and can be imprecise; after:/before: bias recency rather than hard-filtering, so verify a date before asserting it."
        ],
        parameters: Type.Object({
          query: Type.String({
            description: "Search query (1-128 chars). Supports site:, -site:, -word, lang:zh,en, after:YYYY[-MM-DD], before:YYYY[-MM-DD], and exact phrases in double quotes."
          }),
          count: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 50,
              description: "Number of results to return (1-50, default 10). Does not affect billing."
            })
          ),
          need_content: Type.Optional(
            Type.Boolean({
              description: "When true, also return the rendered page body (Markdown) for each result. Slower and much larger; default false."
            })
          ),
          ori_question: Type.Optional(
            Type.String({
              description: "The original user question (1-128 chars), forwarded to improve search intent understanding."
            })
          )
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          weblog7(
            `DeepSeek Search JSON execute: query="${params.query.slice(0, 80)}" count=${params.count ?? 10} need_content=${params.need_content === true}`
          );
          const apiKey = await resolveDeepSeekApiKey(ctx);
          const { text, count } = await deepseekJsonSearch(
            apiKey,
            {
              query: params.query,
              count: params.count,
              need_content: params.need_content,
              ori_question: params.ori_question
            },
            signal
          );
          return {
            content: [{ type: "text", text }],
            details: {
              query: params.query,
              source: "DeepSeek Search JSON (/v1/tools/search)",
              sourceCount: count,
              needContent: params.need_content === true
            }
          };
        }
      });
      break;
    }
    // ── 4. MiniMax (Coding Plan Search API)
    case "minimax": {
      pi.registerTool({
        name: "web_search",
        label: "Web Search (MiniMax)",
        description: "Search the web using MiniMax Coding Plan search API. Fast technical and real-time search engine returning organic web links and snippets.",
        promptSnippet: "Search technical and external web data via MiniMax",
        promptGuidelines: [
          "Aim for 3-5 keywords for best results. For time-sensitive topics, include the current year/date.",
          "If no useful results are returned, try rephrasing with different keywords."
        ],
        parameters: Type.Object({
          query: Type.String({
            description: "Search keywords (recommended 3-5 concise keywords)."
          })
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          weblog7(`MiniMax search execute: query="${params.query.slice(0, 80)}"`);
          const { apiKey, apiHost } = await resolveMinimaxAuth(ctx);
          const { text, count } = await minimaxSearch(apiKey, apiHost, params.query, signal);
          return {
            content: [{ type: "text", text }],
            details: {
              query: params.query,
              source: "MiniMax Coding Plan Search API",
              sourceCount: count
            }
          };
        }
      });
      break;
    }
    // ── 5. Z.AI (BigModel Web Search Prime MCP)
    case "zai": {
      pi.registerTool({
        name: "web_search",
        label: "Web Search (Z.AI)",
        description: "Search the web using Z.AI Web Search Prime. Supports native regional targeting, recency filtering, and domain filtering.",
        promptSnippet: "Search the web with regional and recency filters using Z.AI",
        promptGuidelines: [
          "Use web_search when you need real-time data with specific recency or location filters.",
          "For Chinese content set location 'cn'; for international set 'us'."
        ],
        parameters: Type.Object({
          query: Type.String({
            description: "Search query. Use 'site:<domain>' for domain filtering."
          }),
          location: Type.Optional(
            Type.Union([Type.Literal("cn"), Type.Literal("us")], {
              description: "Search region: 'cn' for China, 'us' for global/US."
            })
          ),
          recency: Type.Optional(
            Type.Union(
              [
                Type.Literal("oneDay"),
                Type.Literal("oneWeek"),
                Type.Literal("oneMonth"),
                Type.Literal("oneYear"),
                Type.Literal("noLimit")
              ],
              {
                description: "Filter results by publication recency."
              }
            )
          ),
          domain_filter: Type.Optional(
            Type.String({
              description: "Target domain filter (or specify 'site:<domain>' in query)."
            })
          ),
          content_size: Type.Optional(
            Type.Union([Type.Literal("medium"), Type.Literal("high")], {
              description: "Result snippet detail level."
            })
          )
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          weblog7(`Z.AI search execute: query="${params.query.slice(0, 80)}"`);
          const apiKey = await resolveZaiApiKey(ctx);
          const { text } = await zaiSearch(apiKey, params, signal);
          return {
            content: [{ type: "text", text }],
            details: {
              query: params.query,
              source: "Z.AI Web Search Prime",
              location: params.location,
              recency: params.recency
            }
          };
        }
      });
      break;
    }
  }
}
__name(webSearchExtension, "webSearchExtension");
export {
  webSearchExtension as default
};
