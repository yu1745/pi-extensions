/**
 * Cookie keep-alive (port of gemini-web2api-go rotate.go).
 *
 * Two POSTs to accounts.google.com/RotateCookies refresh different families:
 *  1. Sentinel payload `[000,"-0000000000000000000"]` unconditionally rotates
 *     __Secure-1PSIDTS / __Secure-3PSIDTS — the ~30-minute tickets that die
 *     without renewal. Works for Firefox exports and non-DBSC-bound sessions.
 *  2. The browser-iframe flow: GET RotateCookiesPage for a session id, then
 *     POST `[658,"<id>"]` — refreshes SIDCC / *PSIDCC only.
 *
 * Responses' Set-Cookie lines are merged back into the stored cookie so the
 * session keeps rotating exactly like a live browser would.
 */
import { loadCookieConfig, saveCookieConfig, invalidateXsrf, type WebCookieConfig } from "./cookie.js";
import { chromeFetchHeaders } from "./protocol.js";
import { webFetch } from "./http.js";

const ROTATE_PAGE_URL =
	"https://accounts.google.com/RotateCookiesPage?og_pid=658&rot=3&origin=https%3A%2F%2Fgemini.google.com&exp_id=0";
const ROTATE_POST_URL = "https://accounts.google.com/RotateCookies";
const ROTATE_PRODUCT_ID = 658;
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const FIRST_ROTATE_DELAY_MS = 15 * 1000;
// Sentinel payload — leading zeros are intentional (JSPB format the server requires).
const ROTATE_1PSIDTS_BODY = '[000,"-0000000000000000000"]';
const MIN_1PSIDTS_INTERVAL_MS = 60 * 1000;
const ROTATE_1PSIDTS_COOKIES = ["__Secure-1PSID", "__Secure-1PSIDTS"];

let lastRotateAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

function cookieValue(cookie: string, name: string): string {
	for (const pair of cookie.split(/;\s*/)) {
		const idx = pair.indexOf("=");
		if (idx > 0 && pair.slice(0, idx) === name) return pair.slice(idx + 1);
	}
	return "";
}

function cookieSubset(cookie: string, names: string[]): string {
	return names
		.map((n) => {
			const v = cookieValue(cookie, n);
			return v ? `${n}=${v}` : "";
		})
		.filter(Boolean)
		.join("; ");
}

/** Merge Set-Cookie header values into a full cookie string. */
export function mergeSetCookie(cookie: string, setCookie: string[]): string {
	if (setCookie.length === 0) return cookie;
	const updates = new Map<string, string>();
	for (const sc of setCookie) {
		const first = sc.split(";")[0]?.trim() ?? "";
		const idx = first.indexOf("=");
		if (idx <= 0) continue;
		const name = first.slice(0, idx);
		const value = first.slice(idx + 1);
		// Deletion directives (past expiry + empty value) are not new values.
		if (value === "" && sc.toLowerCase().includes("expires=thu, 01 jan 1970")) continue;
		updates.set(name, value);
	}
	if (updates.size === 0) return cookie;
	const parts: string[] = [];
	const seen = new Set<string>();
	for (const pair of cookie.split(/;\s*/)) {
		if (!pair) continue;
		const idx = pair.indexOf("=");
		if (idx <= 0) continue;
		const name = pair.slice(0, idx);
		seen.add(name);
		parts.push(updates.has(name) ? `${name}=${updates.get(name)}` : pair);
	}
	for (const [name, value] of updates) {
		if (!seen.has(name)) parts.push(`${name}=${value}`);
	}
	return parts.join("; ");
}

interface RotateResponse {
	status: number;
	setCookie: string[];
	body: string;
}

async function rotateDo(
	method: "GET" | "POST",
	url: string,
	headers: Record<string, string>,
	body?: string,
): Promise<RotateResponse> {
	const res = await webFetch(url, {
		method,
		headers: {
			"Accept-Language": "en-US,en;q=0.9",
			...chromeFetchHeaders(),
			...headers,
		},
		body: body === undefined ? undefined : body,
		redirect: "manual",
	});
	const setCookie = res.headers.getSetCookie?.() ?? [];
	const text = await res.text();
	return { status: res.status, setCookie, body: text };
}

/** Rotate __Secure-1PSIDTS via the sentinel payload. */
async function rotate1psidts(cookie: string): Promise<{ cookie: string; names: string[] }> {
	const subset = cookieSubset(cookie, ROTATE_1PSIDTS_COOKIES);
	const { status, setCookie } = await rotateDo(
		"POST",
		ROTATE_POST_URL,
		{
			Accept: "*/*",
			"Content-Type": "application/json",
			Origin: "https://accounts.google.com",
			"Cache-Control": "no-cache",
			Pragma: "no-cache",
			"Sec-Fetch-Dest": "empty",
			"Sec-Fetch-Mode": "cors",
			"Sec-Fetch-Site": "same-origin",
			Cookie: subset,
		},
		ROTATE_1PSIDTS_BODY,
	);
	if (status === 401 || status === 403) {
		throw new Error(
			`RotateCookies 1PSIDTS returned HTTP ${status} (Chrome-exported cookies may be device-bound; re-export from Firefox)`,
		);
	}
	if (status !== 200) throw new Error(`RotateCookies 1PSIDTS returned HTTP ${status}`);
	return { cookie: mergeSetCookie(cookie, setCookie), names: setCookie.map(cookieName) };
}

