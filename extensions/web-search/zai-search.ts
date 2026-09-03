/**
 * Z.AI (BigModel) Web Search backend via MCP Streamable HTTP transport.
 */

import { appendFileSync } from "node:fs";
import type { ToolAuthCtx } from "./google-search.js";

function weblog(message: string): void {
  try {
    appendFileSync("/tmp/pi-web-tools.log", `${new Date().toISOString()} [pi-extensions] ${message}\n`);
  } catch {
    // logging must never break the extension
  }
}

const MCP_SEARCH_URL = "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp";
const MAX_OUTPUT_BYTES = 50_000;
const MAX_OUTPUT_CHARS = 80_000;

export interface ZaiSearchParams {
  query: string;
  location?: "cn" | "us";
  recency?: "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";
  domain_filter?: string;
  content_size?: "medium" | "high";
}

export interface ZaiSearchResult {
  title?: string;
  link?: string;
  url?: string;
  content?: string;
  snippet?: string;
  refer?: string;
  siteName?: string;
  description?: string;
}

/**
 * Resolve the Z.AI API key: env var first, then zai-coding-cn provider auth.
 */
export async function resolveZaiApiKey(ctx: ToolAuthCtx): Promise<string> {
  const envKey = process.env.Z_AI_MCP_API_KEY;
  if (envKey) return envKey;
  const result = await ctx.modelRegistry.getProviderAuth("zai-coding-cn");
  const key = result?.auth?.apiKey;
  if (!key) {
    throw new Error(
      'No Z.AI API key: set Z_AI_MCP_API_KEY env var, or run /login zai-coding-cn (or configure its API key) and retry.',
    );
  }
  return key;
}

/**
 * Parse SSE text to extract JSON data from "data:" lines.
 */
function parseSSE(text: string): unknown {
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      const jsonStr = trimmed.slice(5).trim();
      if (!jsonStr) continue;
      try {
        const parsed = JSON.parse(jsonStr) as { result?: unknown };
        if (parsed && typeof parsed === "object" && "result" in parsed) {
          const result = parsed.result;
          if (result && typeof result === "object" && "content" in result) {
            const content = (result as { content: Array<{ type: string; text: string }> }).content;
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
        // Skip unparseable lines
      }
    }
  }
  return text;
}

async function mcpCall(
  apiKey: string,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ sessionId: string; data?: unknown }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  const initPayload = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-web-search-ext", version: "1.0.0" },
    },
  };

  const initResp = await fetch(MCP_SEARCH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(initPayload),
    signal,
  });

  if (!initResp.ok) {
    throw new Error(`MCP initialize failed: ${initResp.status} ${initResp.statusText}`);
  }

  const sessionId =
    initResp.headers.get("mcp-session-id") ??
    initResp.headers.get("Mcp-Session-Id") ??
    "";

  const callPayload = {
    jsonrpc: "2.0",
    id: 2,
    method,
    params,
  };

  const callHeaders = { ...headers };
  if (sessionId) {
    callHeaders["Mcp-Session-Id"] = sessionId;
  }

  const callResp = await fetch(MCP_SEARCH_URL, {
    method: "POST",
    headers: callHeaders,
    body: JSON.stringify(callPayload),
    signal,
  });

  if (!callResp.ok) {
    throw new Error(`MCP call failed: ${callResp.status} ${callResp.statusText}`);
  }

  const callText = await callResp.text();
  const data = parseSSE(callText);
  return { sessionId, data };
}

function formatSearchResults(results: ZaiSearchResult[]): string {
  const lines: string[] = [];
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

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS && Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) {
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
  return (
    truncated +
    `\n\n[Output truncated: ${byteLen} bytes of ${Buffer.byteLength(text, "utf8")} bytes]`
  );
}

export async function zaiSearch(
  apiKey: string,
  params: ZaiSearchParams,
  signal?: AbortSignal,
): Promise<{ text: string }> {
  const args: Record<string, unknown> = {
    search_query: params.query,
  };
  if (params.location) args.location = params.location;
  if (params.recency) args.search_recency_filter = params.recency;
  if (params.domain_filter) args.search_domain_filter = params.domain_filter;
  if (params.content_size) args.content_size = params.content_size;

  weblog(`zaiSearch query="${params.query.slice(0, 80)}"`);
  const result = await mcpCall(
    apiKey,
    "tools/call",
    {
      name: "web_search_prime",
      arguments: args,
    },
    signal,
  );

  let outputText: string;
  if (typeof result.data === "string") {
    outputText = result.data;
  } else if (result.data && typeof result.data === "object" && "content" in result.data) {
    const content = (result.data as { content: Array<{ type: string; text: string }> }).content;
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
    outputText = formatSearchResults(result.data as ZaiSearchResult[]);
  } else {
    outputText = JSON.stringify(result.data, null, 2);
  }

  return { text: truncateOutput(outputText) };
}
