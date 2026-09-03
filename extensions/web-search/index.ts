/**
 * Web Search Extension
 *
 * Registers the web_search tool matching the configured backend:
 * - Google (Antigravity Grounding): Pure query, operator-aware, synthesized answers + verified source URLs
 * - OpenAI (Codex Responses API): Pure query, operator-aware, GPT-5.6 / web_search
 * - DeepSeek (Anthropic-compatible API): Pure query, deepseek-v4-flash native web_search
 * - MiniMax (Coding Plan API): Fast technical keywords search, structured results
 * - Z.AI (BigModel): Native MCP schema with location, recency, and domain filters
 *
 * Each backend gets its exact native schema and truthful tool guidelines.
 * Switch backend via `/websearch.backend [google|openai|deepseek|minimax|zai]`.
 * (Changes apply upon /reload or next session to ensure prompt & schema integrity)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync } from "node:fs";
import {
  getWebSearchBackend,
  setWebSearchBackend,
  type WebSearchBackend,
} from "./backend-config.js";
import {
  formatGoogleAnswer,
  googleGroundingSearch,
  resolveAntigravityToken,
} from "./google-search.js";
import {
  openAiCodexSearch,
  resolveOpenAICodexAuth,
} from "./openai-search.js";
import {
  deepseekSearch,
  resolveDeepSeekApiKey,
} from "./deepseek-search.js";
import {
  minimaxSearch,
  resolveMinimaxAuth,
} from "./minimax-search.js";
import {
  resolveZaiApiKey,
  zaiSearch,
} from "./zai-search.js";

function weblog(message: string): void {
  try {
    appendFileSync("/tmp/pi-web-tools.log", `${new Date().toISOString()} [web-search] ${message}\n`);
  } catch {
    // ignore
  }
}

function emitOutput(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (type === "warning" || type === "error") console.error(text);
  else console.log(text);
}

export default function webSearchExtension(pi: ExtensionAPI) {
  const currentBackend = getWebSearchBackend();

  // ── /websearch.backend command with interactive UI selection ─────────────

  pi.registerCommand("websearch.backend", {
    description:
      "Select web_search backend (Google, OpenAI, DeepSeek, MiniMax, Z.AI) via interactive menu or argument.",
    handler: async (args, ctx) => {
      const rawArg = (args || "").trim().toLowerCase();
      const active = getWebSearchBackend();

      const applySelection = (selected: WebSearchBackend) => {
        setWebSearchBackend(selected);
        const tip =
          selected === active
            ? `web_search backend remains: ${selected}`
            : `web_search backend set to: ${selected} (已保存至 settings.json)。\n提示：为保证工具 Schema 与系统提示词绝对精准，变更将在 /reload 或下次会话生效。`;
        emitOutput(ctx, tip);
      };

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
      if (rawArg === "minimax" || rawArg === "mm") {
        applySelection("minimax");
        return;
      }
      if (rawArg === "zai" || rawArg === "bigmodel" || rawArg === "0" || rawArg === "off") {
        applySelection("zai");
        return;
      }

      // No argument: Interactive menu via ctx.ui.select
      if (ctx.hasUI) {
        const options = [
          `google   - Google (Antigravity Grounding / Gemini 实时检索)${active === "google" ? " (当前生效)" : ""}`,
          `openai   - OpenAI (Codex Responses API / GPT-5.6 实时检索)${active === "openai" ? " (当前生效)" : ""}`,
          `deepseek - DeepSeek (Anthropic 协议原生 web_search 工具)${active === "deepseek" ? " (当前生效)" : ""}`,
          `minimax  - MiniMax (Coding Plan 快速代码/工程实时检索)${active === "minimax" ? " (当前生效)" : ""}`,
          `zai      - 智谱 BigModel / Z.AI (带地域/时效原生参数过滤)${active === "zai" ? " (当前生效)" : ""}`,
        ];

        const choice = await ctx.ui.select(
          `选择 web_search 后端 (当前会话生效: ${active}):`,
          options,
        );

        if (!choice) return;

        let selected: WebSearchBackend = "google";
        if (choice.startsWith("google")) selected = "google";
        else if (choice.startsWith("openai")) selected = "openai";
        else if (choice.startsWith("deepseek")) selected = "deepseek";
        else if (choice.startsWith("minimax")) selected = "minimax";
        else if (choice.startsWith("zai")) selected = "zai";

        applySelection(selected);
        return;
      }

      emitOutput(
        ctx,
        `Current backend: ${active}\nUsage: /websearch.backend [google | openai | deepseek | minimax | zai]`,
      );
    },
  });

  // ── Native Tool Registrations (Truthful Schemas & Prompts) ───────────────

  switch (currentBackend) {
    // ── 1. Google (Antigravity Grounding)
    case "google": {
      pi.registerTool({
        name: "web_search",
        label: "Web Search (Google)",
        description:
          "Search the web using Google Search via Antigravity Grounding. " +
          "Returns real-time search synthesis and verified destination URLs. " +
          "Supports Google search operators natively (e.g. 'site:example.com', '\"exact quote\"', '-exclude', 'after:2026-01').",
        promptSnippet: "Search Google for up-to-date web content, documentation, or facts",
        promptGuidelines: [
          "Use web_search when you need real-time data, official documentation, current news, or external technical references.",
          "Supports native Google search operators directly in the query: site:github.com, quotes, etc.",
        ],
        parameters: Type.Object({
          query: Type.String({
            description: "Google search query. Supports Google syntax (e.g. 'query site:github.com', quotes, after:YYYY-MM).",
          }),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          weblog(`Google search execute: query="${params.query.slice(0, 80)}"`);
          const creds = await resolveAntigravityToken(ctx);
          const answer = await googleGroundingSearch(
            creds.token,
            creds.projectId,
            params.query,
            signal,
          );
          return {
            content: [{ type: "text", text: formatGoogleAnswer(answer, params.query) }],
            details: {
              query: params.query,
              source: "Google Search (Antigravity Grounding)",
              googleQueries: answer.queries,
              sourceCount: answer.sources.length,
            },
          };
        },
      });
      break;
    }

    // ── 2. OpenAI (Codex Responses API)
    case "openai": {
      pi.registerTool({
        name: "web_search",
        label: "Web Search (OpenAI)",
        description:
          "Search the web using OpenAI Codex web search. " +
          "Executes real-time web retrieval with synthesized answers and cited web sources.",
        promptSnippet: "Search the web with OpenAI for real-time information",
        promptGuidelines: [
          "Use web_search when you need up-to-date information, documentation, or facts.",
          "Write clean, keyword-dense queries for best retrieval accuracy.",
        ],
        parameters: Type.Object({
          query: Type.String({
            description: "Search query. Supports standard search operators and keywords.",
          }),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          weblog(`OpenAI search execute: query="${params.query.slice(0, 80)}"`);
          const { token, accountId } = await resolveOpenAICodexAuth(ctx);
          const { text, count } = await openAiCodexSearch(token, accountId, params.query, signal);
          return {
            content: [{ type: "text", text }],
            details: {
              query: params.query,
              source: "OpenAI Codex Responses Search",
              sourceCount: count,
            },
          };
        },
      });
      break;
    }

    // ── 3. DeepSeek (Anthropic-Compatible Native Tool)
    case "deepseek": {
      pi.registerTool({
        name: "web_search",
        label: "Web Search (DeepSeek)",
        description:
          "Search the web using DeepSeek's native web search capability. " +
          "Returns grounded web findings, relevant citations, and source URLs.",
        promptSnippet: "Perform a web search using DeepSeek's native search engine",
        promptGuidelines: [
          "Use web_search when answering questions requiring real-time data or latest technical releases.",
        ],
        parameters: Type.Object({
          query: Type.String({
            description: "The search query to look up on the web.",
          }),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          weblog(`DeepSeek search execute: query="${params.query.slice(0, 80)}"`);
          const apiKey = await resolveDeepSeekApiKey(ctx);
          const { text, count } = await deepseekSearch(apiKey, params.query, signal);
          return {
            content: [{ type: "text", text }],
            details: {
              query: params.query,
              source: "DeepSeek native web search",
              sourceCount: count,
            },
          };
        },
      });
      break;
    }

    // ── 4. MiniMax (Coding Plan Search API)
    case "minimax": {
      pi.registerTool({
        name: "web_search",
        label: "Web Search (MiniMax)",
        description:
          "Search the web using MiniMax Coding Plan search API. " +
          "Fast technical and real-time search engine returning organic web links and snippets.",
        promptSnippet: "Search technical and external web data via MiniMax",
        promptGuidelines: [
          "Aim for 3-5 keywords for best results. For time-sensitive topics, include the current year/date.",
          "If no useful results are returned, try rephrasing with different keywords.",
        ],
        parameters: Type.Object({
          query: Type.String({
            description: "Search keywords (recommended 3-5 concise keywords).",
          }),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          weblog(`MiniMax search execute: query="${params.query.slice(0, 80)}"`);
          const { apiKey, apiHost } = await resolveMinimaxAuth(ctx);
          const { text, count } = await minimaxSearch(apiKey, apiHost, params.query, signal);
          return {
            content: [{ type: "text", text }],
            details: {
              query: params.query,
              source: "MiniMax Coding Plan Search API",
              sourceCount: count,
            },
          };
        },
      });
      break;
    }

    // ── 5. Z.AI (BigModel Web Search Prime MCP)
    case "zai": {
      pi.registerTool({
        name: "web_search",
        label: "Web Search (Z.AI)",
        description:
          "Search the web using Z.AI Web Search Prime. " +
          "Supports native regional targeting, recency filtering, and domain filtering.",
        promptSnippet: "Search the web with regional and recency filters using Z.AI",
        promptGuidelines: [
          "Use web_search when you need real-time data with specific recency or location filters.",
          "For Chinese content set location 'cn'; for international set 'us'.",
        ],
        parameters: Type.Object({
          query: Type.String({
            description: "Search query. Use 'site:<domain>' for domain filtering.",
          }),
          location: Type.Optional(
            Type.Union([Type.Literal("cn"), Type.Literal("us")], {
              description: "Search region: 'cn' for China, 'us' for global/US.",
            }),
          ),
          recency: Type.Optional(
            Type.Union(
              [
                Type.Literal("oneDay"),
                Type.Literal("oneWeek"),
                Type.Literal("oneMonth"),
                Type.Literal("oneYear"),
                Type.Literal("noLimit"),
              ],
              {
                description: "Filter results by publication recency.",
              },
            ),
          ),
          domain_filter: Type.Optional(
            Type.String({
              description: "Target domain filter (or specify 'site:<domain>' in query).",
            }),
          ),
          content_size: Type.Optional(
            Type.Union([Type.Literal("medium"), Type.Literal("high")], {
              description: "Result snippet detail level.",
            }),
          ),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          weblog(`Z.AI search execute: query="${params.query.slice(0, 80)}"`);
          const apiKey = await resolveZaiApiKey(ctx);
          const { text } = await zaiSearch(apiKey, params, signal);
          return {
            content: [{ type: "text", text }],
            details: {
              query: params.query,
              source: "Z.AI Web Search Prime",
              location: params.location,
              recency: params.recency,
            },
          };
        },
      });
      break;
    }
  }
}
