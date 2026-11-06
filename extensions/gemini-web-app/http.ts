/**
 * Dedicated fetch for the Gemini web protocol.
 *
 * pi installs an EnvHttpProxyAgent as the global undici dispatcher at startup
 * (and re-installs it on settings changes), which does not raise undici's
 * 16 KiB response-header cap — gemini.google.com's consent + Set-Cookie chains
 * overflow it (UND_ERR_HEADERS_OVERFLOW). So this provider never uses the
 * global fetch: it resolves an undici copy and issues requests through a
 * dedicated Agent with maxHeaderSize raised. A dedicated agent also means
 * Google never sees proxy env vars the user set for other providers.
 */
type UndiciFetch = (url: string, init?: Record<string, unknown>) => Promise<Response>;

interface UndiciModule {
	fetch: UndiciFetch;
	Agent: new (options: Record<string, unknown>) => unknown;
}

let cachedFetch: UndiciFetch | null = null;
let resolving: Promise<UndiciFetch> | null = null;

async function resolveWebFetch(): Promise<UndiciFetch> {
	if (cachedFetch) return cachedFetch;
	if (resolving) return resolving;

	resolving = (async () => {
		const candidates: string[] = ["undici"];
		try {
			let dir = new URL("..", import.meta.url).pathname;
			for (let i = 0; i < 12; i++) {
				candidates.push(`file://${dir}node_modules/undici/index.js`);
				const parent = new URL("..", `file://${dir}`).pathname;
				if (parent === dir) break;
				dir = parent;
			}
		} catch {
			// import.meta.url unavailable — skip path probing
		}
		for (const spec of candidates) {
			try {
				const mod = (await import(spec)) as unknown as UndiciModule;
				if (typeof mod.fetch === "function" && typeof mod.Agent === "function") {
					const agent = new mod.Agent({ maxHeaderSize: 256 * 1024 });
					const fetchImpl: UndiciFetch = (url, init) => mod.fetch(url, { ...init, dispatcher: agent });
					cachedFetch = fetchImpl;
					return fetchImpl;
				}
			} catch {
				// try next candidate
			}
		}
		// Fallback: global fetch. Works only when the host was started with
		// NODE_OPTIONS=--max-http-header-size=65536 (gemini headers overflow
		// the default); surface a hint on failure.
		cachedFetch = (url, init) => fetch(url, init as RequestInit);
		return cachedFetch;
	})();
	return resolving;
}

/** Fetch with the raised-header dispatcher. Signature-compatible with global fetch. */
export function webFetch(url: string, init?: RequestInit): Promise<Response> {
	return resolveWebFetch().then((f) => f(url, (init ?? {}) as Record<string, unknown>));
}
