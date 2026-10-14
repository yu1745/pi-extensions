// river.ts — River (river.ai) prepaid balance monitor.
//
// River exposes two surfaces and only one of them knows the balance:
//
//   * https://api.river.ai is the inference gateway. It is gRPC-only behind
//     Envoy: every path except /v1/models answers HTTP 200 with `grpc-status:
//     12`, so the `rv_t_…` API key that authenticates completions can never
//     read a balance from it.
//   * https://console.river.ai is the Console, whose `/api/*` routes are the
//     real management API. The balance lives at GET /api/billing/account
//     (`balance_usd`, `balance_micro_usd`, `credit_limit_usd`, `status`) and it
//     authenticates with a **WorkOS access token**, never with the API key.
//
// That access token is minted from the Console's AuthKit session at
// POST {workos_api_hostname}/user_management/authenticate with
// `grant_type=refresh_token`. Two session footprints satisfy the grant:
//
//   * `refresh_token` in the body — what the Console itself keeps in storage;
//   * the sealed `wos-session` cookie — what AuthKit keeps in the browser.
//
// Both are the same single-use chain: every exchange consumes the head and
// returns a new one (plus a rotated `wos-session` Set-Cookie), and replaying a
// spent head fails with `invalid_grant: Refresh token already exchanged`. The
// head is therefore the only durable state, so it lives in
// `~/.pi/agent/river-session.json` (mode 0600) next to the access token that
// came with it. Access tokens last 5 minutes (`exp - iat` = 300 on every token
// observed), and reusing one until it is nearly expired is what keeps the
// single-use chain from advancing once per poll.
//
// Seeding: `RIVER_WOS_SESSION` / `RIVER_WORKOS_REFRESH_TOKEN` env vars and a
// `river` entry in pi's `auth.json` bootstrap the store. After that the file
// owns the chain — but a *new* seed value (the user re-exported a cookie) is
// detected by fingerprint and takes over, so re-seeding never needs a manual
// file delete even though the env var itself can never be rotated.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FailureKind, FetchResult, ProviderConfig } from "../types.ts";
import { asFiniteNumber, bar, colorFor, REQUEST_TIMEOUT_MS } from "../utils.ts";

const RIVER_DEFAULT_CONSOLE = "https://console.river.ai";
const RIVER_DEFAULT_AUTH = "https://auth.console.river.ai";
// Public AuthKit client id; /api/auth/config is asked first and this is only the
// fallback for when that call cannot be made.
const RIVER_DEFAULT_CLIENT_ID = "client_01M0TG5W3GBNMFS87K40PYHM98";

// A WorkOS access token lives 300s. Treat it as spent one minute early and
// assume 240s if the JWT cannot be decoded.
const RIVER_TOKEN_SKEW_MS = 60_000;
const RIVER_TOKEN_FALLBACK_MS = 240_000;

// River currency is USD. The balance is a prepaid pool with no cap, so the bar
// needs an arbitrary full-bar reference — the same trick `deepseek.ts` uses with
// ¥50 — and the colours come from fixed dollar thresholds unless the account
// carries an explicit low-balance threshold.
const RIVER_FULL_BAR_USD = 50;
const RIVER_LOW_USD = 2;
const RIVER_MID_USD = 5;

export const RIVER_STORE_VERSION = 1;

const RIVER_REFRESH_BANDS = [
	{ minBalanceUsd: 10, ttlMs: 300_000 }, // ≥ $10 → 5 min
	{ minBalanceUsd: 0, ttlMs: 60_000 }, // < $10 → 1 min
] as const;

export interface RiverStore {
	version?: number;
	refresh_token?: string;
	wos_session?: string;
	access_token?: string;
	access_expires_at?: number;
	email?: string;
	updated_at?: string;
	/** Last *successful* exchange. Drives the keep-alive, unlike `updated_at`. */
	refreshed_at?: string;
	/**
	 * Head that already failed with a terminal `invalid_grant`. Self-invalidating:
	 * a successful mint rotates the head away from it, so nothing has to be
	 * cleared by hand. It exists only so a fresh seed can take over a dead store.
	 */
	head_dead?: string;
}