function cookieName(setCookieLine: string): string {
	return setCookieLine.split("=")[0]?.trim() ?? "";
}

/** Rotate SIDCC family via the iframe flow. */
async function rotateSidcc(cookie: string): Promise<{ cookie: string; intervalMs: number; names: string[] }> {
	const page = await rotateDo("GET", ROTATE_PAGE_URL, {
		Cookie: cookie,
		Accept:
			"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
		Referer: "https://gemini.google.com/",
		"Sec-Fetch-Dest": "iframe",
		"Sec-Fetch-Mode": "navigate",
		"Sec-Fetch-Site": "same-site",
		"Upgrade-Insecure-Requests": "1",
	});
	if (page.status !== 200) throw new Error(`RotateCookiesPage returned HTTP ${page.status}`);
	let merged = mergeSetCookie(cookie, page.setCookie);
	// init('4162200486104360679', 658.0, 0.0, 0.0, 600.0) — last number is the interval.
	const m = /init\('([^']{4,64})'\s*,\s*([0-9.]+)\s*,[^)]*?([0-9.]+)\s*\)/.exec(page.body);
	if (!m) throw new Error("no init(...) in rotate page (cookie may be dead)");
	let intervalMs = DEFAULT_INTERVAL_MS;
	const sec = Number.parseFloat(m[3] ?? "0");
	if (Number.isFinite(sec) && sec >= 60 && sec <= 3600) intervalMs = sec * 1000;
	const { status, setCookie } = await rotateDo(
		"POST",
		ROTATE_POST_URL,
		{
			Accept: "*/*",
			"Content-Type": "application/json",
			Origin: "https://accounts.google.com",
			Referer: ROTATE_PAGE_URL,
			"Cache-Control": "no-cache",
			Pragma: "no-cache",
			"Sec-Fetch-Dest": "empty",
			"Sec-Fetch-Mode": "same-origin",
			"Sec-Fetch-Site": "same-origin",
			Cookie: merged,
		},
		`[${ROTATE_PRODUCT_ID},"${m[1]}"]`,
	);
	if (status !== 200) throw new Error(`RotateCookies returned HTTP ${status}`);
	merged = mergeSetCookie(merged, setCookie);
	return {
		cookie: merged,
		intervalMs,
		names: [...page.setCookie, ...setCookie].map(cookieName),
	};
}

/** One keep-alive pass for the stored cookie. Returns refreshed cookie names. */
export async function rotateCookie(config: WebCookieConfig): Promise<{ names: string[]; intervalMs: number }> {
	if (!config.cookie) return { names: [], intervalMs: DEFAULT_INTERVAL_MS };
	let cookie = config.cookie;
	const names: string[] = [];
	let intervalMs = DEFAULT_INTERVAL_MS;
	let changed = false;

	if (cookieValue(cookie, "__Secure-1PSID")) {
		const elapsed = Date.now() - lastRotateAt;
		if (elapsed >= MIN_1PSIDTS_INTERVAL_MS) {
			lastRotateAt = Date.now();
			try {
				const r = await rotate1psidts(cookie);
				if (r.cookie !== cookie) changed = true;
				cookie = r.cookie;
				names.push(...r.names);
			} catch (error) {
				console.error(`[gemini-web-app] 1PSIDTS rotate failed: ${error instanceof Error ? error.message : error}`);
			}
		}
	}
	try {
		const r = await rotateSidcc(cookie);
		if (r.cookie !== cookie) changed = true;
		cookie = r.cookie;
		names.push(...r.names);
		if (r.intervalMs > 0) intervalMs = r.intervalMs;
	} catch (error) {
		console.error(`[gemini-web-app] SIDCC rotate failed: ${error instanceof Error ? error.message : error}`);
	}

	if (changed) {
		const next = { ...config, cookie };
		await saveCookieConfig(next);
		invalidateXsrf(config.cookie, config.authuser);
	}
	// Opportunistic bl refresh off the hot path (keep-alive runs every ~10 min).
	void import("./cookie.js").then((c) => c.refreshBl());
	return { names, intervalMs };
}

/** Start the background keep-alive loop (idempotent). */
export function startKeepAlive(): void {
	if (timer || running) return;
	running = true;
	const loop = async () => {
		try {
			const config = await loadCookieConfig();
			if (config?.cookie) {
				const { intervalMs } = await rotateCookie(config);
				timer = setTimeout(loop, Math.max(intervalMs, DEFAULT_INTERVAL_MS));
				return;
			}
		} catch {
			// retry on the default cadence
		}
		timer = setTimeout(loop, DEFAULT_INTERVAL_MS);
	};
	timer = setTimeout(loop, FIRST_ROTATE_DELAY_MS);
}

export function stopKeepAlive(): void {
	if (timer) clearTimeout(timer);
	timer = null;
	running = false;
}
