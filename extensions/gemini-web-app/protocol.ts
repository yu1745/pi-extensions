/**
 * Gemini App (gemini.google.com) web protocol — TypeScript port of the
 * reverse-engineered StreamGenerate wire format used by gemini-web2api-go
 * (MIT, github.com/zexadev/gemini-web2api-go), trimmed to what a chat/model
 * provider needs: model selection, payload build, response parsing.
 *
 * Model availability on this endpoint is gated by the *Gemini app* model
 * selector (server-side), which is what lets Google AI Pro accounts reach
 * Gemini 4 Argon here even though the Antigravity cloudcode-pa endpoint
 * tier-gates it to Ultra.
 */
import { createHash } from "node:crypto";

/** Server-recognized model hex ids (from batchexecute?rpcids=otAQ7b). */
export const HEX = {
	flash36: "fbb127bbb056c959",
	flashLite: "cf41b0e0dd7d53e5",
	pro31: "9d8ca3786ebdfbea",
	flash38: "56fdd199312815e2",
	argon4: "95a4c0abcba24364",
} as const;

/** think wire values (header index 15 / inner[80]): 1 normal, 2 extended ("High"), 4 medium. */
export const THINK_WIRE = { normal: 1, extended: 2, medium: 4 } as const;

export const INNER_SLOTS = 97;

export interface WebModelConfig {
	hex: string;
	mode: number;
	think: number;
	/** Server-reported display name used to detect silent downgrade. */
	upstream: string;
}

export const WEB_MODELS: Record<string, WebModelConfig> = {
	"gemini-3.6-flash": { hex: HEX.flash36, mode: 1, think: THINK_WIRE.normal, upstream: "3.6 Flash" },
	"gemini-3.5-flash-lite": { hex: HEX.flashLite, mode: 6, think: THINK_WIRE.normal, upstream: "3.5 Flash-Lite" },
	"gemini-3.1-pro": { hex: HEX.pro31, mode: 3, think: THINK_WIRE.normal, upstream: "3.1 Pro" },
	"gemini-3.8-flash": { hex: HEX.flash38, mode: 1, think: THINK_WIRE.normal, upstream: "3.8 Flash" },
	"gemini-4-argon": { hex: HEX.argon4, mode: 8, think: THINK_WIRE.normal, upstream: "4 Argon" },
	"gemini-4-argon-thinking": {
		hex: HEX.argon4,
		mode: 8,
		think: THINK_WIRE.extended,
		upstream: "4 Argon",
	},
	"gemini-4-argon-thinking-medium": {
		hex: HEX.argon4,
		mode: 8,
		think: THINK_WIRE.medium,
		upstream: "4 Argon",
	},
	"gemini-3.8-flash-thinking": {
		hex: HEX.flash38,
		mode: 1,
		think: THINK_WIRE.extended,
		upstream: "3.8 Flash",
	},
	"gemini-3.1-pro-thinking": {
		hex: HEX.pro31,
		mode: 3,
		think: THINK_WIRE.extended,
		upstream: "3.1 Pro",
	},
};

/** Models the web endpoint silently downgrades without a signed-in cookie. */
export function modelNeedsLogin(cfg: WebModelConfig): boolean {
	return (
		cfg.hex === HEX.pro31 ||
		cfg.hex === HEX.flash38 ||
		cfg.hex === HEX.argon4 ||
		cfg.think !== THINK_WIRE.normal
	);
}

export function geminiBase(authuser: number): string {
	return authuser > 0 ? `https://gemini.google.com/u/${authuser}` : "https://gemini.google.com";
}

/**
 * x-goog-ext-525001261-jspb model header. The server reads the model from THIS
 * header (index 14 = mode, 15 = think wire) — inner[79]/inner[80] are mirrors.
 */
export function buildModelHeader(cfg: WebModelConfig, requestUuid: string): string {
	return `[1,null,null,null,"${cfg.hex}",null,null,0,[4,5,6,8],null,null,1,null,null,${cfg.mode},${cfg.think},"${requestUuid}"]`;
}

