/**
 * OpenAI Codex Web Search backend via Codex Responses API.
 *
 * Calls the Responses API with native `web_search` tool enabled:
 * Endpoint: POST https://chatgpt.com/backend-api/latents/codex/responses
 * Headers:
 *   Authorization: Bearer <accessToken>
 *   chatgpt-account-id: <accountId>
 *   OpenAI-Beta: responses=v1
 *   OpenAI-Originator: codex
 *   Accept: text/event-stream
 *
 * Body:
 *   {
 *     model: "gpt-5.6-luna",
 *     stream: true,
 *     store: false,
 *     include: ["web_search_call.action.sources"],
 *     tools: [{ type: "web_search", search_context_size: "high" }],
 *     tool_choice: { type: "web_search" },
 *     input: [{ type: "message", role: "user", content: [{ type: "input_text", text: query }] }]
 *   }
 */

import os from "node:os";
import { appendFileSync } from "node:fs";
import type { ToolAuthCtx } from "./google-search.js";

function getPiUserAgent(): string {
  return `pi (${os.platform()} ${os.release()}; ${os.arch()})`;
}

function weblog(message: string): void {
  try {
    appendFileSync("/tmp/pi-web-tools.log", `${new Date().toISOString()} [web-search:openai] ${message}\n`);
  } catch {
    // ignore
  }
}

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_CLIENT_VERSION = "0.144.1";
const DEFAULT_CANDIDATE_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5-codex",
];
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const MAX_OUTPUT_CHARS = 50_000;

function resolveCodexResponsesUrl(baseUrl?: string): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

interface CodexWebSearchSource {
  url?: string;
  source_website_url?: string;
  title?: string;
  caption?: string;
}

interface CodexAnnotation {
  type: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

interface CodexContentPart {
  type: string;
  text?: string;
  annotations?: CodexAnnotation[];
}

interface CodexResponseItem {
  type: string;
  content?: CodexContentPart[];
  action?: { sources?: CodexWebSearchSource[] };
  sources?: CodexWebSearchSource[];
  results?: CodexWebSearchSource[];
}

export interface OpenAISearchSource {
  url: string;
  title?: string;
  snippet?: string;
}

/**
 * Extract chatgpt_account_id from JWT token payload.
 */
function extractAccountId(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8")) as Record<string, unknown>;
    const authData = payload?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
    return (authData?.chatgpt_account_id as string) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve OpenAI Codex auth:
 * Env OPENAI_API_KEY -> pi auth for "openai-codex"
 */
export async function resolveOpenAICodexAuth(
  ctx: ToolAuthCtx,
): Promise<{ token: string; accountId?: string }> {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) {
    return { token: envKey, accountId: extractAccountId(envKey) };
  }

  const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
  const rawKey = auth?.auth?.apiKey?.trim();
  if (!rawKey) {
    throw new Error(
      'No OpenAI credentials found: set OPENAI_API_KEY env var or run /login openai-codex.',
    );
  }

  return {
    token: rawKey,
    accountId: extractAccountId(rawKey),
  };
}

function extractCitationSnippet(text: string, start?: number, end?: number): string | undefined {
  if (start === undefined || end === undefined || !text) return undefined;
  const before = Math.max(0, start - 100);
  const after = Math.min(text.length, end + 100);
  const snippet = text
    .slice(before, after)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
  if (!snippet) return undefined;
  return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

async function callSingleModel(
  url: string,
  model: string,
  token: string,
  accountId: string | undefined,
  query: string,
  signal?: AbortSignal,
): Promise<{ answer: string; sources: OpenAISearchSource[] }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "OpenAI-Beta": "responses=experimental",
    originator: "pi",
    version: CODEX_CLIENT_VERSION,
    "User-Agent": getPiUserAgent(),
    Accept: "text/event-stream",
    "Content-Type": "application/json",
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
        content: [{ type: "input_text", text: query }],
      },
    ],
    tools: [
      {
        type: "web_search",
        search_context_size: "high",
      },
    ],
    tool_choice: { type: "web_search" },
    instructions:
      "You are a helpful assistant with web search capabilities. Search the web to answer the user's question accurately and cite your sources.",
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
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

  const answerParts: string[] = [];
  const sources: OpenAISearchSource[] = [];
  const seenUrls = new Set<string>();

  const addSource = (src: OpenAISearchSource) => {
    if (!src.url || seenUrls.has(src.url)) return;
    seenUrls.add(src.url);
    sources.push(src);
  };

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

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(dataStr) as Record<string, unknown>;
      } catch {
        continue;
      }

      const eventType = typeof event.type === "string" ? event.type : "";

      if (eventType === "response.output_item.done") {
        const item = event.item as CodexResponseItem | undefined;
        if (!item) continue;

        // 1. Sources from web_search_call action
        if (item.type === "web_search_call") {
          const groups = [item.action?.sources, item.sources, item.results];
          for (const g of groups) {
            for (const s of g ?? []) {
              const u = s.url ?? s.source_website_url;
              if (u) addSource({ url: u, title: s.title ?? s.caption ?? u });
            }
          }
        }

        // 2. Output text and citation annotations
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
                      snippet: extractCitationSnippet(part.text, ann.start_index, ann.end_index),
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
    sources,
  };
}

export async function openAiCodexSearch(
  token: string,
  accountId: string | undefined,
  query: string,
  signal?: AbortSignal,
): Promise<{ text: string; count: number; answer?: string }> {
  const url = resolveCodexResponsesUrl(process.env.OPENAI_CODEX_BASE_URL);
  const configuredModel = process.env.OPENAI_CODEX_SEARCH_MODEL?.trim();
  const models = configuredModel ? [configuredModel] : DEFAULT_CANDIDATE_MODELS;

  let lastError: unknown;
  for (const model of models) {
    try {
      weblog(`trying model=${model} query="${query.slice(0, 80)}"`);
      const result = await callSingleModel(url, model, token, accountId, query, signal);

      const lines: string[] = [];
      if (result.answer) {
        lines.push(result.answer);
        lines.push("");
      }

      if (result.sources.length > 0) {
        lines.push("Sources:");
        for (let i = 0; i < result.sources.length; i++) {
          const s = result.sources[i];
          lines.push(`[${i + 1}] ${s.title || "(untitled)"} — ${s.url}`);
          if (s.snippet) {
            lines.push(`    ${s.snippet}`);
          }
        }
      }

      let text = lines.join("\n").trim();
      if (!text) {
        text = `(No synthesized answer for query: ${query})`;
      }
      if (text.length > MAX_OUTPUT_CHARS) {
        text = text.slice(0, MAX_OUTPUT_CHARS) + "\n\n[Output truncated at 50000 chars]";
      }

      return {
        text,
        count: result.sources.length,
        answer: result.answer || undefined,
      };
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      weblog(`model ${model} failed: ${msg}`);
      // If user pinned a model, don't fall back to others
      if (configuredModel) throw err;
      // If error is not a model compatibility error, stop hammering
      if (!/model is not supported|invalid_request_error|not found|400|404/i.test(msg)) {
        throw err;
      }
    }
  }

  throw lastError || new Error("All OpenAI Codex search model candidates failed");
}
