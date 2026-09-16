import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { HttpsProxyAgent } from "https-proxy-agent";

export const CODEX_AUTH_FILE = path.join(os.homedir(), ".codex", "auth.json");
export const CODEX_USAGE_PATH = "/backend-api/wham/usage";

export interface CodexCredentials {
	accessToken: string;
	accountId: string;
}

export interface CodexWindow {
	usedPercent: number;
	resetAtMs?: number;
	windowSeconds?: number;
}

export interface CodexApiResponse<T = unknown> {
	status: number;
	body: T | null;
	rawBody: string;
}

interface UsageCacheEntry {
	savedAt: number;
	response: CodexApiResponse<any>;
}

const usageCache = new Map<string, UsageCacheEntry>();
const usageRequests = new Map<string, Promise<CodexApiResponse<any>>>();

export function decodeCodexJwtPayload(token: string): any | null {
	try {
		const part = token.split(".")[1];
		if (!part) return null;
		return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
	} catch {
		return null;
	}
}

export function getCodexAccountId(accessToken: string, explicitAccountId?: unknown): string | null {
	if (typeof explicitAccountId === "string" && explicitAccountId.length > 0) return explicitAccountId;
	const payload = decodeCodexJwtPayload(accessToken);
	const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

export function loadCodexCredentials(authFile = CODEX_AUTH_FILE): CodexCredentials | null {
	try {
		if (!fs.existsSync(authFile)) return null;
		const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
		const accessToken = auth?.tokens?.access_token;
		if (typeof accessToken !== "string" || accessToken.length === 0) return null;
		const accountId = getCodexAccountId(accessToken, auth?.tokens?.account_id);
		if (!accountId) return null;
		return { accessToken, accountId };
	} catch {
		return null;
	}
}

export function credentialsFromToken(accessToken: string): CodexCredentials | null {
	const accountId = getCodexAccountId(accessToken);
	return accountId ? { accessToken, accountId } : null;
}

export function codexTimestampMs(value: unknown): number | undefined {
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) return undefined;
	return number >= 1e12 ? number : number * 1000;
}

export function parseCodexWindow(value: any): CodexWindow | null {
	if (!value || typeof value !== "object") return null;
	const used = Number(value.used_percent);
	if (!Number.isFinite(used)) return null;
	const resetAtMs = codexTimestampMs(value.reset_at);
	const windowSeconds = Number(value.limit_window_seconds);
	return {
		usedPercent: Math.min(100, Math.max(0, used)),
		...(resetAtMs !== undefined ? { resetAtMs } : {}),
		...(Number.isFinite(windowSeconds) && windowSeconds > 0 ? { windowSeconds } : {}),
	};
}

export async function requestCodexApi<T = unknown>(
	endpoint: string,
	credentials: CodexCredentials,
	options: { timeoutMs?: number; userAgent?: string } = {},
): Promise<CodexApiResponse<T>> {
	const proxy = process.env.https_proxy || process.env.http_proxy || process.env.ALL_PROXY;
	const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
	const timeoutMs = options.timeoutMs ?? 8_000;

	return new Promise((resolve, reject) => {
		const req = https.request(
			`https://chatgpt.com${endpoint}`,
			{
				headers: {
					Authorization: `Bearer ${credentials.accessToken}`,
					"chatgpt-account-id": credentials.accountId,
					"User-Agent": options.userAgent ?? "CodexDesktop",
					Accept: "application/json",
				},
				agent,
				timeout: timeoutMs,
			},
			(response) => {
				let rawBody = "";
				response.on("data", (chunk) => (rawBody += chunk));
				response.on("end", () => {
					let body: T | null = null;
					try {
						body = JSON.parse(rawBody) as T;
					} catch {}
					resolve({ status: response.statusCode ?? 0, body, rawBody });
				});
			},
		);
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error(`Codex API request timed out after ${timeoutMs}ms`));
		});
		req.end();
	});
}

function credentialCacheKey(credentials: CodexCredentials): string {
	return `${credentials.accountId}:${createHash("sha256").update(credentials.accessToken).digest("hex").slice(0, 16)}`;
}

export async function fetchCodexUsage(
	credentials: CodexCredentials,
	options: { maxAgeMs?: number; timeoutMs?: number; userAgent?: string } = {},
): Promise<CodexApiResponse<any>> {
	const key = credentialCacheKey(credentials);
	const maxAgeMs = Math.max(0, options.maxAgeMs ?? 0);
	const cached = usageCache.get(key);
	if (cached && Date.now() - cached.savedAt < maxAgeMs) return cached.response;

	const active = usageRequests.get(key);
	if (active) return active;
	const request = requestCodexApi(CODEX_USAGE_PATH, credentials, options)
		.then((response) => {
			if (response.status >= 200 && response.status < 300 && response.body !== null) {
				usageCache.set(key, { savedAt: Date.now(), response });
			}
			return response;
		})
		.finally(() => usageRequests.delete(key));
	usageRequests.set(key, request);
	return request;
}

export async function requestCodexJson<T = unknown>(
	endpoint: string,
	credentials: CodexCredentials,
	options: { timeoutMs?: number; userAgent?: string } = {},
): Promise<T> {
	const response = await requestCodexApi<T>(endpoint, credentials, options);
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`API Error ${response.status}: ${response.rawBody.slice(0, 200)}`);
	}
	if (response.body === null) throw new Error("Codex API returned invalid JSON");
	return response.body;
}