export function randomUuid(): string {
	return crypto.randomUUID();
}

/**
 * Build the f.req inner payload (97-slot array, verbatim from browser capture
 * via the reference implementation). prompt is the fully rendered prompt string.
 */
export function buildInner(prompt: string, cfg: WebModelConfig): unknown[] {
	const inner: unknown[] = new Array(INNER_SLOTS).fill(undefined);
	inner[0] = [prompt, 0, null, null, null, null, 0];
	inner[1] = ["en"];
	inner[2] = ["", "", "", null, null, null, null, null, null, ""];
	inner[6] = [0];
	inner[7] = 1;
	inner[10] = 1;
	inner[11] = 0;
	// Session turn index; we always open a fresh conversation, so 0.
	inner[17] = [[0]];
	inner[18] = 0;
	inner[27] = 1;
	inner[30] = [4];
	inner[41] = [1];
	inner[53] = 0;
	inner[59] = randomUuid();
	inner[61] = [];
	inner[68] = 1;
	inner[79] = cfg.mode;
	inner[80] = cfg.think;
	inner[91] = 0;
	inner[96] = cfg.think !== THINK_WIRE.normal ? 1 : 0;
	return inner;
}

export function buildFreq(prompt: string, cfg: WebModelConfig): string {
	return JSON.stringify([null, JSON.stringify(buildInner(prompt, cfg))]);
}

export function buildRequestBody(freq: string, xsrf: string): string {
	const params = new URLSearchParams({ "f.req": freq });
	if (xsrf) params.set("at", xsrf);
	return params.toString();
}

/** StreamGenerate endpoint for the given authuser / bl version. */
export function buildEndpoint(authuser: number, bl: string): string {
	const reqid = Date.now() % 1_000_000;
	return `${geminiBase(authuser)}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${encodeURIComponent(bl)}&hl=en&_reqid=${reqid}&rt=c`;
}

export interface RequestHeadersInput {
	cookie: string;
	sapisid: string;
	xsrf: string;
	cfg: WebModelConfig;
	authuser: number;
	requestUuid: string;
}

export function buildHeaders(input: RequestHeadersInput): Record<string, string> {
	const h: Record<string, string> = {
		Accept: "*/*",
		"Accept-Language": "en-US,en;q=0.9",
		"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
		Origin: "https://gemini.google.com",
		Referer: `${geminiBase(input.authuser)}/app`,
		"X-Same-Domain": "1",
		"X-Goog-AuthUser": String(input.authuser),
		"x-goog-ext-73010989-jspb": "[0]",
		"x-goog-ext-73010990-jspb": "[0,0,0]",
		"x-goog-ext-525001261-jspb": buildModelHeader(input.cfg, input.requestUuid),
		// Session header shares inner[59]'s uuid (a different one goes in the model header).
		"x-goog-ext-525005358-jspb": `["${input.requestUuid}",1]`,
	};
	if (input.cookie) h.Cookie = input.cookie;
	if (input.sapisid) h.Authorization = makeSapisidHash(input.sapisid);
	return h;
}

/** SAPISIDHASH Authorization header for gemini.google.com. */
export function makeSapisidHash(sapisid: string): string {
	const ts = Math.floor(Date.now() / 1000);
	// Node/web crypto: SHA-1 via subtle.
	const data = `${ts} ${sapisid} https://gemini.google.com`;
	const hash = createHash("sha1").update(data).digest("hex");
	return `SAPISIDHASH ${ts}_${hash}`;
}

/** Chrome-matching application-layer headers (TLS fingerprint is Node's own — see README). */
export function chromeFetchHeaders(): Record<string, string> {
	return {
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
		"Sec-CH-UA": '"Chromium";v="146", "Google Chrome";v="146", "Not?A_Brand";v="24"',
		"Sec-CH-UA-Mobile": "?0",
		"Sec-CH-UA-Platform": '"Windows"',
		"Sec-Fetch-Dest": "empty",
		"Sec-Fetch-Mode": "cors",
		"Sec-Fetch-Site": "same-origin",
	};
}
