/**
 * zvec-grep MCP bridge for pi.
 *
 * zvec-grep owns the agent-facing contract. This extension only starts the
 * local MCP server when necessary, discovers its official agent tool schema,
 * and proxies zvec_grep_search to it. Embedding/model/provider settings stay
 * inside zg's configuration and never enter the LLM-facing schema.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ZG = process.platform === "win32" ? "zg.cmd" : "zg";
const MCP_ENDPOINT = process.env.ZVEC_GREP_SERVER_URL ?? "http://127.0.0.1:7999/mcp";
const COMMAND_TIMEOUT = 45_000;
const MCP_TIMEOUT = 5 * 60_000;

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;
type ToolUpdate = Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>>[3];

type JsonObject = Record<string, unknown>;

interface McpTool {
  name: string;
  description?: string;
  inputSchema: JsonObject;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Official zvec-grep agent-tool schema used only when the server is
 * unavailable during session_start. Once reachable, tools/list is authoritative. */
const StringOrStrings = (description: string) => Type.Optional(
  Type.Union([Type.String({ description }), Type.Array(Type.String(), { description })]),
);

const FallbackSearchParameters = Type.Object({
  root: Type.Optional(Type.String({ description: "Workspace root; defaults to pi's current workspace." })),
  query: Type.Optional(Type.String({ description: "One primary hybrid-search group." })),
  queries: StringOrStrings("One or more primary hybrid-search groups."),
  fts: StringOrStrings("Supplemental lexical-route groups."),
  vector: StringOrStrings("Supplemental semantic/vector-route groups."),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum returned items per group or fused plan." })),
  globs: StringOrStrings("Ordered case-sensitive rg-style glob rules."),
  insensitiveGlobs: StringOrStrings("Ordered case-insensitive rg-style glob rules."),
  fileTypes: StringOrStrings("Included ripgrep file types."),
  excludedFileTypes: StringOrStrings("Excluded ripgrep file types."),
  hidden: Type.Optional(Type.Boolean({ description: "Include hidden paths." })),
  noIgnore: Type.Optional(Type.Boolean({ description: "Do not respect ignore files." })),
  ignoreFiles: StringOrStrings("Additional ignore files relative to the workspace root."),
  maxDepth: Type.Optional(Type.Integer({ minimum: 0, description: "Maximum recursive directory depth." })),
  maxFileSizeBytes: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum indexed file size in bytes." })),
  follow: Type.Optional(Type.Boolean({ description: "Follow symbolic links." })),
  embeddingConcurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Embedding requests processed concurrently during updates." })),
  fuse: Type.Optional(Type.Boolean({ description: "Collapse all query groups into one ranked plan." })),
  preferSymbol: Type.Optional(Type.Boolean({ description: "Prefer exact indexed symbols." })),
  symbolTypes: Type.Optional(Type.Array(Type.Union([
    Type.Literal("module"), Type.Literal("class"), Type.Literal("interface"),
    Type.Literal("function"), Type.Literal("value"), Type.Literal("alias"),
  ]))),
  modifiedAfter: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.String()])),
  modifiedBefore: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.String()])),
  freshness: Type.Optional(Type.Union([Type.Literal("eventual"), Type.Literal("wait_for_fresh")])),
  autoUpdate: Type.Optional(Type.Boolean({ description: "Allow eventual search to schedule a background update." })),
});

let client: ZvecMcpClient | undefined;
let clientPromise: Promise<ZvecMcpClient> | undefined;
let registered = false;
const grantedWorkspaces = new Set<string>();
const rgTypeMaps = new Map<string, Promise<Map<string, string[]>>>();

function output(result: ExecResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n\n");
}