export interface RiverPayload {
	balanceUsd: number;
	creditLimitUsd: number;
	status: string;
	ownerEmail?: string;
	lowBalanceThresholdUsd?: number;
	updatedAt?: string;
}

export interface RiverDeps {
	fetchImpl?: typeof fetch;
	consoleBase?: string;
	authBase?: string;
	clientId?: string;
	timeoutMs?: number;
	now?: () => number;
	/** Overrides the store path — tests point this at a temp file. */
	storeFile?: string;
	/** Skips env/auth.json seeding — tests drive the store directly. */
	noSeed?: boolean;
}

// ─── store ───────────────────────────────────────────────────────────────────

function withScheme(value: string): string {
	return /^https?:\/\//i.test(value) ? value.replace(/\/+$/, "") : `https://${value.replace(/\/+$/, "")}`;
}

export function riverConsoleBase(deps: RiverDeps = {}): string {
	return withScheme(deps.consoleBase ?? process.env.RIVER_CONSOLE_BASE ?? RIVER_DEFAULT_CONSOLE);
}

export function riverStoreFile(deps: RiverDeps = {}): string {
	const forced = deps.storeFile ?? process.env.RIVER_SESSION_FILE;
	if (forced) return forced;
	try {
		return join(getAgentDir(), "river-session.json");
	} catch {
		return join(process.env.HOME || process.env.USERPROFILE || ".", ".pi", "agent", "river-session.json");
	}
}

