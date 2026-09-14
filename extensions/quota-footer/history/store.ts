import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { QuotaHistoryPoint, QuotaHistoryStore } from "../types.ts";
import { shortHash } from "../utils.ts";

export function getHistoryFilePath(): string {
	const dir = path.join(os.homedir(), ".pi", "agent");
	return path.join(dir, "quota-history.json");
}

export function loadHistory(): QuotaHistoryStore {
	try {
		const fp = getHistoryFilePath();
		if (fs.existsSync(fp)) {
			const data = JSON.parse(fs.readFileSync(fp, "utf8"));
			if (data && typeof data === "object" && !Array.isArray(data)) {
				return data as QuotaHistoryStore;
			}
		}
	} catch {}
	return {};
}

export function saveHistory(store: QuotaHistoryStore): void {
	try {
		const fp = getHistoryFilePath();
		fs.mkdirSync(path.dirname(fp), { recursive: true });
		fs.writeFileSync(fp, JSON.stringify(store, null, 2), "utf8");
	} catch {}
}

export function getStorageKey(provider: string, apiKey: string): string {
	let keyIdentifier = shortHash(apiKey);
	if (provider === "antigravity") {
		try {
			const parsed = JSON.parse(apiKey);
			if (parsed?.projectId) keyIdentifier = parsed.projectId;
		} catch {}
	} else if (provider === "openai-codex") {
		try {
			const part = apiKey.split(".")[1];
			if (part) {
				const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
				const accId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
				if (accId) keyIdentifier = accId;
			}
		} catch {}
	}
	return `${provider}:${keyIdentifier}`;
}

export function recordQuotaChange(
	provider: string,
	apiKey: string,
	current: { leftPercent: number; resetAt?: number },
): boolean {
	const storageKey = getStorageKey(provider, apiKey);
	const store = loadHistory();
	let list = store[storageKey] || [];

	const now = Date.now();
	let shouldRecord = false;

	if (list.length === 0) {
		shouldRecord = true;
	} else {
		const last = list[list.length - 1];
		// Record if percentage changed
		if (last.leftPercent !== current.leftPercent) {
			shouldRecord = true;
		} else if (current.resetAt && last.resetAt && Math.abs(current.resetAt - last.resetAt) > 60_000) {
			// Or resetAt changed significantly
			shouldRecord = true;
		} else if (now - last.timestamp > 4 * 3600 * 1000) {
			// Or at least once every 4 hours as a heartbeat
			shouldRecord = true;
		}
	}

	if (shouldRecord) {
		const newPoint: QuotaHistoryPoint = {
			timestamp: now,
			leftPercent: current.leftPercent,
			...(current.resetAt ? { resetAt: current.resetAt } : {}),
		};
		list.push(newPoint);

		// Keep up to 30 days or max 500 points
		const cutoff = now - 30 * 24 * 3600 * 1000;
		list = list.filter((p) => p.timestamp >= cutoff);
		if (list.length > 500) {
			list = list.slice(list.length - 500);
		}

		store[storageKey] = list;
		saveHistory(store);
		return true;
	}
	return false;
}
