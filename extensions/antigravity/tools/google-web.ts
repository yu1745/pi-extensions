/**
 * Google Web Search tool backed by Antigravity (Cloud Code Assist) grounding.
 *
 * Registers a `web_search` custom tool that performs real Google searches via
 * the same `v1internal:generateContent` + `googleSearch` grounding channel the
 * Antigravity CLI itself uses. The tool works regardless of which provider or
 * model the current session is on — it only needs Antigravity credentials.
 *
 * Coordination with the user's pi-extensions web-search extension (Z.AI-backed
 * `web_search` / `web_reader`): pi resolves duplicate custom tool names with
 * first-registration-wins, so this package must load BEFORE pi-extensions
 * (see `packages` order in ~/.pi/agent/settings.json). At load time we set a
 * process-global marker; pi-extensions' web-search checks that marker and
 * skips registering its Z.AI tools, which also un-shadows pi's built-in
 * `web_reader` / `web_reader_spa`.
 *
 * Opt out entirely with PI_ANTIGRAVITY_GOOGLE_SEARCH=0 (marker unset, tools
 * not registered — pi-extensions Z.AI tools then register as before).
 * Override the grounding model with ANTIGRAVITY_SEARCH_MODEL (default
 * gemini-2.5-flash, verified stable on this channel).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { antigravityFetch } from "../utils/http.js";
import { weblog } from "../utils/weblog.js";
import { antigravityHeaders, endpointCandidates, parseApiKey } from "../client/client.js";

export const GOOGLE_WEB_MARKER = "__PI_ANTIGRAVITY_GOOGLE_WEB__";

// ── Single persisted use-flag (top-level in ~/.pi/agent/settings.json) ────────
// antigravityGoogleSearch: 1 → fork's Google-grounding web_search serves the tool
//                            name (pi-extensions Z.AI web_search yields);
//                          0 → Z.AI web_search (yu1745) serves it, fork stands down.
// Env PI_ANTIGRAVITY_GOOGLE_SEARCH=1|0 overrides the flag.
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const SETTINGS_KEY = "antigravityGoogleSearch";

function readSettings(): Record<string, unknown> {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
    }
  } catch {
    // unreadable settings — fall back to defaults
  }
  return {};
}

export function getGoogleSearchEnabled(): boolean {
  const env = process.env.PI_ANTIGRAVITY_GOOGLE_SEARCH;
  if (env === "1") return true;
  if (env === "0") return false;
  const value = readSettings()[SETTINGS_KEY];
  return value !== false && value !== 0; // default: on
}

export function setGoogleSearchEnabled(enabled: boolean): void {
  const settings = readSettings();
  settings[SETTINGS_KEY] = enabled;
  const dir = join(homedir(), ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  // Atomic write: tmp file + rename so a concurrent pi settings save can never
  // observe a half-written file.
  const tmp = join(dir, `.settings.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, SETTINGS_PATH);
  weblog(`google web_search flag persisted: ${enabled} (settings.json ${SETTINGS_KEY})`);
}

const DEFAULT_SEARCH_MODEL = "gemini-2.5-flash";
const GEO_RETRIES = 3;
const MAX_OUTPUT_CHARS = 50_000;

interface ToolAuthCtx {
  modelRegistry: {
    getProviderAuth(provider: string): Promise<{ auth?: { apiKey?: string } } | undefined>;
  };
}

interface GroundingChunkWeb {
  uri?: string;
  title?: string;
}

interface GroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: Array<{ web?: GroundingChunkWeb }>;
}

interface CandidatePart {
  text?: string;
  thought?: boolean;
}

async function resolveToken(ctx: ToolAuthCtx): Promise<{ token: string; projectId: string }> {
  const auth = await ctx.modelRegistry.getProviderAuth("antigravity");
  const raw = auth?.auth?.apiKey;
  return parseApiKey(raw); // throws a friendly error if not logged in
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Random 1–3s backoff, as used for geo-block retries. */
function geoBackoff(): Promise<void> {
  return sleep(1000 + Math.floor(Math.random() * 2000));
}

interface GroundingAnswer {
  text: string;
  queries: string[];
  sources: GroundingChunkWeb[];
}