function piAuthFile(): string | undefined {
	try {
		return join(getAgentDir(), "auth.json");
	} catch {
		return undefined;
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function riverStoreHead(store: RiverStore | null): string | undefined {
	if (!store) return undefined;
	return asString(store.refresh_token) ?? asString(store.wos_session);
}

/** A store is only usable once it can satisfy at least one grant shape. */
function isUsable(store: RiverStore | null): store is RiverStore {
	return Boolean(store && (asString(store.refresh_token) || asString(store.wos_session)));
}

export function readRiverStoreFile(deps: RiverDeps = {}): RiverStore | null {
	try {
		const raw = JSON.parse(readFileSync(riverStoreFile(deps), "utf8"));
		if (!raw || typeof raw !== "object") return null;
		return {
			...(asFiniteNumber(raw.version) !== null ? { version: raw.version as number } : {}),
			...(asString(raw.refresh_token) ? { refresh_token: asString(raw.refresh_token) } : {}),
			...(asString(raw.wos_session) ? { wos_session: asString(raw.wos_session) } : {}),
			...(asString(raw.access_token) ? { access_token: asString(raw.access_token) } : {}),
			...(asFiniteNumber(raw.access_expires_at) !== null
				? { access_expires_at: raw.access_expires_at as number }
				: {}),
			...(asString(raw.email) ? { email: asString(raw.email) } : {}),
			...(asString(raw.updated_at) ? { updated_at: asString(raw.updated_at) } : {}),
			...(asString(raw.refreshed_at) ? { refreshed_at: asString(raw.refreshed_at) } : {}),
			...(asString(raw.head_dead) ? { head_dead: asString(raw.head_dead) } : {}),
		};
	} catch {
		return null;
	}
}

/** A seed is the bootstrap/recovery copy of a session, never the live head. */
function readRiverSeed(deps: RiverDeps = {}): RiverStore | null {
	if (deps.noSeed) return null;

	const env: RiverStore = {};
	const refresh = asString(process.env.RIVER_WORKOS_REFRESH_TOKEN);
	const cookie = asString(process.env.RIVER_WOS_SESSION);
	if (refresh) env.refresh_token = refresh;
	if (cookie) env.wos_session = cookie;
	if (isUsable(env)) return { version: RIVER_STORE_VERSION, ...env };

	const authFile = piAuthFile();
	if (!authFile) return null;
	try {
		const river = JSON.parse(readFileSync(authFile, "utf8"))?.river;
		if (!river || typeof river !== "object") return null;
		// `refresh` is pi's oauth field; `refresh_token` / `wos_session` are ours.
		const token = asString(river.refresh) ?? asString(river.refresh_token) ?? asString(river.wos_session);
		if (!token) return null;
		const store: RiverStore = { version: RIVER_STORE_VERSION };
		if (token.startsWith("Fe26.")) store.wos_session = token;
		else store.refresh_token = token;
		if (asString(river.email)) store.email = asString(river.email);
		return isUsable(store) ? store : null;
	} catch {
		return null;
	}
}

/**
 * The live session. The file wins, and that is load-bearing: it holds the
 * rotated single-use head, so re-reading an unchanged env var would replay a
 * spent token and advance WorkOS's reuse detection against us.
 *
 * A seed is therefore only consulted when the file cannot serve a refresh at
 * all — no session yet, or the head it holds is already terminally dead. That is
 * exactly the re-seed path: drop a fresh cookie into `RIVER_WOS_SESSION` (or
 * pi's `auth.json`) and the next poll picks it up, with no file to delete.
 */
export function readRiverStore(deps: RiverDeps = {}): RiverStore | null {
	const file = readRiverStoreFile(deps);
	if (isUsable(file) && !isHeadDead(file)) return file;

	const seed = readRiverSeed(deps);
	if (isUsable(seed)) {
		// A different session: the cached access token belongs to the old one.
		return { ...seed, head_dead: undefined };
	}
	return isUsable(file) ? file : null;
}

function isHeadDead(store: RiverStore | null): boolean {
	const head = riverStoreHead(store);
	return Boolean(head) && asString(store?.head_dead) === head;
}

/** Atomic, 0600 — a half-written store would burn the single-use chain. */
export function persistRiverStore(
	patch: RiverStore,
	deps: RiverDeps = {},
	opts: { reset?: boolean } = {},
): void {
	const path = riverStoreFile(deps);
	const previous = opts.reset ? {} : readRiverStoreFile(deps) ?? {};
	const merged: RiverStore = {
		...previous,
		...patch,
		version: RIVER_STORE_VERSION,
		updated_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
	};
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, path);
	} catch {
		try {
			rmSync(tmp, { force: true });
		} catch {}
	}
}

/**
 * Stable identity for the footer's cache key. Deliberately *not* the rotating
 * token: a new head every few minutes must not look like a new account.
 */
export function riverCredentialId(deps: RiverDeps = {}): string | undefined {
	const store = readRiverStore(deps);
	if (!store) return undefined;
	const email = asString(store.email);
	return email ? `river:${email}` : "river:console";
}

// ─── auth ────────────────────────────────────────────────────────────────────

let authConfigCache: { consoleBase: string; authBase: string; clientId: string } | null = null;

/** Only the hostname lookup is cached; a stale client id would break logins. */
export async function resolveRiverAuthConfig(deps: RiverDeps = {}): Promise<{ authBase: string; clientId: string }> {
	const consoleBase = riverConsoleBase(deps);
	const envHost = asString(process.env.RIVER_WORKOS_API_HOSTNAME);
	const envClient = asString(process.env.RIVER_WORKOS_CLIENT_ID);
	if (deps.authBase || deps.clientId || envHost) {
		return {
			authBase: withScheme(deps.authBase ?? envHost ?? RIVER_DEFAULT_AUTH),
			clientId: deps.clientId ?? envClient ?? RIVER_DEFAULT_CLIENT_ID,
		};
	}
	if (authConfigCache?.consoleBase === consoleBase) {
		return { authBase: authConfigCache.authBase, clientId: authConfigCache.clientId };
	}
	try {
		const res = await (deps.fetchImpl ?? fetch)(`${consoleBase}/api/auth/config`, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
		});
		const body = await res.json();
		const config = {
			consoleBase,
			authBase: withScheme(asString(body?.workos_api_hostname) ?? envHost ?? RIVER_DEFAULT_AUTH),
			clientId: asString(body?.workos_client_id) ?? envClient ?? RIVER_DEFAULT_CLIENT_ID,
		};
		authConfigCache = config;
		return { authBase: config.authBase, clientId: config.clientId };
	} catch {
		return { authBase: withScheme(envHost ?? RIVER_DEFAULT_AUTH), clientId: envClient ?? RIVER_DEFAULT_CLIENT_ID };
	}
}

