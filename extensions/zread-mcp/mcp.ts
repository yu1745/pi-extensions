/**
 * Minimal Streamable-HTTP MCP client.
 *
 * Implements the subset of MCP (Model Context Protocol) needed to talk to a
 * remote streamable-HTTP server: initialize handshake, notifications/initialized,
 * tools/list, and tools/call. Responses are Server-Sent-Events; we parse the
 * `data:` frames and match by JSON-RPC id.
 *
 * No npm deps — plain fetch + SSE text parsing.
 */

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema: any;
}

interface SendOpts {
	expectResponse?: boolean;
	signal?: AbortSignal;
}

export class StreamableHttpClient {
	private sessionId: string | null = null;
	private initialized = false;
	private nextId = 1;
	private initPromise: Promise<void> | null = null;

	constructor(
		private readonly url: string,
		private readonly headers: Record<string, string> = {},
	) {}

	/** Lazily run the initialize handshake exactly once. Concurrent callers share it. */
	async connect(signal?: AbortSignal): Promise<void> {
		if (this.initialized) return;
		if (!this.initPromise) {
			this.initPromise = this.doInit(signal).catch((e) => {
				this.initPromise = null; // allow a later retry
				throw e;
			});
		}
		return this.initPromise;
	}

	/** Drop session state so the next call re-initializes. */
	reset(): void {
		this.initialized = false;
		this.sessionId = null;
		this.initPromise = null;
	}

	private async doInit(signal?: AbortSignal): Promise<void> {
		const res = await this.send(
			{
				jsonrpc: "2.0",
				id: this.nextId++,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "pi-zread", version: "1.0.0" },
				},
			},
			{ expectResponse: true, signal },
		);
		if (!res?.result) {
			throw new Error(
				`MCP initialize failed: ${JSON.stringify(res?.error ?? res)}`,
			);
		}
		// Required notification — server returns empty 200.
		await this.send(
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ expectResponse: false, signal },
		);
		this.initialized = true;
	}

	async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
		await this.connect(signal);
		let res = await this.send(
			{ jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} },
			{ signal },
		);
		if (!res?.result?.tools) {
			// Possibly an expired session — retry once.
			this.reset();
			await this.connect(signal);
			res = await this.send(
				{ jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} },
				{ signal },
			);
		}
		return (res?.result?.tools ?? []) as McpToolInfo[];
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<any> {
		await this.connect(signal);
		let res = await this.send(
			{
				jsonrpc: "2.0",
				id: this.nextId++,
				method: "tools/call",
				params: { name, arguments: args },
			},
			{ signal },
		);
		if (res?.error && this.isSessionError(res.error)) {
			this.reset();
			await this.connect(signal);
			res = await this.send(
				{
					jsonrpc: "2.0",
					id: this.nextId++,
					method: "tools/call",
					params: { name, arguments: args },
				},
				{ signal },
			);
		}
		if (res?.error) {
			throw new Error(
				`MCP tools/call "${name}" error: ${JSON.stringify(res.error)}`,
			);
		}
		return res?.result ?? null;
	}

	private isSessionError(err: any): boolean {
		const msg = JSON.stringify(err).toLowerCase();
		return (
			msg.includes("session") ||
			msg.includes("not initialized") ||
			msg.includes("unauthorized") ||
			err?.code === -32000
		);
	}

	private async send(msg: any, opts: SendOpts = {}): Promise<any> {
		const { expectResponse = true, signal } = opts;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.headers,
		};
		if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

		const res = await fetch(this.url, {
			method: "POST",
			headers,
			body: JSON.stringify(msg),
			signal,
		});
		const sid = res.headers.get("mcp-session-id");
		if (sid) this.sessionId = sid;
		const text = await res.text();
		if (!expectResponse || text === "") return undefined;
		if (!res.ok) {
			throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 500)}`);
		}
		const ct = res.headers.get("content-type") || "";
		if (ct.includes("event-stream")) {
			const events = parseSse(text);
			if (events.length === 0) return undefined;
			return events.find((e) => e.id === msg.id) ?? events[events.length - 1];
		}
		try {
			return JSON.parse(text);
		} catch {
			return undefined;
		}
	}
}

/** Parse an SSE body into a list of decoded JSON events. */
function parseSse(text: string): any[] {
	const out: any[] = [];
	for (const block of text.split(/\r?\n\r?\n/)) {
		const data: string[] = [];
		for (const line of block.split(/\r?\n/)) {
			if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		}
		if (data.length) {
			try {
				out.push(JSON.parse(data.join("\n")));
			} catch {
				/* skip non-JSON keep-alive frames */
			}
		}
	}
	return out;
}

// ─── JSON Schema → typebox (used by the /zread discovery command) ─────────────

import { Type, type TSchema } from "typebox";

export function jsonSchemaToTypebox(schema: any): TSchema {
	if (!schema || typeof schema !== "object") return Type.Any();
	const desc = schema.description ? { description: schema.description } : {};
	switch (schema.type) {
		case "string":
			return Type.String(desc);
		case "integer":
		case "number":
			return Type.Number(desc);
		case "boolean":
			return Type.Boolean(desc);
		case "array":
			return Type.Array(jsonSchemaToTypebox(schema.items), desc);
		case "object":
			return jsonObjectToTypebox(schema);
		default:
			return Type.Any();
	}
}

function jsonObjectToTypebox(schema: any): TSchema {
	const props = schema.properties ?? {};
	const required = new Set<string>(schema.required ?? []);
	const out: Record<string, TSchema> = {};
	for (const [k, sub] of Object.entries(props)) {
		const t = jsonSchemaToTypebox(sub);
		out[k] = required.has(k) ? t : Type.Optional(t);
	}
	return Type.Object(out, { additionalProperties: false });
}
