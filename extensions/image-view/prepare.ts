/**
 * 本地图片 → base64（Kitty / iTerm2 图形协议用的负载）。
 *
 * Kitty 只吃 PNG/JPEG（以及它自己格式的续帧），iTerm2 协议更宽松但仍以
 * PNG/JPEG 为主，所以统一在发送前归一化：
 *   - 小 PNG 原样透传，零损耗、零延迟；
 *   - 其余（JPEG/GIF/WebP/BMP/TIFF/AVIF/HEIC/SVG…）走 ImageMagick 转 PNG，
 *     并按 1600px 封顶，避免 4K 截图把几十 MB 塞进终端流；
 *   - 转出来还太大（> 3 MiB）就再压成 JPEG。
 *
 * 缩放由终端侧按单元格做，这里只做「传输体积」和「协议兼容」两件事。
 */

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_EDGE_PX = 1600;
const PASSTHROUGH_PNG_BYTES = 8 * 1024 * 1024;
const PNG_TO_JPEG_BYTES = 3 * 1024 * 1024;
const MAX_BUFFER = 64 * 1024 * 1024;

/** 只有这两种能直接喂给 Kitty，其它一律转码 */
const NATIVE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
};

export interface Prepared {
	base64: string;
	mimeType: string;
	widthPx: number;
	heightPx: number;
	/** 原始文件尺寸，仅用于页脚提示 */
	sourceBytes: number;
}

const cache = new Map<string, { stamp: string; prepared: Prepared }>();
const inFlight = new Map<string, Promise<Prepared | null>>();

const ext = (path: string) => (path.split(".").pop() ?? "").toLowerCase();

/** mtime+size 作为缓存键 */
async function stampOf(path: string): Promise<string> {
	const s = await stat(path);
	return `${Math.floor(s.mtimeMs)}:${s.size}`;
}

async function identify(path: string): Promise<{ w: number; h: number; format: string }> {
	const { stdout } = await execFileAsync("identify", ["-format", "%w %h %m", `${path}[0]`], {
		encoding: "utf8",
	});
	const [w, h, format] = stdout.trim().split(/\s+/);
	return { w: Number(w), h: Number(h), format: (format ?? "").toUpperCase() };
}

async function convertTo(
	path: string,
	format: "png" | "jpeg",
): Promise<{ base64: string; widthPx: number; heightPx: number }> {
	const args = [
		`${path}[0]`,
		"-auto-orient",
		"-resize",
		`${MAX_EDGE_PX}x${MAX_EDGE_PX}>`,
		"-strip",
	];
	if (format === "jpeg") args.push("-background", "#101418", "-alpha", "remove", "-quality", "85");
	const { stdout } = await execFileAsync("convert", [...args, `${format}:-`], {
		encoding: "base64",
		maxBuffer: MAX_BUFFER,
	});
	const info = await identify(path);
	const scale = Math.min(1, MAX_EDGE_PX / Math.max(info.w, info.h));
	return {
		base64: stdout.replace(/\s+/g, ""),
		widthPx: Math.max(1, Math.round(info.w * scale)),
		heightPx: Math.max(1, Math.round(info.h * scale)),
	};
}

async function build(path: string): Promise<Prepared> {
	const { size } = await stat(path);
	const mime = NATIVE_MIME[ext(path)];
	let info: { w: number; h: number; format: string };
	try {
		info = await identify(path);
	} catch {
		info = { w: 0, h: 0, format: "" };
	}

	// 小 PNG：原样透传
	if (mime === "image/png" && size <= PASSTHROUGH_PNG_BYTES && info.w <= MAX_EDGE_PX && info.h <= MAX_EDGE_PX) {
		const base64 = (await readFile(path)).toString("base64");
		return { base64, mimeType: "image/png", widthPx: info.w, heightPx: info.h, sourceBytes: size };
	}

	// 大 JPEG：不缩放直接用（体积本来就小），其余一律转 PNG
	if (mime === "image/jpeg" && size <= PASSTHROUGH_PNG_BYTES) {
		const base64 = (await readFile(path)).toString("base64");
		const scale = Math.min(1, MAX_EDGE_PX / Math.max(info.w || 1, info.h || 1));
		return {
			base64,
			mimeType: "image/jpeg",
			widthPx: Math.max(1, Math.round((info.w || 1) * scale)),
			heightPx: Math.max(1, Math.round((info.h || 1) * scale)),
			sourceBytes: size,
		};
	}

	let payload = await convertTo(path, "png");
	let mimeType = "image/png";
	if (payload.base64.length * 0.75 > PNG_TO_JPEG_BYTES) {
		const jpeg = await convertTo(path, "jpeg").catch(() => null);
		if (jpeg) {
			payload = jpeg;
			mimeType = "image/jpeg";
		}
	}
	return {
		base64: payload.base64,
		mimeType,
		widthPx: payload.widthPx,
		heightPx: payload.heightPx,
		sourceBytes: size,
	};
}

/**
 * 取一张本地图片的 base64 负载（带缓存与并发去重）。
 * Component.render() 是同步的，所以事件处理器里先 await 这个。
 */
export function prepareImage(path: string, opts?: { refresh?: boolean }): Promise<Prepared | null> {
	if (opts?.refresh) cache.delete(path);

	const task = (async () => {
		try {
			// stat 很便宜，每次都核对 mtime+size：图片被改写后自动重画
			const stamp = await stampOf(path);
			const cached = cache.get(path);
			if (cached && cached.stamp === stamp) return cached.prepared;

			const pending = inFlight.get(path);
			if (pending) return pending;

			const build0 = (async () => {
				try {
					const prepared = await build(path);
					cache.set(path, { stamp, prepared });
					return prepared;
				} finally {
					inFlight.delete(path);
				}
			})();
			inFlight.set(path, build0);
			return await build0;
		} catch {
			return null;
		}
	})();
	return task;
}

/** 强制重新生成（/img 手动刷新、或图片可能被改写时用） */
export function invalidateImage(path: string) {
	cache.delete(path);
}