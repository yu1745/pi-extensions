/**
 * Cookie + XSRF handling for gemini.google.com.
 *
 * The cookie (Google AI Pro / Ultra login state) is the credential that unlocks
 * gemini-4-argon on the web endpoint. Stored locally in
 * ~/.pi/agent/gemini-web-cookie.json, chmod 0600. XSRF token (SNlM0e) and the
 * frontend bl version (cfb2h) are scraped from the /app page and cached 20 min / 6h.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromeFetchHeaders, geminiBase } from "./protocol.js";
import { webFetch } from "./http.js";

export interface WebCookieConfig {
	cookie: string;
	sapisid: string;
	authuser: number;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "gemini-web-cookie.json");

export function cookieStorePath(): string {
	return CONFIG_PATH;
}

export async function loadCookieConfig(): Promise<WebCookieConfig | null> {
	// Environment overrides for headless setups.
	const envCookie = process.env.GEMINI_WEB_COOKIE;
	if (envCookie) {
		return {
			cookie: envCookie,
			sapisid: extractSapisid(envCookie) ?? process.env.GEMINI_WEB_SAPISID ?? "",
			authuser: Number(process.env.GEMINI_WEB_AUTHUSER ?? "0") || 0,
		};
	}
	try {
		const raw = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<WebCookieConfig>;
		if (!parsed.cookie) return null;
		return {
			cookie: parsed.cookie,
			sapisid: parsed.sapisid || extractSapisid(parsed.cookie) || "",
			authuser: Number(parsed.authuser ?? "0") || 0,
		};
	} catch {
		return null;
	}
}

export async function saveCookieConfig(config: WebCookieConfig): Promise<void> {
	await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
	try {
		await chmod(CONFIG_PATH, 0o600);
	} catch {
		// best-effort on platforms without POSIX perms
	}
}

export function extractSapisid(cookie: string): string | undefined {
	return /(?:^|;\s*)SAPISID=([^;]+)/.exec(cookie)?.[1];
}

/**
 * Detect DevTools cookie-table paste: rows of `name<TAB or multi-space>value
 * <seps>domain…`, one cookie per line. Returns name→value for rows whose value
 * is a single token (multi-value rows like COMPASS `k=v,k2=v2` are kept whole;
 * rows whose value contains spaces that aren't a single token are skipped).
 */
function parseDevToolsTable(text: string): Map<string, string> | null {
	const rows: Map<string, string> = new Map();
	let matched = 0;
	for (const rawLine of text.split(/\n+/)) {
		const line = rawLine.trim();
		if (!line) continue;
		// Columns separated by 2+ spaces or tabs (DevTools copies use tabs or wide gaps).
		const cols = line.split(/\t+|\s{2,}/).map((c) => c.trim()).filter(Boolean);
		if (cols.length < 2) continue;
		const name = cols[0];
		const value = cols[1];
		if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) continue;
		if (name === "Name" || name === "名称") continue; // header row
		if (/\s/.test(value)) continue; // value column leaked extra columns
		matched++;
		if (!rows.has(name)) rows.set(name, value);
	}
	if (matched < 3) return null; // a real paste always has many rows
	return rows;
}

/**
 * Convert a DevTools cookie table into a Cookie request-header string,
 * keeping the rows the web protocol uses. Priority order matters when the
 * same name appears twice (_ga etc. across domains) — first occurrence wins.
 */
function tableToCookieHeader(rows: Map<string, string>): string {
	const priority = [
		"SID",
		"HSID",
		"SSID",
		"APISID",
		"SAPISID",
		"__Secure-1PSID",
		"__Secure-1PSIDTS",
		"__Secure-1PSIDCC",
		"__Secure-1PSIDRTS",
		"__Secure-3PSID",
		"__Secure-3PSIDTS",
		"__Secure-3PSIDCC",
		"__Secure-3PSIDRTS",
		"__Secure-1PAPISID",
		"__Secure-3PAPISID",
		"__Secure-ENID",
		"AEC",
		"NID",
		"SIDCC",
		"COMPASS",
	];
	const parts: string[] = [];
	const seen = new Set<string>();
	for (const name of priority) {
		const value = rows.get(name);
		if (value !== undefined) {
			parts.push(`${name}=${value}`);
			seen.add(name);
		}
	}
	for (const [name, value] of rows) {
		if (!seen.has(name)) parts.push(`${name}=${value}`);
	}
	return parts.join("; ");
}

/** Detect a multi-account Google session: same table carrying /u/N paths. */
function detectAuthUser(rows: Map<string, string>): number {
	// Authuser can also come as an explicit row when the user annotates it.
	const explicit = Number(rows.get("AUTHUSER") ?? "0");
	if (Number.isFinite(explicit) && explicit > 0) return explicit;
	// PLAY_ACTIVE_ACCOUNT carries authuser-N (play domain, but a decent hint).
	const m = /authuser-(\d+)/.exec(rows.get("PLAY_ACTIVE_ACCOUNT") ?? "");
	return m ? Number(m[1]) || 0 : 0;
}

