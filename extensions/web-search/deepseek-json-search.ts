/**
 * DeepSeek Web Search backend via the official DeepSeek Search JSON API.
 *
 * This is the *stateless* search primitive (no model call, no token billing):
 *   POST {baseURL}/search
 *   Endpoint: https://api.deepseek.com/v1/tools/search
 *   Auth:     Authorization: Bearer <DeepSeek API Key>
 *
 * The API key is resolved by the caller (see resolveDeepSeekApiKey in
 * ./deepseek-search.ts: DEEPSEEK_API_KEY, or /login deepseek).
 *
 * Request fields:
 * - query          string  required  search terms (1-128 chars); search syntax is passed through:
 *                                   site: / -site: / -"phrase" / "exact phrase" / lang:zh,en / after:YYYY[-MM-DD] / before:...
 * - count          integer optional  1-50, default 10
 * - ori_question   string  optional  the user's original question (1-128 chars), improves intent understanding
 * - need_content   boolean optional  when true, "content" carries the rendered page body (Markdown)
 * - localization   string  optional  IP address used to prefer localized results
 *
 * Response: { results: [{ rerank_score, title, url, snippet, summary, content, site_name, site_icon, date, authority }] }
 * - rerank_score: 0-3, >= 1.5 are considered good results
 * - authority:    0-4 (-1 unknown), >= 3 are extremely authoritative
 * - snippet:      100-200 chars, for display
 * - summary:      600-800 chars, intended to be read by a model
 * - content:      page body, empty unless need_content was true (or the body was missing)
 *
 * Notes:
 * - Billing is per *successful* request (HTTP 200 with a non-empty results array), not per token.
 * - QPS is limited to 5 per account; HTTP 429 means the limit was hit.
 * - The backend crawler runs in mainland China: GFW-blocked hosts (google.com, x.com, ...) fail,
 *   and it renders JavaScript (SPA/CSR pages work). Dates come from upstream indexing and can be
 *   imprecise; after:/before: bias rather than hard-filter.
 *
 * Distinct from ./deepseek-search.ts, which drives the Anthropic-compatible
 * /anthropic/v1/messages endpoint with the server-side web_search_20250305 tool
 * (model call, token-billed, model-synthesized answer).
 */

import { appendFileSync } from "node:fs";

function weblog(message: string): void {
  try {
    appendFileSync("/tmp/pi-web-tools.log", `${new Date().toISOString()} [web-search:deepseek-json] ${message}\n`);
  } catch {
    // logging must never break the extension
  }
}

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1/tools";
const DEFAULT_COUNT = 10;
const MAX_OUTPUT_CHARS = 50_000;
const MAX_CONTENT_CHARS = 4_000;

export interface DeepSeekJsonSearchParams {
  query: string;
  count?: number;
  need_content?: boolean;
  ori_question?: string;
  localization?: string;
}

export interface DeepSeekJsonResultItem {
  rerank_score?: number;
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  content?: string;
  site_name?: string | null;
  site_icon?: string | null;
  date?: string | null;
  authority?: number;
}

interface DeepSeekJsonResponse {
  results?: DeepSeekJsonResultItem[];
}

interface DeepSeekJsonError {
  error?: { message?: string; type?: string; code?: string } | string;
  message?: string;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) + "..." : text;
}

function formatMeta(item: DeepSeekJsonResultItem): string {
  const parts: string[] = [];
  if (item.site_name) parts.push(item.site_name);
  if (typeof item.rerank_score === "number") parts.push(`rerank ${item.rerank_score.toFixed(2)}`);
  if (typeof item.authority === "number" && item.authority >= 0) parts.push(`authority ${item.authority}`);
  if (item.date) parts.push(item.date);
  return parts.join(" | ");
}

export function formatDeepSeekJsonResults(
  results: readonly DeepSeekJsonResultItem[],
  query: string,
): string {
  if (results.length === 0) {
    return `(No results returned for query: ${query})`;
  }

  const lines: string[] = [];
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
      lines.push(`    Content: ${truncate(r.content.trim(), MAX_CONTENT_CHARS)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

export async function deepseekJsonSearch(
  apiKey: string,
  params: DeepSeekJsonSearchParams,
  signal?: AbortSignal,
): Promise<{ text: string; count: number; results: DeepSeekJsonResultItem[] }> {
  const baseURL = (process.env.DEEPSEEK_SEARCH_JSON_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const endpoint = `${baseURL}/search`;

  const body: Record<string, unknown> = {
    query: params.query,
    count: params.count ?? DEFAULT_COUNT,
  };
  if (params.need_content !== undefined) body.need_content = params.need_content;
  if (params.ori_question?.trim()) body.ori_question = params.ori_question.trim();
  if (params.localization?.trim()) body.localization = params.localization.trim();

  weblog(
    `deepseekJsonSearch endpoint=${endpoint} query="${params.query.slice(0, 80)}" body=${JSON.stringify(body)}`,
  );

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "pi-web-search/1.0 (deepseek-search-json)",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const errJson = (await res.json()) as DeepSeekJsonError;
      detail =
        typeof errJson.error === "string"
          ? errJson.error
          : errJson.error?.message ?? errJson.message ?? detail;
    } catch {
      // fallback: keep the status line
    }
    const hint =
      res.status === 429
        ? " (rate limited: 5 QPS per account, retry shortly)"
        : res.status === 402
          ? " (insufficient balance)"
          : res.status === 401
            ? " (missing or invalid API key)"
            : "";
    throw new Error(`DeepSeek Search JSON API failed: ${detail}${hint}`);
  }

  const payload = (await res.json()) as DeepSeekJsonResponse;
  const results = payload.results ?? [];

  let text = formatDeepSeekJsonResults(results, params.query);
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS) + "\n\n[Output truncated at 50000 chars]";
  }

  weblog(`deepseekJsonSearch done results=${results.length}`);

  return { text, count: results.length, results };
}
