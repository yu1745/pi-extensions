/**
 * ZRead MCP — pi extension
 *
 * Bridges the ZRead remote MCP server (智谱 GLM Coding Plan 专属) into native
 * pi tools, so the LLM can explore PUBLIC GitHub repositories:
 *
 *   zread_search_doc        — search docs / issues / PRs / commits / news
 *   zread_get_repo_structure — list a repo's directory tree
 *   zread_read_file          — read a single file's full contents from a repo
 *
 * No hard-coded key. The API key is resolved at call time from the fixed
 * "zai-coding-cn" provider via pi's official provider-auth API
 * (ctx.modelRegistry.getProviderAuth). Make sure you have logged in /
 * configured an API key for zai-coding-cn (e.g. /login zai-coding-cn).
 *
 * The MCP endpoint is overridable via ZREAD_MCP_URL.
 *
 * Place at: ~/.pi/agent/extensions/zread-mcp/
 * Reload in pi: /reload
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StreamableHttpClient } from "./mcp";

// ─── Config ────────────────────────────────────────────────────────────────────

// Fixed provider — ZRead only accepts the zai-coding-cn Coding Plan key.
const PROVIDER = "zai-coding-cn";
const ENDPOINT =
	process.env.ZREAD_MCP_URL ??
	"https://open.bigmodel.cn/api/mcp/zread/mcp";

// Minimal structural type for the bit of ctx we need, so we don't pull in
// the full AuthResult type from pi-ai.
interface ProviderAuthCtx {
	modelRegistry: {
		getProviderAuth(provider: string): Promise<
			| { auth?: { apiKey?: string; baseUrl?: string }; source?: string }
			| undefined
		>;
	};
}

/** Resolve the Coding Plan API key from the zai-coding-cn provider. */
async function resolveApiKey(ctx: ProviderAuthCtx): Promise<string> {
	const result = await ctx.modelRegistry.getProviderAuth(PROVIDER);
	const key = result?.auth?.apiKey;
	if (!key) {
		throw new Error(
			`No API key for provider "${PROVIDER}". Run /login ${PROVIDER} (or configure its API key) and retry.`,
		);
	}
	return key;
}

// Client cache keyed by resolved API key: a stable key reuses the MCP session
// across calls; if the user re-logins with a different key, a new client is
// created transparently.
let cached: { key: string; client: StreamableHttpClient } | null = null;

function getClient(apiKey: string): StreamableHttpClient {
	if (cached && cached.key === apiKey) return cached.client;
	const client = new StreamableHttpClient(ENDPOINT, {
		Authorization: `Bearer ${apiKey}`,
	});
	cached = { key: apiKey, client };
	return client;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Drop undefined values so MCP `arguments` only contains set fields. */
function clean(obj: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) out[k] = v;
	}
	return out;
}

/** Convert an MCP tools/call result into a pi tool result. */
function toToolResult(mcpResult: any) {
	const raw = mcpResult?.content;
	let content: Array<{ type: "text"; text: string }>;
	if (Array.isArray(raw)) {
		content = raw.map((part: any) => {
			if (part?.type === "text") return { type: "text", text: part.text ?? "" };
			return { type: "text", text: JSON.stringify(part) };
		});
	} else {
		content = [{ type: "text", text: JSON.stringify(mcpResult ?? "") }];
	}
	return {
		content,
		isError: mcpResult?.isError === true,
		details: {},
	};
}

/** Resolve key + run a proxied MCP tool call, surfacing errors to the LLM. */
async function proxyCall(
	ctx: ProviderAuthCtx,
	name: string,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
) {
	try {
		const key = await resolveApiKey(ctx);
		const result = await getClient(key).callTool(name, clean(args), signal);
		return toToolResult(result);
	} catch (e: any) {
		return {
			content: [
				{
					type: "text" as const,
					text: `ZRead "${name}" failed: ${e?.message ?? String(e)}`,
				},
			],
			isError: true,
			details: {},
		};
	}
}

function maskKey(k: string): string {
	return k.length > 10 ? `${k.slice(0, 6)}…${k.slice(-4)}` : "***";
}

// ─── Extension entry ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const repoDesc =
		'GitHub repository as "owner/repo" (e.g. "vitejs/vite"). Must be public.';

	// 1) Search docs / issues / PRs / commits
	pi.registerTool({
		name: "zread_search_doc",
		label: "ZRead Search",
		description:
			"Search documentation, recent issues, PRs, commits, contributors and news of a PUBLIC GitHub repository (via ZRead / zread.ai). Use to quickly learn an open-source repo or investigate its history without cloning.",
		promptSnippet: "Search docs/issues/PRs/commits of a public GitHub repo (owner/repo)",
		parameters: Type.Object({
			repo_name: Type.String({ description: repoDesc }),
			query: Type.String({
				description: "Search keywords or a question about the repository.",
			}),
			language: Type.Optional(
				Type.String({
					description: "'zh' or 'en' — choose by the conversation's language.",
				}),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return proxyCall(ctx, "search_doc", params as Record<string, unknown>, signal);
		},
	});

	// 2) Repo structure / directory tree
	pi.registerTool({
		name: "zread_get_repo_structure",
		label: "ZRead Repo Structure",
		description:
			"Get the directory structure and file list of a PUBLIC GitHub repository (via ZRead). Use to understand a repo's layout before reading specific files.",
		promptSnippet: "List the directory tree of a public GitHub repo (owner/repo)",
		parameters: Type.Object({
			repo_name: Type.String({ description: repoDesc }),
			dir_path: Type.Optional(
				Type.String({
					description: 'Directory to inspect (default: root "/").',
				}),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return proxyCall(
				ctx,
				"get_repo_structure",
				params as Record<string, unknown>,
				signal,
			);
		},
	});

	// 3) Read a single file from the repo
	pi.registerTool({
		name: "zread_read_file",
		label: "ZRead File",
		description:
			"Read the full contents of a single file from a PUBLIC GitHub repository (via ZRead). For REMOTE GitHub files only — NOT local files (use the built-in read tool for local files).",
		promptSnippet: "Read a file from a public GitHub repo (owner/repo + path)",
		parameters: Type.Object({
			repo_name: Type.String({ description: repoDesc }),
			file_path: Type.String({
				description: 'Relative path to the file (e.g. "src/index.ts").',
			}),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return proxyCall(ctx, "read_file", params as Record<string, unknown>, signal);
		},
	});

	// Status / discovery command: resolves the key and lists server-side tools.
	pi.registerCommand("zread", {
		description: "ZRead MCP: verify connection and list available tools",
		handler: async (_args, ctx) => {
			try {
				const key = await resolveApiKey(ctx);
				const tools = await getClient(key).listTools(ctx.signal);
				const lines = [
					`ZRead MCP  ${ENDPOINT}`,
					`provider: ${PROVIDER}  (key: ${maskKey(key)})`,
					`tools (${tools.length}):`,
					...tools.map(
						(t) => `  • ${t.name} — ${(t.description ?? "").slice(0, 72)}`,
					),
				];
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (e: any) {
				ctx.ui.notify(`ZRead MCP error: ${e?.message ?? e}`, "error");
			}
		},
	});

	// Reset the MCP session when the pi session ends, so a new session re-inits.
	pi.on("session_shutdown", async () => {
		cached?.client.reset();
	});
}
