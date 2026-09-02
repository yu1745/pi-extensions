/**
 * Google Web Search backend via Antigravity (Cloud Code Assist) grounding.
 *
 * Performs real Google searches over the same `v1internal:generateContent` +
 * `googleSearch` grounding channel the Antigravity CLI itself uses. The
 * functions here are pure engines exported for the web-search extension,
 * which decides at EXECUTE time (via shared/web-search-flag.ts) whether to
 * serve `web_search` from Google grounding or Z.AI — so no registration-time
 * handshake, load-order dependency, or restart-to-toggle is needed anymore.
 *
 * Override the grounding model with ANTIGRAVITY_SEARCH_MODEL (default
 * gemini-2.5-flash, verified stable on this channel).
 */

import { antigravityFetch } from "../utils/http.js";
import { weblog } from "../utils/weblog.js";
import { antigravityHeaders, endpointCandidates, parseApiKey } from "../client/client.js";

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

/** Resolve Antigravity credentials from the session's provider auth. */
export async function resolveToken(
  ctx: ToolAuthCtx,
): Promise<{ token: string; projectId: string }> {
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

/** Render a grounding answer for the model, with sources and URI-expiry warning. */
export function formatGoogleAnswer(answer: GroundingAnswer, query: string): string {
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

