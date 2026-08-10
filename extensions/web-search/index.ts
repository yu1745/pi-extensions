/**
 * Web Search Extension
 *
 * Provides web search and web page reading tools using Z.AI MCP services.
 * Requires API key from open.bigmodel.cn (Z.AI).
 *
 * Tools:
 * - web_search: Search the web and return results with titles, URLs, and summaries
 * - web_reader: Fetch and convert a URL to markdown/text for LLM consumption
 *
 * Usage:
 * 1. Copy to ~/.pi/agent/extensions/web-search/
 * 2. Ensure Z_AI_MCP_API_KEY env var is set, or configure in settings
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── Config ────────────────────────────────────────────────────────────────────

interface MCPConfig {
  searchUrl: string;
  readerUrl: string;
}

function getConfig(): MCPConfig {
  return {
    searchUrl: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
    readerUrl: "https://open.bigmodel.cn/api/mcp/web_reader/mcp",
  };
}

// Minimal structural type for the bit of ctx we need, so we don't pull in
// the full AuthResult type from pi-ai.
interface ProviderAuthCtx {
  modelRegistry: {
    getProviderAuth(provider: string): Promise<
      | { auth?: { apiKey?: string } }
      | undefined
    >;
  };
}

/**
 * Resolve the Z.AI API key: env var first, then the zai-coding-cn provider
 * auth (independent of which provider/model the current session uses).
 */