export interface RiverToken {
	accessToken: string;
	expiresAt: number;
	refreshToken?: string;
	wosSession?: string;
	email?: string;
}

export type RiverMintResult = { ok: true; token: RiverToken } | { ok: false; kind: FailureKind };

/** `exp` is the only trustworthy lifetime; the JWT is not otherwise inspected. */
export function jwtExpiryMs(token: string, now: number): number {
	const segment = token.split(".")[1];
	if (!segment) return now + RIVER_TOKEN_FALLBACK_MS;
	try {
		const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
		const decoded = Buffer.from(normalized, "base64").toString("utf8");
		const exp = asFiniteNumber(JSON.parse(decoded)?.exp);
		if (exp !== null && exp > 0) return exp * 1000;
	} catch {}
	return now + RIVER_TOKEN_FALLBACK_MS;
}

/** `getSetCookie()` is Node-only; fall back to parsing the folded header. */
export function readSetCookie(res: Response, name: string): string | undefined {
	const headers = res.headers as Headers & { getSetCookie?: () => string[] };
	const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
	for (const raw of values ?? []) {
		const match = new RegExp(`^\\s*${name}=([^;]*)`).exec(raw);
		if (match) return match[1];
	}
	const folded = res.headers.get("set-cookie");
	if (!folded) return undefined;
	const match = new RegExp(`(?:^|[,;]\\s*)${name}=([^;]*)`).exec(folded);
	return match ? match[1] : undefined;
}

function classifyAuthFailure(status: number, body: any): FailureKind {
	const message = `${asString(body?.error) ?? ""} ${asString(body?.error_description) ?? ""} ${
		asString(body?.message) ?? ""
	}`;
	if (status === 429 || /rate\s*limit|too many/i.test(message)) return "rate_limited";
	// `invalid_grant: Refresh token already exchanged` means the single-use head
	// is spent — a stale copy, not a revoked login. Either way it needs re-seeding.
	if (status === 401 || status === 400 || status === 403 || /invalid_grant|invalid_request|unauthori/i.test(message)) {
		return "auth_error";
	}
	return "unavailable";
}

/**
 * Exchange the stored session for a fresh access token.
 *
 * The refresh token is tried first because it is what the Console itself uses;
 * the sealed cookie is the fallback for a store whose token half is stale. Both
 * point at the same chain, so a partial failure here is normal after another pi
 * process (or the browser) advanced it — `fetchRiver` re-reads and retries.
 */
