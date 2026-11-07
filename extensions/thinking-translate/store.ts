/**
 * 译文缓存落盘：跟着会话走，一个会话一个文件，就放在 session jsonl 旁边。
 *
 *   ~/.pi/agent/sessions/--home-wangyu--/2026-11-06T...-<uuid>.jsonl
 *   ~/.pi/agent/sessions/--home-wangyu--/2026-11-06T...-<uuid>.thinking-translate.txt
 *
 * 后缀故意**不是** `.jsonl`：pi 列会话/找会话都是 `file.endsWith(".jsonl")`，
 * 多一个 .jsonl 会被 `/resume` 当成坏会话去解析；换个后缀就完全不会被扫到。
 * 内容仍然是 jsonl（一行一条），读取只按行解析，跟后缀无关。
 *
 * 一行一条：
 *   {"k":"<sha1(原文)>","t":"译文"}
 * key 用原文的 sha1，不落原文（思考里可能夹代码、路径、密钥）；某行截断/损坏
 * 只影响那一条，加载时跳过。
 */

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** 前缀标识 + 后缀（非 .jsonl，避免被 pi 的会话发现逻辑扫到） */
export const CACHE_SUFFIX = ".thinking-translate.txt";

interface CacheRecord {
	k?: unknown;
	t?: unknown;
}

/** 原文 → 稳定 key */
export function translationKey(text: string): string {
	return createHash("sha1").update(text, "utf8").digest("hex");
}

/** `<dir>/<name>.jsonl` → `<dir>/<name>.thinking-translate.txt` */
export function cachePathFor(sessionFile: string): string {
	const name = basename(sessionFile).replace(/\.jsonl$/i, "");
	return join(dirname(sessionFile), `${name}${CACHE_SUFFIX}`);
}

/** 解析缓存：坏行、缺字段、空译文全部跳过，后写的覆盖先写的 */
export function parseCache(text: string): Map<string, string> {
	const entries = new Map<string, string>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let record: CacheRecord;
		try {
			record = JSON.parse(trimmed) as CacheRecord;
		} catch {
			continue;
		}
		if (typeof record?.k !== "string" || typeof record?.t !== "string") continue;
		if (!record.t.trim()) continue;
		entries.set(record.k, record.t);
	}
	return entries;
}

export class TranslationStore {
	private file: string | null = null;
	/** key → 译文 */
	readonly entries = new Map<string, string>();

	get cachePath(): string | null {
		return this.file;
	}

	/**
	 * 绑定会话文件并载入磁盘缓存（换会话就清空重载）。
	 * `--no-session` 这类没有 session 文件的场景传 undefined，退化成纯内存。
	 */
	attach(sessionFile: string | undefined): void {
		const next = sessionFile ? cachePathFor(sessionFile) : null;
		if (next === this.file) return;
		this.file = next;
		this.entries.clear();
		this.load();
	}

	private load(): void {
		if (!this.file) return;
		let raw: string;
		try {
			raw = readFileSync(this.file, "utf8");
		} catch {
			return; // 还没有缓存：正常情况
		}
		for (const [key, text] of parseCache(raw)) this.entries.set(key, text);
	}

	get(key: string): string | undefined {
		return this.entries.get(key);
	}

	/** 记忆 + 追加一行；落盘失败只影响下次恢复，不影响当前显示 */
	set(key: string, text: string, persist: boolean): void {
		this.entries.set(key, text);
		if (!persist || !this.file) return;
		try {
			appendFileSync(this.file, `${JSON.stringify({ k: key, t: text })}\n`, "utf8");
		} catch {
			/* 只读文件系统 / 目录不存在 / 磁盘满：静默降级成内存缓存 */
		}
	}

	clear(): void {
		this.entries.clear();
	}
}
