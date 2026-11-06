/**
 * gemini-web-app — provider extension for pi.
 *
 * Talks to gemini.google.com's own web protocol (the "Gemini App" endpoint),
 * where Gemini 4 Argon is gated by the app's model selector instead of the
 * Antigravity cloudcode-pa tier table. A Google AI Pro account cookie that can
 * see "4 Argon" in gemini.google.com therefore reaches Argon through this
 * provider — no Ultra, no API key.
 *
 * Protocol ported from gemini-web2api-go (MIT) by zexadev.
 *
 * Setup:
 *   /gemini-web-cookie <cookie header pasted from gemini.google.com>
 *     (Firefox export recommended; Chrome DBSC sessions expire fast)
 *   /gemini-web-check   — verify the cookie still has a signed-in session
 *
 * Environment override: GEMINI_WEB_COOKIE (+ optional GEMINI_WEB_AUTHUSER).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { streamGeminiWeb, GEMINI_WEB_API, PROVIDER_ID } from "./stream.js";
import { WEB_MODELS, modelNeedsLogin } from "./protocol.js";
import {
	checkCookieAlive,
	loadCookieConfig,
	parseCookieBlob,
	saveCookieConfig,
	cookieStorePath,
	refreshBl,
} from "./cookie.js";
import { startKeepAlive, rotateCookie } from "./rotate.js";



const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const GEMINI_WEB_MODELS: ProviderModelConfig[] = [
	{
		type: "chat",
		id: "gemini-4-argon",
		name: "Gemini 4 Argon (Gemini App)",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 128_000,
		maxTokens: 32_000,
	},
	{
		type: "chat",
		id: "gemini-4-argon-thinking",
		name: "Gemini 4 Argon Thinking High (Gemini App)",
		reasoning: true,
		input: ["text"],
		cost,
		contextWindow: 128_000,
		maxTokens: 32_000,
	},
	{
		type: "chat",
		id: "gemini-4-argon-thinking-medium",
		name: "Gemini 4 Argon Thinking Medium (Gemini App)",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 128_000,
		maxTokens: 32_000,
	},
	{
		type: "chat",
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash (Gemini App)",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 128_000,
		maxTokens: 32_000,
	},
	{
		type: "chat",
		id: "gemini-3.8-flash-thinking",
		name: "Gemini 3.8 Flash Thinking (Gemini App)",
		reasoning: true,
		input: ["text"],
		cost,
		contextWindow: 128_000,
		maxTokens: 32_000,
	},
	{
		type: "chat",
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro (Gemini App)",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 128_000,
		maxTokens: 32_000,
	},
	{
		type: "chat",
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash (Gemini App)",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 128_000,
		maxTokens: 32_000,
	},
];

function emit(ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, type);
		return;
	}
	if (type === "info") console.log(text);
	else console.error(text);
}

export default function (pi: ExtensionAPI): void {
	// Ensure the cookie store exists so the `!command` apiKey interpolation always
	// resolves (empty object = anonymous; web-protocol models needing login will
	// fail loudly at request time instead).
	const cookiePath = join(homedir(), ".pi", "agent", "gemini-web-cookie.json");
	void (async () => {
		try {
			await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
			await writeFile(cookiePath, JSON.stringify({ cookie: "", sapisid: "", authuser: 0 }), {
				mode: 0o600,
				flag: "wx",
			});
		} catch {
			// exists
		}
	})();

	pi.registerProvider(PROVIDER_ID, {
		name: "Gemini App (web)",
		baseUrl: "https://gemini.google.com",
		// The credential is the Google session cookie, not an API key. The !command
		// interpolation makes pi treat the stored cookie blob as this provider's key,
		// which both satisfies pi's credential resolution and exposes the models.
		apiKey: `!cat ${join(homedir(), ".pi", "agent", "gemini-web-cookie.json")}`,
		api: GEMINI_WEB_API,
		models: GEMINI_WEB_MODELS,
		streamSimple: streamGeminiWeb,
	});

	// Tool calls are prompt-level on this transport; register the custom API so
	// pi routes stream() through streamSimple as well.
	registerApiProvider({
		api: GEMINI_WEB_API,
		stream: streamGeminiWeb,
		streamSimple: streamGeminiWeb,
	});

	void refreshBl();
	startKeepAlive();

	pi.registerCommand("gemini-web-cookie", {
		description: "Store the gemini.google.com cookie (paste the Cookie request header)",
		handler: async (argument, ctx) => {
			const parsed = parseCookieBlob(argument ?? "");
			if (!parsed) {
				emit(
					ctx,
					"Paste the raw Cookie request header from gemini.google.com (DevTools → Network → any request → Cookie), or {\"cookie\": \"…\"}.",
					"warning",
				);
				return;
			}
			await saveCookieConfig(parsed);
			const check = await checkCookieAlive(parsed);
			// First keep-alive pass right away: the pasted __Secure-1PSIDTS may be
			// minutes from expiry, and rotation also merges fresh SIDCC values.
			let rotateNote = "";
			if (check.ok) {
				try {
					const r = await rotateCookie(parsed);
					rotateNote = r.names.length > 0 ? `; rotated ${r.names.join(", ")}` : "; nothing to rotate";
				} catch (error) {
					rotateNote = `; rotation failed: ${error instanceof Error ? error.message : error}`;
				}
			}
			emit(
				ctx,
				`Cookie saved to ${cookieStorePath()}. Session check: ${check.detail}${rotateNote}. Auto-renewal is running.`,
				check.ok ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("gemini-web-check", {
		description: "Verify the stored Gemini App cookie and model access",
		handler: async (_argument, ctx) => {
			const config = await loadCookieConfig();
			if (!config) {
				emit(ctx, "No cookie stored. Run /gemini-web-cookie first.", "warning");
				return;
			}
			const check = await checkCookieAlive(config);
			const needsLogin = Object.values(WEB_MODELS).filter(modelNeedsLogin).length;
			emit(
				ctx,
				check.ok
					? `Cookie OK (${check.detail}). ${needsLogin} login-gated models available incl. gemini-4-argon.`
					: `Cookie NOT valid: ${check.detail}. Re-export from Firefox and re-run /gemini-web-cookie.`,
				check.ok ? "info" : "warning",
			);
		},
	});
}