function envToken(): Promise<string | undefined> {
  const token = process.env.ZVEC_GREP_SERVER_TOKEN;
  if (token) return Promise.resolve(token);
  const file = process.env.ZVEC_GREP_SERVER_TOKEN_FILE;
  return file
    ? readFile(file, "utf8").then((value) => value.trim()).catch(() => undefined)
    : Promise.resolve(undefined);
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(MCP_TIMEOUT);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function parseRpc(text: string): JsonRpcResponse {
  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    // Streamable HTTP may return an SSE event stream. Join multiline data
    // fields and select the JSON-RPC response carrying result or error.
    const events: string[] = [];
    let current: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) current.push(line.slice(5).trimStart());
      else if (!line.trim() && current.length) {
        events.push(current.join("\n"));
        current = [];
      }
    }
    if (current.length) events.push(current.join("\n"));
    for (const event of events.reverse()) {
      try {
        const parsed = JSON.parse(event) as JsonRpcResponse;
        if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
      } catch {
        // Ignore non-JSON SSE events.
      }
    }
    throw new Error(`Invalid MCP response: ${text.slice(0, 500)}`);
  }
}

class ZvecMcpClient {
  private sessionId = "";
  private nextId = 1;
  private initialized = false;

  private async headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    const token = await envToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  private async post(payload: JsonObject, signal: AbortSignal | undefined): Promise<JsonRpcResponse> {
    const response = await fetch(MCP_ENDPOINT, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify(payload),
      signal: requestSignal(signal),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${body.slice(0, 500)}`);
    return parseRpc(body);
  }

  async initializeWithHeaders(signal: AbortSignal | undefined): Promise<void> {
    const headers = await this.headers();
    const response = await fetch(MCP_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "pi-zvec-grep", version: "1.0.0" },
        },
      }),
      signal: requestSignal(signal),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`MCP initialize HTTP ${response.status}: ${body.slice(0, 500)}`);
    this.sessionId = response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id") ?? "";
    const parsed = parseRpc(body);
    if (parsed.error) throw new Error(parsed.error.message ?? "MCP initialize failed");
    this.initialized = true;
    // MCP initialization requires this notification before tools/list/call.
    await fetch(MCP_ENDPOINT, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: requestSignal(signal),
    });
  }

  async request(method: string, params: JsonObject, signal: AbortSignal | undefined): Promise<unknown> {
    if (!this.initialized) await this.initializeWithHeaders(signal);
    const response = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params }, signal);
    if (response.error) throw new Error(response.error.message ?? `MCP ${method} failed`);
    return response.result;
  }

  async listTools(signal: AbortSignal | undefined): Promise<McpTool[]> {
    const result = await this.request("tools/list", {}, signal) as { tools?: McpTool[] };
    return result.tools ?? [];
  }

  async callTool(name: string, arguments_: JsonObject, signal: AbortSignal | undefined): Promise<JsonObject> {
    return await this.request("tools/call", { name, arguments: arguments_ }, signal) as JsonObject;
  }
}

async function ensureServer(pi: ExtensionAPI, signal: AbortSignal | undefined): Promise<void> {
  const status = await pi.exec(ZG, ["server", "status", "--check-ready"], {
    cwd: process.cwd(), signal, timeout: COMMAND_TIMEOUT,
  });
  if (status.code === 0) return;
  const started = await pi.exec(ZG, ["server", "on", "--mcp-toolset", "agent"], {
    cwd: process.cwd(), signal, timeout: COMMAND_TIMEOUT,
  });
  if (started.code !== 0) throw new Error(`Unable to start zvec-grep server:\n${output(started)}`);
}

async function getClient(pi: ExtensionAPI, signal: AbortSignal | undefined): Promise<ZvecMcpClient> {
  if (client) return client;
  if (!clientPromise) {
    clientPromise = (async () => {
      await ensureServer(pi, signal);
      const next = new ZvecMcpClient();
      await next.initializeWithHeaders(signal);
      client = next;
      return next;
    })().finally(() => {
      clientPromise = undefined;
    });
  }
  return clientPromise;
}

async function grantWorkspace(pi: ExtensionAPI, root: string, signal: AbortSignal | undefined): Promise<void> {
  if (grantedWorkspaces.has(root)) return;
  const result = await pi.exec(ZG, ["auth", "grant", root, "--capability", "embedding", "--scope", "workspace"], {
    cwd: root, signal, timeout: COMMAND_TIMEOUT,
  });
  // A configured local embedding model does not need a remote grant. The
  // configured setup here is remote, so successful grants are cached.
  if (result.code === 0 || /local model|not remote/i.test(output(result))) {
    grantedWorkspaces.add(root);
    return;
  }
  throw new Error(`Unable to authorize remote embedding for ${root}:\n${output(result)}`);
}

function absoluteRoot(cwd: string, value: unknown): string {
  return resolve(cwd, typeof value === "string" && value ? value : ".");
}

function listValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" && value ? [value] : [];
}

async function rgTypes(
  pi: ExtensionAPI,
  root: string,
  signal: AbortSignal | undefined,
): Promise<Map<string, string[]>> {
  const cached = rgTypeMaps.get(root);
  if (cached) return cached;
  const promise = pi.exec("rg", ["--type-list"], { cwd: root, signal, timeout: COMMAND_TIMEOUT })
    .then((result) => {
      const map = new Map<string, string[]>();
      if (result.code !== 0) return map;
      for (const line of result.stdout.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        const name = line.slice(0, colon).trim();
        const patterns = line.slice(colon + 1).split(",").map((item) => item.trim()).filter(Boolean);
        if (name && patterns.length) map.set(name, patterns);
      }
      return map;
    })
    .catch(() => new Map<string, string[]>());
  rgTypeMaps.set(root, promise);
  return promise;
}

function extensionGlob(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith(".")) return `**/*${trimmed}`;
  if (trimmed.includes("*") || trimmed.includes("/") || trimmed.includes("\\")) return trimmed;
  return `**/*.${trimmed}`;
}

function addGlobs(args: JsonObject, generated: string[]): void {
  if (!generated.length) return;
  const current = listValue(args.globs);
  args.globs = [...current, ...generated];
}

function translateFileTypes(args: JsonObject, field: "fileTypes" | "excludedFileTypes", types: Map<string, string[]>): void {
  const values = listValue(args[field]);
  if (!values.length) return;
  const unknown = values.some((value) => !types.has(value));
  if (!unknown) return;

  // If one value is an extension-like alias (for example ArkTS `ets`),
  // convert the whole OR-list to globs. Keeping valid fileTypes alongside a
  // glob would make the server apply an unintended intersection.
  const generated = values.flatMap((value) => (types.get(value) ?? [extensionGlob(value)]));
  addGlobs(args, field === "excludedFileTypes" ? generated.map((glob) => `!${glob}`) : generated);
  delete args[field];
}

async function normalizeArguments(
  pi: ExtensionAPI,
  cwd: string,
  input: unknown,
  signal: AbortSignal | undefined,
): Promise<JsonObject> {
  const args = input && typeof input === "object" ? { ...(input as JsonObject) } : {};
  args.root = absoluteRoot(cwd, args.root);

  // Some pi/model combinations serialize an array-valued tool argument as a
  // JSON string (for example, '["ts"]'). Repair that before calling MCP.
  const listFields = [
    "queries", "fts", "vector", "globs", "insensitiveGlobs", "fileTypes",
    "excludedFileTypes", "ignoreFiles", "symbolTypes",
  ];
  for (const field of listFields) {
    const value = args[field];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) args[field] = parsed;
      } catch {
        // Leave malformed JSON untouched for normal MCP validation.
      }
    } else if (field === "symbolTypes" && trimmed) {
      args[field] = [value];
    }
  }

  const types = await rgTypes(pi, String(args.root), signal);
  translateFileTypes(args, "fileTypes", types);
  translateFileTypes(args, "excludedFileTypes", types);
  return args;
}

function mcpText(result: JsonObject): string {
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((item): item is JsonObject => !!item && typeof item === "object" && item.type === "text")
      .map((item) => String(item.text ?? ""))
      .join("\n\n");
    if (text) return text;
  }
  return JSON.stringify(result, null, 2);
}

function hasMcpError(result: JsonObject): boolean {
  return result.isError === true;
}

async function authorizeAndCall(
  pi: ExtensionAPI,
  params: unknown,
  signal: AbortSignal | undefined,
  ctxCwd: string,
  onUpdate: ToolUpdate | undefined,
): Promise<JsonObject> {
  const args = await normalizeArguments(pi, ctxCwd, params, signal);
  const root = String(args.root);
  await grantWorkspace(pi, root, signal);
  onUpdate?.({ content: [{ type: "text", text: "zvec-grep MCP: searching…" }], details: {} });

  const mcp = await getClient(pi, signal);
  try {
    return await mcp.callTool("zvec_grep_search", args, signal);
  } catch (error) {
    // One reconnect handles a daemon restart or an expired MCP session.
    client = undefined;
    const recovered = await getClient(pi, signal);
    return await recovered.callTool("zvec_grep_search", args, signal).catch(() => {
      throw error;
    });
  }
}

function adaptMcpSchema(schema: JsonObject): JsonObject {
  // The daemon requires an absolute root because it serves multiple clients.
  // pi already supplies ctx.cwd, so keep root available but optional for the
  // LLM and fill it in before tools/call.
  const copy = JSON.parse(JSON.stringify(schema)) as JsonObject;
  if (copy.properties && typeof copy.properties === "object") {
    // The default zvec-grep MCP transport currently accepts trace but drops
    // it from its text response; do not advertise a misleading LLM argument.
    delete (copy.properties as JsonObject).trace;
  }
  if (Array.isArray(copy.required)) {
    copy.required = copy.required.filter((field) => field !== "root" && field !== "trace");
  }
  return copy;
}

function registerSearch(pi: ExtensionAPI, tool: McpTool | undefined): void {
  if (registered) return;
  registered = true;
  const parameters = tool?.inputSchema
    ? Type.Unsafe(adaptMcpSchema(tool.inputSchema) as never)
    : FallbackSearchParameters;

  pi.registerTool({
    name: "zvec_grep_search",
    label: "zvec-grep Search",
    description: tool?.description ?? "Search the current workspace using zvec-grep's official MCP search tool.",
    promptSnippet: "Search the workspace semantically with zvec-grep",
    promptGuidelines: [
      "Use zvec_grep_search when the answer should be grounded in local workspace material and the location or wording is unknown.",
      "Use the built-in grep tool for an exact word, quotation, filename, key, or regex; use zvec_grep_search for semantic or cross-file discovery.",
      "zvec_grep_search handles workspace authorization internally. Do not run zg setup commands in a separate turn.",
      "If the result says the workspace has no index, ask the user to run the external indexing workflow; do not silently rebuild a persistent index.",
    ],
    parameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await authorizeAndCall(pi, params, signal, ctx.cwd, onUpdate);
      if (hasMcpError(result)) throw new Error(mcpText(result));
      return {
        content: [{ type: "text", text: mcpText(result) }],
        details: { source: "zvec-grep MCP", workspace: absoluteRoot(ctx.cwd, (params as JsonObject).root) },
      };
    },
  });
}

export default function zvecGrepMcpExtension(pi: ExtensionAPI) {
  // Discover the author's live MCP schema before the first agent turn. If the
  // daemon is temporarily unavailable, the compact documented schema keeps
  // the tool available and the call path retries the daemon later.
  pi.on("session_start", async (_event, ctx) => {
    try {
      const mcp = await getClient(pi, ctx.signal);
      const tools = await mcp.listTools(ctx.signal);
      registerSearch(pi, tools.find((candidate) => candidate.name === "zvec_grep_search"));
    } catch (error) {
      registerSearch(pi, undefined);
      if (ctx.hasUI) ctx.ui.notify(`zvec-grep MCP unavailable at startup; will retry on search (${String(error).slice(0, 160)})`, "warning");
    }
  });

}
