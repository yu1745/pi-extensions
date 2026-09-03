/**
 * DeepSeek Web Search backend via DeepSeek's Anthropic-compatible Messages API.
 *
 * Implemented directly from deepseek-ai/deepseek-harness (packages/web/web-search-deepseek):
 * Endpoint: POST {baseURL}/messages (Default: https://api.deepseek.com/anthropic/v1/messages)
 * Model: deepseek-v4-flash (or DEEPSEEK_SEARCH_MODEL)
 * Tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
 * Headers:
 *   x-api-key: {apiKey}
 *   authorization: Bearer {apiKey}
 *   anthropic-version: 2023-06-01
 *
 * Results extraction:
 * - content blocks with type: "web_search_tool_result" contain sources: [{ type: "web_search_result", url, title, page_age }]
 * - text blocks contain citations: [{ url, cited_text }] which provide snippet excerpts.
 */

import { appendFileSync } from "node:fs";
import type { ToolAuthCtx } from "./google-search.js";

function weblog(message: string): void {
  try {
    appendFileSync("/tmp/pi-web-tools.log", `${new Date().toISOString()} [web-search:deepseek] ${message}\n`);
  } catch {
    // ignore
  }
}

const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic/v1";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_API_VERSION = "2023-06-01";
const MAX_OUTPUT_CHARS = 50_000;

interface WebSearchResultItem {
  type: string;
  url: string;
  title?: string | null;
  page_age?: string | null;
}

interface WebSearchToolResultBlock {
  type: "web_search_tool_result";
  content?: WebSearchResultItem[];
}

interface CitationLocation {
  type?: string;
  url?: string | null;
  cited_text?: string | null;
}

interface TextBlock {
  type: "text";
  text?: string | null;
  citations?: CitationLocation[];
}

type ContentBlock = WebSearchToolResultBlock | TextBlock | { type: string; [key: string]: unknown };

interface AnthropicResponse {
  content?: ContentBlock[];
}

interface AnthropicError {
  error?: { message?: string } | string;
  message?: string;
}

export interface DeepSeekSearchSource {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

/**
 * Resolve DeepSeek API key:
 * Env DEEPSEEK_API_KEY -> pi auth for "deepseek".
 */
export async function resolveDeepSeekApiKey(ctx: ToolAuthCtx): Promise<string> {
  const envKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (envKey) return envKey;

  const auth = await ctx.modelRegistry.getProviderAuth("deepseek");
  const key = auth?.auth?.apiKey?.trim();
  if (key) return key;

  throw new Error(
    'No DeepSeek API key found: set DEEPSEEK_API_KEY env var, or run /login deepseek.',
  );
}

function extractSnippets(blocks: readonly ContentBlock[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of blocks) {
    if (block.type !== "text") continue;
    const textBlock = block as TextBlock;
    for (const cite of textBlock.citations ?? []) {
      if (cite.url && cite.cited_text && !map.has(cite.url)) {
        map.set(cite.url, cite.cited_text);
      }
    }
  }
  return map;
}

export async function deepseekSearch(
  apiKey: string,
  query: string,
  signal?: AbortSignal,
): Promise<{ text: string; count: number; answer?: string }> {
  const baseURL = (process.env.DEEPSEEK_SEARCH_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = process.env.DEEPSEEK_SEARCH_MODEL?.trim() || DEFAULT_MODEL;
  const endpoint = `${baseURL}/messages`;

  weblog(`deepseekSearch endpoint=${endpoint} model=${model} query="${query.slice(0, 80)}"`);

  const body = {
    model,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `Perform a web search for the query: ${query}` }],
      },
    ],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 5,
      },
    ],
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      authorization: `Bearer ${apiKey}`,
      "anthropic-version": DEFAULT_API_VERSION,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "deepseek-harness/0.0.1 (pi-web-search)",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const errJson = (await res.json()) as AnthropicError;
      detail = typeof errJson.error === "string" ? errJson.error : errJson.error?.message ?? errJson.message ?? detail;
    } catch {
      // fallback
    }
    throw new Error(`DeepSeek search failed: ${detail}`);
  }

  const payload = (await res.json()) as AnthropicResponse;
  const blocks = payload.content ?? [];

  // Extract answer text from model
  const answerParts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      const t = (block as TextBlock).text;
      if (t) answerParts.push(t);
    }
  }

  // Extract structured sources
  const resultBlocks = blocks.filter(
    (b): b is WebSearchToolResultBlock => b.type === "web_search_tool_result",
  );

  const snippets = extractSnippets(blocks);
  const seen = new Set<string>();
  const sources: DeepSeekSearchSource[] = [];

  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== "web_search_result" || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      sources.push({
        url: item.url,
        title: item.title ?? undefined,
        snippet: snippets.get(item.url),
        publishedAt: item.page_age ?? undefined,
      });
    }
  }

  const lines: string[] = [];
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
      lines.push(`[${i + 1}] ${title}${age} — ${s.url}`);
      if (s.snippet) {
        lines.push(`    ${s.snippet}`);
      }
    }
  }

  let text = lines.join("\n").trim();
  if (!text) {
    text = `(No results returned for query: ${query})`;
  }

  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS) + "\n\n[Output truncated at 50000 chars]";
  }

  return {
    text,
    count: sources.length,
    answer: synthesized || undefined,
  };
}