/**
 * Parse a pasted cookie header line or a JSON {"cookie": "...", "authuser": N}
 * blob into a config. Accepts the exact export format from the reference project.
 */
export function parseCookieBlob(text: string): WebCookieConfig | null {
	const trimmed = text.trim();
	// DevTools cookie-table paste (tab/wide-gap separated rows) — the format
	// Chrome/Firefox DevTools put on the clipboard from the Cookies panel.
	const table = parseDevToolsTable(trimmed);
	if (table) {
		const cookie = tableToCookieHeader(table);
		if (cookie) {
			return { cookie, sapisid: extractSapisid(cookie) ?? "", authuser: detectAuthUser(table) };
		}
	}
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as { cookie?: string; authuser?: number };
			if (parsed.cookie) {
				return {
					cookie: parsed.cookie,
					sapisid: extractSapisid(parsed.cookie) ?? "",
					authuser: Number(parsed.authuser ?? "0") || 0,
				};
			}
		} catch {
			return null;
		}
	}
	if (/SID=|SAPISID=|__Secure-1PSID=/.test(trimmed)) {
		return {
			cookie: trimmed,
			sapisid: extractSapisid(trimmed) ?? "",
			authuser: 0,
		};
	}
	return null;
}

// ─── XSRF / bl scraping ────────────────────────────────────────────────────────

const snlm0eRe = /"SNlM0e":"([^"]{10,200})"/;
const cfb2hRe = /"cfb2h":"([^"]{10,120})"/;
const XSRF_TTL_MS = 20 * 60 * 1000;
// Old but stable bl value; used when the page scrape fails.
const FALLBACK_BL = "boq_gemini-web-uiserver_20261007.01_p0";

interface XsrfEntry {
	token: string;
	fetchedAt: number;
}
const xsrfCache = new Map<string, XsrfEntry>();
let blCache: { value: string; fetchedAt: number } | null = null;

function cookieKey(cookie: string, authuser: number): string {
	return createHash("sha1").update(cookie).digest("hex").slice(0, 16) + "/" + authuser;
}

export function invalidateXsrf(cookie: string, authuser: number): void {
	for (const key of xsrfCache.keys()) {
		if (key.startsWith(cookieKey(cookie, authuser).split("/")[0])) xsrfCache.delete(key);
	}
}

async function fetchAppPage(cookie: string, authuser: number): Promise<string> {
	const res = await webFetch(`${geminiBase(authuser)}/app`, {
		headers: {
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
			...(cookie ? { Cookie: cookie } : {}),
			...chromeFetchHeaders(),
		},
		redirect: "manual",
	});
	if (res.status === 302 || res.status === 303) {
		const loc = res.headers.get("location") ?? "";
		const host = new URL(loc || "https://unknown").host + new URL(loc || "https://unknown").pathname;
		throw new Error(`fetch /app: HTTP ${res.status} -> ${host}`);
	}
	if (res.status !== 200) throw new Error(`fetch /app: HTTP ${res.status}`);
	return res.text();
}

/** Fetch (or reuse) the XSRF token for a cookie/authuser pair. Empty cookie → "". */
export async function getXsrf(config: WebCookieConfig): Promise<string> {
	if (!config.cookie) return "";
	const key = cookieKey(config.cookie, config.authuser);
	const cached = xsrfCache.get(key);
	if (cached && Date.now() - cached.fetchedAt < XSRF_TTL_MS) return cached.token;

	const page = await fetchAppPage(config.cookie, config.authuser);
	const token = snlm0eRe.exec(page)?.[1];
	if (!token) {
		throw new Error("no SNlM0e in /app page (cookie expired or not signed in)");
	}
	xsrfCache.set(key, { token, fetchedAt: Date.now() });
	// Piggyback the bl version off the same page.
	const bl = cfb2hRe.exec(page)?.[1];
	if (bl) blCache = { value: bl, fetchedAt: Date.now() };
	return token;
}

/**
 * Frontend build label for StreamGenerate. Once scraped it is kept for the
 * process lifetime — stale values keep working for months, and the /app page
 * fetch (~700ms) is on the critical path of the first request otherwise.
 * Keep-alive rotation refreshes it opportunistically.
 */
export function currentBl(): string {
	return blCache?.value ?? FALLBACK_BL;
}

/** Best-effort anonymous bl refresh; never throws. */
export async function refreshBl(): Promise<void> {
	try {
		const page = await fetchAppPage("", 0);
		const bl = cfb2hRe.exec(page)?.[1];
		if (bl) blCache = { value: bl, fetchedAt: Date.now() };
	} catch {
		// keep fallback
	}
}

/** Verify the cookie still has a signed-in /app session (SNlM0e present). */
export async function checkCookieAlive(config: WebCookieConfig): Promise<{ ok: boolean; detail: string }> {
	try {
		await getXsrf(config);
		return { ok: true, detail: "signed in" };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}
