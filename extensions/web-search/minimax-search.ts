/**
 * MiniMax Web Search backend via MiniMax Coding Plan API.
 *
 * Discovered from minimax-coding-plan-mcp:
 * Endpoint: POST {apiHost}/v1/coding_plan/search
 * Headers:
 *   Authorization: Bearer {apiKey}
 *   MM-API-Source: Minimax-MCP
 *   Content-Type: application/json
 * Body:
 *   { "q": query }
 */

import { appendFileSync } from "node:fs";
import type { ToolAuthCtx } from "./google-search.js";

function weblog(message: string): void {
  try {
    appendFileSync("/tmp/pi-web-tools.log", `${new Date().toISOString()} [web-search:minimax] ${message}\n`);
  } catch {
    // ignore
  }
}

const DEFAULT_MINIMAX_HOST = "https://api.minimaxi.com";
const MAX_OUTPUT_CHARS = 50_000;

export interface MinimaxSearchResultItem {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
}

export interface MinimaxSearchResponse {
  organic?: MinimaxSearchResultItem[];
  related_searches?: Array<{ query?: string }>;
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
}

/**
 * Resolve MiniMax API key & host.
 * Precedence:
 * Key: env MINIMAX_API_KEY -> pi auth for "minimax-cn" -> pi auth for "minimax"
 * Host: env MINIMAX_API_HOST -> "https://api.minimaxi.com"
 */
export async function resolveMinimaxAuth(
  ctx: ToolAuthCtx,
): Promise<{ apiKey: string; apiHost: string }> {
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
      'No MiniMax credentials found: set MINIMAX_API_KEY env var or run /login minimax-cn (or /login minimax).',
    );
  }

  return { apiKey, apiHost: apiHost.replace(/\/+$/, "") };
}

export async function minimaxSearch(
  apiKey: string,
  apiHost: string,
  query: string,
  signal?: AbortSignal,
): Promise<{ text: string; count: number }> {
  const url = `${apiHost}/v1/coding_plan/search`;
  weblog(`minimaxSearch calling url=${url} query="${query.slice(0, 80)}"`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "MM-API-Source": "Minimax-MCP",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MiniMax search request failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as MinimaxSearchResponse;
  const baseResp = data.base_resp;
  if (baseResp && baseResp.status_code !== undefined && baseResp.status_code !== 0) {
    if (baseResp.status_code === 1004) {
      throw new Error(`MiniMax search auth error: ${baseResp.status_msg} (check MINIMAX_API_KEY and host)`);
    }
    if (baseResp.status_code === 2038) {
      throw new Error(`MiniMax search error: real-name verification required (${baseResp.status_msg})`);
    }
    throw new Error(`MiniMax API error (${baseResp.status_code}): ${baseResp.status_msg}`);
  }

  const organic = data.organic ?? [];
  const lines: string[] = [];

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

  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS) + "\n\n[Output truncated at 50000 chars]";
  }

  return { text, count: organic.length };
}