/** One non-streaming grounded generateContent call, with geo-block retry. Exported for smoke tests. */
export async function googleGroundingSearch(
  token: string,
  projectId: string,
  query: string,
  signal?: AbortSignal,
): Promise<GroundingAnswer> {
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
      generationConfig: { temperature: 0 },
    },
  });

  let lastError = "";
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt <= GEO_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error("Request was aborted");
    if (attempt > 0) await geoBackoff();

    for (const endpoint of endpointCandidates()) {
      const res = await antigravityFetch(`${endpoint}/v1internal:generateContent`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body,
        signal,
      });
      if (res.ok) {
        const data = (await res.json()) as {
          response?: {
            candidates?: Array<{
              content?: { parts?: CandidatePart[] };
              groundingMetadata?: GroundingMetadata;
            }>;
          };
        };
        const cand = data.response?.candidates?.[0];
        const text = (cand?.content?.parts ?? [])
          .filter((p) => typeof p.text === "string" && p.thought !== true)
          .map((p) => p.text)
          .join("\n");
        const gm = cand?.groundingMetadata ?? {};
        return {
          text: text.trim(),
          queries: gm.webSearchQueries ?? [],
          sources: (gm.groundingChunks ?? [])
            .map((c) => c.web)
            .filter((w): w is GroundingChunkWeb => Boolean(w?.uri)),
        };
      }
      lastStatus = res.status;
      lastError = await res.text();
      // Rate-limited: endpoint failover cannot help — stop hammering alternates.
      if (res.status === 429) break;
      // Only transport-level failures justify trying the next endpoint.
      if (![403, 500, 502, 503, 504].includes(res.status)) break;
    }

    if (lastStatus === 429 && attempt === 0) {
      await sleep(2000); // one gentle retry for burst rate limits
      continue;
    }
    const geoBlocked =
      lastStatus === 400 && /User location is not supported/i.test(lastError);
    if (geoBlocked && attempt < GEO_RETRIES) {
      weblog(`geo-blocked (400), retry ${attempt + 1}/${GEO_RETRIES} after backoff`);
    }
    if (!geoBlocked) break;
    // else: swallow and retry (attempt loop) — proxy egress region flapping.
  }

  throw new Error(
    `Antigravity Google search failed (${lastStatus ?? "no response"}): ${lastError.slice(0, 300)}`,
  );
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + "\n\n[Output truncated at 50000 chars]";
}

function formatAnswer(answer: GroundingAnswer, query: string): string {
  const lines: string[] = [];
  if (answer.queries.length) {
    lines.push(`Google search queries: ${answer.queries.join(" | ")}`);
    lines.push("");
  }
  lines.push(answer.text || `(No synthesized answer for query: ${query})`);
  if (answer.sources.length) {
    lines.push("");
    lines.push("Sources:");
    const seen = new Set<string>();
    let n = 0;
    for (const s of answer.sources) {
      if (!s.uri || seen.has(s.uri)) continue;
      seen.add(s.uri);
      n++;
      lines.push(`[${n}] ${s.title || "(untitled)"} — ${s.uri}`);
    }
  }
  lines.push("");
  lines.push(
    "(Source URIs are short-lived, one-time redirect links: they resolve to the real page only within minutes of this search, only in a real browser. Read a source now with web_reader_spa, or re-locate it later via 'site:<domain> <keywords>'. Do not archive these URIs.)",
  );
  return truncate(lines.join("\n"));
}

export function registerGoogleWebTools(pi: ExtensionAPI): void {
  if (!getGoogleSearchEnabled()) {
    weblog("register: flag off → fork stands down, Z.AI web_search (yu1745) serves");
    return;
  }
  weblog("register: flag on → setting marker + registering google web_search (Z.AI web_search yields)");

  // In-process handshake: pi-extensions' web-search sees this and yields web_search
  // (its Z.AI web_reader still registers — reader is always available).
  (globalThis as Record<string, unknown>)[GOOGLE_WEB_MARKER] = true;

  pi.registerTool({
    name: "web_search",
    label: "Web Search (Google)",
    description:
      "Search the web using real Google Search (via Antigravity grounding). Returns a synthesized answer with inline citations plus a numbered source list. Google-grade index coverage for English content and fresh news.",
    promptSnippet: "Search the web with Google for up-to-date information",
    promptGuidelines: [
      "Use web_search when you need up-to-date information, news, documentation, or any online content.",
      "web_search runs a real Google search and returns a synthesized, citation-backed answer — for deep reading of a specific page, follow up with web_reader.",
      "Best for English/international content and anything where Google index coverage matters.",
      "The query supports native Google operators: restrict a site with 'site:example.com', recency with 'after:2026-06' / 'before:...', exact match with quotes, exclude with '-term', filetype with 'filetype:pdf'. Apply them directly inside the query string — there are no separate parameters.",
      "Source URIs are short-lived, one-time redirect links (vertexaisearch.cloud.google.com): they resolve to the real page only within minutes of this search and only in a real browser. If you want to read a source, follow up with web_reader_spa IMMEDIATELY after this call; expired links return 404 — then re-locate the page by searching 'site:<domain> <keywords>' instead. Never copy these URIs into reports or files as permanent references.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Search query. Natural question or keywords; Google rewrites it automatically. Supports native operators like site:example.com, after:2026-06, quotes, -exclude.",
      }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      weblog(`web_search execute: query="${params.query.slice(0, 80)}"`);
      const creds = await resolveToken(ctx as unknown as ToolAuthCtx);
      const answer = await googleGroundingSearch(
        creds.token,
        creds.projectId,
        params.query,
        signal,
      );
      return {
        content: [{ type: "text", text: formatAnswer(answer, params.query) }],
        details: {
          query: params.query,
          source: "Google Search via Antigravity grounding",
          googleQueries: answer.queries,
          sourceCount: answer.sources.length,
        },
      };
    },
  });
}