export async function mintRiverAccessToken(store: RiverStore, deps: RiverDeps = {}): Promise<RiverMintResult> {
	const now = deps.now?.() ?? Date.now();
	const { authBase, clientId } = await resolveRiverAuthConfig(deps);
	const url = `${authBase}/user_management/authenticate`;
	const fetchImpl = deps.fetchImpl ?? fetch;

	const attempts: Array<{ cookie?: string; body: Record<string, string> }> = [];
	const refreshToken = asString(store.refresh_token);
	const wosSession = asString(store.wos_session);
	if (refreshToken) attempts.push({ body: { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken } });
	if (wosSession) attempts.push({ cookie: wosSession, body: { grant_type: "refresh_token", client_id: clientId } });
	if (attempts.length === 0) return { ok: false, kind: "auth_error" };

	let lastKind: FailureKind = "auth_error";
	for (const attempt of attempts) {
		let res: Response;
		try {
			res = await fetchImpl(url, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					...(attempt.cookie ? { Cookie: `wos-session=${attempt.cookie}` } : {}),
				},
				body: JSON.stringify(attempt.body),
				signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
			});
		} catch {
			lastKind = "unavailable";
			continue;
		}

		const text = await res.text().catch(() => "");
		let body: any = null;
		try {
			body = JSON.parse(text);
		} catch {}

		if (!res.ok || !asString(body?.access_token)) {
			lastKind = classifyAuthFailure(res.status, body);
			if (lastKind === "rate_limited") return { ok: false, kind: lastKind };
			continue;
		}

		const accessToken = asString(body.access_token)!;
		return {
			ok: true,
			token: {
				accessToken,
				expiresAt: jwtExpiryMs(accessToken, now),
				// A `useCookie` grant may answer without a refresh token; the sealed
				// cookie it returns carries the same head either way.
				...(asString(body?.refresh_token) ? { refreshToken: asString(body.refresh_token) } : {}),
				...(readSetCookie(res, "wos-session") ? { wosSession: readSetCookie(res, "wos-session") } : {}),
				...(asString(body?.user?.email) ? { email: asString(body.user.email) } : {}),
			},
		};
	}
	return { ok: false, kind: lastKind };
}

// ─── balance ─────────────────────────────────────────────────────────────────

export function parseRiverAccount(body: any, now = Date.now()): FetchResult {
	if (!body || typeof body !== "object") return { kind: "unavailable", at: now };

	const message = `${asString(body.error) ?? ""} ${asString(body.message) ?? ""}`;
	if (/rate\s*limit|too many/i.test(message)) return { kind: "rate_limited", at: now };
	// The Console words a rejected token as "invalid WorkOS access token: …".
	if (/unauthori|invalid|forbidden|token|expired/i.test(message)) return { kind: "auth_error", at: now };

	const balanceUsd = asFiniteNumber(body.balance_usd);
	const micro = asFiniteNumber(body.balance_micro_usd);
	const resolved = balanceUsd ?? (micro !== null ? micro / 1e6 : null);
	if (resolved === null) return { kind: "unavailable", at: now };

	return {
		kind: "success",
		fetchedAt: now,
		payload: {
			balanceUsd: resolved,
			creditLimitUsd: asFiniteNumber(body.credit_limit_usd) ?? (asFiniteNumber(body.credit_limit_micro_usd) ?? 0) / 1e6,
			status: asString(body.status) ?? "unknown",
			...(asString(body.owner_email) ? { ownerEmail: asString(body.owner_email) } : {}),
			...(asFiniteNumber(body.low_balance_threshold_usd) !== null
				? { lowBalanceThresholdUsd: asFiniteNumber(body.low_balance_threshold_usd)! }
				: {}),
			...(asString(body.updated_at) ? { updatedAt: asString(body.updated_at) } : {}),
		},
	};
}

export function riverTtlFor(payload: unknown): number {
	const balance = asFiniteNumber((payload as RiverPayload)?.balanceUsd) ?? 0;
	const band = RIVER_REFRESH_BANDS.find((b) => balance >= b.minBalanceUsd);
	return band ? band.ttlMs : RIVER_REFRESH_BANDS[RIVER_REFRESH_BANDS.length - 1].ttlMs;
}

export function riverLowThresholds(payload: RiverPayload): { low: number; mid: number } {
	// An explicit low-balance threshold (what the Console itself warns at) is the
	// best "act now" line; the fixed pair is the fallback for accounts without one.
	const low = payload.lowBalanceThresholdUsd ?? RIVER_LOW_USD;
	return { low, mid: Math.max(low * 2.5, RIVER_MID_USD) };
}