async function resolveApiKey(ctx: ProviderAuthCtx): Promise<string> {
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

// ─── MCP Client (Streamable HTTP Transport) ──────────────────────────────────

interface MCPResponse {
  sessionId: string;
  data?: unknown;
}

/**
 * Send a JSON-RPC request over MCP Streamable HTTP transport.
 * Handles initialize + session extraction, then sends the actual call.
 */
async function mcpCall(
  endpoint: string,
  apiKey: string,
  method: string,
  params: Record<string, unknown>,
): Promise<MCPResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  // First request: initialize + capture session ID
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

  const initResp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(initPayload),
  });

  if (!initResp.ok) {
    throw new Error(`MCP initialize failed: ${initResp.status} ${initResp.statusText}`);
  }

  // Extract session ID from response headers
  const sessionId =
    initResp.headers.get("mcp-session-id") ??
    initResp.headers.get("Mcp-Session-Id") ??
    "";

  // Parse SSE response to get initialize result
  const initText = await initResp.text();

  // Second request: actual tool call with session ID
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

  const callResp = await fetch(endpoint, {
    method: "POST",
    headers: callHeaders,
    body: JSON.stringify(callPayload),
  });

  if (!callResp.ok) {
    throw new Error(`MCP call failed: ${callResp.status} ${callResp.statusText}`);
  }

  const callText = await callResp.text();

  // Parse SSE to extract JSON data
  const data = parseSSE(callText);

  return { sessionId, data };
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
        const parsed = JSON.parse(jsonStr);
        // Return the result field from the JSON-RPC response
        if (parsed && typeof parsed === "object" && "result" in parsed) {
          const result = (parsed as { result: unknown }).result;
          // If result has content array, extract text
          if (
            result &&
            typeof result === "object" &&
            "content" in result
          ) {
            const content = (result as { content: Array<{ type: string; text: string }> })
              .content;
            if (Array.isArray(content) && content.length > 0) {
              // text field may be JSON-encoded string
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

// ─── Tool Output Truncation ─────────────────────────────────────────────────

const MAX_OUTPUT_BYTES = 50_000;
const MAX_OUTPUT_CHARS = 80_000;

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS && Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) {
    return text;
  }
  // Truncate by bytes
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

// ─── Extension ────────────────────────────────────────────────────────────────

export default function webSearchExtension(pi: ExtensionAPI) {
  // ── web_search tool ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Z.AI Web Search Prime. Returns results including web page titles, URLs, summaries, website names. Supports domain filtering and recency filters.",
    promptSnippet:
      "Search the web for information, news, documentation, or any online content",
    promptGuidelines: [
      "Use web_search when you need up-to-date information not available in your training data.",
      "Use web_search when the user asks to look something up online, check current prices, find documentation, or verify facts.",
      "web_search: For Chinese content, use location 'cn'. For English/international content, use location 'us'.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Search query (recommended max 70 characters for best results)",
      }),
      location: Type.Optional(
        Type.Union([Type.Literal("cn"), Type.Literal("us")]),
      ),
      recency: Type.Optional(
        Type.Union([
          Type.Literal("oneDay"),
          Type.Literal("oneWeek"),
          Type.Literal("oneMonth"),
          Type.Literal("oneYear"),
          Type.Literal("noLimit"),
        ]),
      ),
      domain_filter: Type.Optional(
        Type.String({
          description:
            "To limit results to a specific domain, do NOT rely on this param — instead append 'site:<domain>' to the query (e.g. query: \"site:v2ex.com pi agent\"), which works reliably.",
        }),
      ),
      content_size: Type.Optional(
        Type.Union([Type.Literal("medium"), Type.Literal("high")]),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = getConfig();
      const apiKey = await resolveApiKey(ctx);

      const args: Record<string, unknown> = {
        search_query: params.query,
      };

      if (params.location) args.location = params.location;
      if (params.recency) args.search_recency_filter = params.recency;
      if (params.domain_filter) args.search_domain_filter = params.domain_filter;
      if (params.content_size) args.content_size = params.content_size;

      const result = await mcpCall(
        config.searchUrl,
        apiKey,
        "tools/call",
        {
          name: "web_search_prime",
          arguments: args,
        },
      );

      // Parse search results
      let outputText: string;
      if (typeof result.data === "string") {
        outputText = result.data;
      } else if (
        result.data &&
        typeof result.data === "object" &&
        "content" in result.data
      ) {
        const content = (result.data as { content: Array<{ type: string; text: string }> })
          .content;
        if (Array.isArray(content) && content.length > 0) {
          let raw = content[0].text;
          // May be double-encoded JSON string
          if (typeof raw === "string") {
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                // Format search results
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
      } else {
        outputText = JSON.stringify(result.data, null, 2);
      }

      outputText = truncateOutput(outputText);

      return {
        content: [{ type: "text", text: outputText }],
        details: { query: params.query, source: "Z.AI Web Search Prime" },
      };
    },
  });

  // ── web_reader tool ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "web_reader",
    label: "Web Reader",
    description:
      "Fetch and convert a URL to markdown/text for LLM consumption. Extracts the main content from web pages, removing navigation, ads, and boilerplate.",
    promptSnippet: "Fetch and read the content of a web page URL",
    promptGuidelines: [
      "Use web_reader when you need to read the full content of a specific URL or web page.",
      "Use web_reader after web_search to get detailed content from search results.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch and read" }),
      format: Type.Optional(
        Type.Union([Type.Literal("markdown"), Type.Literal("text")]),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = getConfig();
      const apiKey = await resolveApiKey(ctx);

      const args: Record<string, unknown> = {
        url: params.url,
        return_format: params.format ?? "markdown",
        retain_images: false,
        no_gfm: false,
      };

      const result = await mcpCall(
        config.readerUrl,
        apiKey,
        "tools/call",
        {
          name: "webReader",
          arguments: args,
        },
      );

      // Parse reader result
      let outputText: string;
      if (typeof result.data === "string") {
        outputText = result.data;
      } else if (
        result.data &&
        typeof result.data === "object" &&
        "content" in result.data
      ) {
        const content = (result.data as { content: Array<{ type: string; text: string }> })
          .content;
        if (Array.isArray(content) && content.length > 0) {
          let raw = content[0].text;
          // May be JSON-encoded
          if (typeof raw === "string") {
            try {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object" && "content" in parsed) {
                outputText = (parsed as { content: string }).content;
              } else if (parsed && typeof parsed === "object" && "title" in parsed) {
                const p = parsed as { title: string; content: string; url?: string };
                outputText = `# ${p.title}\n\n${p.content}`;
                if (p.url) {
                  outputText = `Source: ${p.url}\n\n${outputText}`;
                }
              } else {
                outputText = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
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
      } else {
        outputText = JSON.stringify(result.data, null, 2);
      }

      outputText = truncateOutput(outputText);

      return {
        content: [{ type: "text", text: outputText }],
        details: { url: params.url, source: "Z.AI Web Reader" },
      };
    },
  });
}

// ─── Formatting Helpers ────────────────────────────────────────────────────────

interface SearchResult {
  title?: string;
  link?: string;
  url?: string;
  content?: string;
  snippet?: string;
  refer?: string;
  siteName?: string;
  description?: string;
}

function formatSearchResults(results: SearchResult[]): string {
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
      // Trim long descriptions
      const trimmed =
        desc.length > 300 ? desc.slice(0, 300) + "..." : desc;
      lines.push(`   ${trimmed}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
