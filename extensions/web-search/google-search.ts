/**
 * Google Web Search backend via Antigravity (Cloud Code Assist) grounding.
 *
 * Performs real Google searches over the same `v1internal:generateContent` +
 * `googleSearch` grounding channel the Antigravity CLI itself uses.
 */

import { antigravityFetch } from "../antigravity/utils/http.js";
import { weblog } from "../antigravity/utils/weblog.js";
import { antigravityHeaders, endpointCandidates, parseApiKey } from "../antigravity/client/client.js";

const DEFAULT_SEARCH_MODEL = "gemini-2.5-flash";
const GEO_RETRIES = 3;
const MAX_OUTPUT_CHARS = 50_000;

export interface ToolAuthCtx {
  modelRegistry: {
    getProviderAuth(provider: string): Promise<{ auth?: { apiKey?: string } } | undefined>;
  };
}

export interface GroundingChunkWeb {
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

export interface GoogleAnswer {
  text: string;
  queries: string[];
  sources: GroundingChunkWeb[];
}

/** Resolve Antigravity credentials from the session's provider auth. */
export async function resolveAntigravityToken(
  ctx: ToolAuthCtx,
): Promise<{ token: string; projectId: string }> {
  const auth = await ctx.modelRegistry.getProviderAuth("antigravity");
  const raw = auth?.auth?.apiKey;
  return parseApiKey(raw);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Random 1–3s backoff, as used for geo-block retries. */
function geoBackoff(): Promise<void> {
  return sleep(1000 + Math.floor(Math.random() * 2000));
}

function isGroundingRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "vertexaisearch.cloud.google.com" &&
      parsed.pathname.includes("/grounding-api-redirect")
    );
  } catch {
    return false;
  }
}

async function resolveGroundingRedirect(
  proxyUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const timeoutSignal = AbortSignal.timeout(5000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await antigravityFetch(proxyUrl, {
      method: "HEAD",
      redirect: "manual",
      signal: combinedSignal,
    });
    const location = response.headers.get("location");
    if (!location) return proxyUrl;
    const resolved = new URL(location, proxyUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.toString() : proxyUrl;
  } catch {
    return proxyUrl;
  }
}

async function finalizeGroundingSources(
  sources: GroundingChunkWeb[],
  signal?: AbortSignal,
): Promise<GroundingChunkWeb[]> {
  const redirectUrls = new Set<string>();
  for (const s of sources) {
    if (s.uri && isGroundingRedirectUrl(s.uri)) redirectUrls.add(s.uri);
  }
  if (redirectUrls.size === 0) return sources;

  signal?.throwIfAborted();
  const resolvedEntries = await Promise.all(
    [...redirectUrls].map(async (url) => [url, await resolveGroundingRedirect(url, signal)] as const),
  );
  signal?.throwIfAborted();
  const resolvedMap = new Map(resolvedEntries);

  const seen = new Set<string>();
  const finalSources: GroundingChunkWeb[] = [];
  for (const s of sources) {
    const realUri = (s.uri && resolvedMap.get(s.uri)) ?? s.uri;
    if (!realUri || seen.has(realUri)) continue;
    seen.add(realUri);
    finalSources.push({
      ...s,
      uri: realUri,
    });
  }
  return finalSources;
}

/** One non-streaming grounded generateContent call, with geo-block retry. */
export async function googleGroundingSearch(
  token: string,
  projectId: string,
  query: string,
  signal?: AbortSignal,
): Promise<GoogleAnswer> {
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
        const rawSources = (gm.groundingChunks ?? [])
          .map((c) => c.web)
          .filter((w): w is GroundingChunkWeb => Boolean(w?.uri));
        const sources = await finalizeGroundingSources(rawSources, signal);
        return {
          text: text.trim(),
          queries: gm.webSearchQueries ?? [],
          sources,
        };
      }
      lastStatus = res.status;
      lastError = await res.text();
      if (res.status === 429) break;
      if (![403, 500, 502, 503, 504].includes(res.status)) break;
    }

    if (lastStatus === 429 && attempt === 0) {
      await sleep(2000);
      continue;
    }
    const geoBlocked =
      lastStatus === 400 && /User location is not supported/i.test(lastError);
    if (geoBlocked && attempt < GEO_RETRIES) {
      weblog(`geo-blocked (400), retry ${attempt + 1}/${GEO_RETRIES} after backoff`);
    }
    if (!geoBlocked) break;
  }

  throw new Error(
    `Antigravity Google search failed (${lastStatus ?? "no response"}): ${lastError.slice(0, 300)}`,
  );
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + "\n\n[Output truncated at 50000 chars]";
}

/** Render a grounding answer for the model with sources. */
export function formatGoogleAnswer(answer: GoogleAnswer, query: string): string {
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
  return truncate(lines.join("\n"));
}