async function queryRiverAccount(accessToken: string, deps: RiverDeps): Promise<FetchResult> {
	const consoleBase = riverConsoleBase(deps);
	const teamId = asString(process.env.RIVER_TEAM_ID);
	try {
		const res = await (deps.fetchImpl ?? fetch)(`${consoleBase}/api/billing/account`, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${accessToken}`,
				...(teamId ? { "X-River-Team": teamId } : {}),
			},
			signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
		});
		const text = await res.text().catch(() => "");
		let body: any = null;
		try {
			body = JSON.parse(text);
		} catch {}
		if (res.status === 429) return { kind: "rate_limited", at: Date.now() };
		if (res.status === 401 || res.status === 403) return { kind: "auth_error", at: Date.now() };
		return parseRiverAccount(body);
	} catch {
		return { kind: "unavailable", at: Date.now() };
	}
}

/** True when the session in hand did not come from the on-disk file. */
function isSeedAdoption(store: RiverStore, deps: RiverDeps): boolean {
	const file = readRiverStoreFile(deps);
	if (!isUsable(file)) return true;
	return isHeadDead(file) && riverStoreHead(file) !== riverStoreHead(store);
}

/** One balance read: reuse the cached access token, minting only when it is spent. */
export async function fetchRiverBalance(store: RiverStore, deps: RiverDeps = {}): Promise<FetchResult> {
	const now = deps.now?.() ?? Date.now();
	const cached = asString(store.access_token);
	let accessToken = cached && (asFiniteNumber(store.access_expires_at) ?? 0) - RIVER_TOKEN_SKEW_MS > now ? cached : undefined;

	if (!accessToken) {
		const minted = await mintRiverAccessToken(store, deps);
		if (!minted.ok) return { kind: minted.kind, at: now };
		accessToken = minted.token.accessToken;
		// Persist before the balance call: the head was already spent by the
		// exchange, so losing it here would burn the chain. A freshly adopted seed
		// resets the file instead of merging — the old session's head and cached
		// token must not survive the swap.
		persistRiverStore(
			{
				...store,
				access_token: accessToken,
				access_expires_at: minted.token.expiresAt,
				...(minted.token.refreshToken ? { refresh_token: minted.token.refreshToken } : {}),
				...(minted.token.wosSession ? { wos_session: minted.token.wosSession } : {}),
				...(minted.token.email ? { email: minted.token.email } : {}),
				refreshed_at: new Date(now).toISOString(),
			},
			deps,
			{ reset: isSeedAdoption(store, deps) },
		);
	}

	return queryRiverAccount(accessToken, deps);
}

/**
 * ProviderConfig entry point — the argument is the footer's stable identity, not
 * a credential, so the live session is resolved here. A stale head is retried
 * once against whatever the store holds after another process rotated it.
 *
 * Per WorkOS's own resilience rules, only a terminal `invalid_grant` is treated
 * as a dead session; timeouts, 429 and 5xx stay transient and keep the stored
 * session untouched, because signing a user out over a blip is the one mistake
 * that cannot be undone locally.
 */
export async function fetchRiver(_credential?: string, deps: RiverDeps = {}): Promise<FetchResult> {
	const first = readRiverStore(deps);
	if (!first) return { kind: "auth_error", at: Date.now() };
	const result = await fetchRiverBalance(first, deps);
	if (result.kind !== "auth_error") return result;

	// Terminal. Record the dead head so the next read falls through to a fresh
	// seed instead of replaying a spent token forever. The session itself is left
	// in place: a re-seed only has to drop in a new cookie, and a misclassified
	// failure must never destroy the only copy of a login.
	const head = riverStoreHead(first);
	if (head) persistRiverStore({ head_dead: head }, deps);

	const second = readRiverStore(deps);
	if (!second || riverStoreHead(second) === head) return result;
	return fetchRiverBalance(second, deps);
}

// ─── keep-alive ──────────────────────────────────────────────────────────────

/**
 * WorkOS ends a session when no refresh has happened for the application's
 * "inactivity timeout" (the maximum session length is a separate, absolute
 * cap). The footer only ever polls the *active* provider, so a River session
 * would lapse from pure disuse while the user works in some other model. One
 * cheap exchange per interval keeps the inactivity clock reset.
 */
export const RIVER_KEEPALIVE_MS = 60 * 60_000;

/** How often the cheap in-memory due-check may touch the store file. */
export const RIVER_KEEPALIVE_CHECK_MS = 5 * 60_000;

export function riverKeepAliveMs(): number {
	const raw = Number.parseInt(process.env.RIVER_KEEPALIVE_MS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : RIVER_KEEPALIVE_MS;
}

/** Off with `RIVER_KEEPALIVE=0` for anyone sharing one session with a browser. */
export function riverKeepAliveEnabled(): boolean {
	return !/^(0|false|no|off)$/i.test(process.env.RIVER_KEEPALIVE ?? "");
}

export function riverKeepAliveDue(deps: RiverDeps = {}): boolean {
	if (!riverKeepAliveEnabled()) return false;
	const store = readRiverStore(deps);
	if (!store) return false;
	const last = Date.parse(asString(store.refreshed_at) ?? asString(store.updated_at) ?? "") || 0;
	return (deps.now?.() ?? Date.now()) - last >= riverKeepAliveMs();
}

/** Fire-and-forget: never throws, never touches ctx. */
export async function keepRiverSessionWarm(deps: RiverDeps = {}): Promise<void> {
	try {
		if (!riverKeepAliveDue(deps)) return;
		await fetchRiver(undefined, deps);
	} catch {}
}

// ─── seeding ─────────────────────────────────────────────────────────────────

/**
 * Write a freshly exported session into the store, replacing whatever was there.
 * Accepts either a sealed `wos-session` cookie (what the browser shows) or a
 * bare WorkOS refresh token.
 */
export function seedRiverSession(value: string, deps: RiverDeps = {}): boolean {
	const trimmed = asString(value);
	if (!trimmed) return false;
	// Tolerate a whole `Set-Cookie`/devtools row: drop a `name=` prefix and any
	// trailing attributes after the first `;`. Sealed values contain `*` but no
	// `;`, so this cannot clip a real cookie.
	const bare = trimmed
		.replace(/^\s*(?:wos-session|workos-session|workos-has-session|refresh_token|RIVER_[A-Z_]+)=/i, "")
		.split(";")[0]
		.trim();
	const field: RiverStore = bare.startsWith("Fe26.") ? { wos_session: bare } : { refresh_token: bare };
	if (!isUsable(field)) return false;
	persistRiverStore({ ...field }, deps, { reset: true });
	return true;
}

// ─── render ──────────────────────────────────────────────────────────────────

function formatUsd(value: number): string {
	if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
	if (value >= 100) return value.toFixed(0);
	return value.toFixed(2);
}

export function renderRiver(payload: unknown, ctx: ExtensionContext): string {
	const t = ctx.ui.theme;
	const state = payload as RiverPayload;
	const { low, mid } = riverLowThresholds(state);
	const color = colorFor(state.balanceUsd, low, mid);
	// Absolute balance, `bar()` against an arbitrary full-bar reference.
	const fill = Math.max(0, Math.min(100, (state.balanceUsd / RIVER_FULL_BAR_USD) * 100));

	const parts: string[] = [
		t.fg("dim", "River") + " " + t.fg(color, bar(fill)) + " " + t.fg(color, `$${formatUsd(state.balanceUsd)}`),
	];
	if (state.creditLimitUsd > 0) parts.push(t.fg("dim", `+$${formatUsd(state.creditLimitUsd)} limit`));
	if (state.status !== "active") parts.push(t.fg("warning", state.status));
	return parts.join(t.fg("dim", " "));
}

export const riverProviderConfig: ProviderConfig = {
	label: "River",
	unavailableWord: "balance",
	noKeyLabel: "no login",
	fetch: fetchRiver,
	render: renderRiver,
	ttlFor: riverTtlFor,
};
