/**
 * 本地图片 → Sixel 序列。
 *
 * 两步：
 *   1. `convert` 负责缩放 + 压平透明 + 量化，输出到 /tmp 缓存的 PNG；
 *   2. 读 PNG 的原始像素，自己手写 Sixel 编码器输出序列。
 *
 * 为什么不用 ImageMagick 的 `sixel:-` 写出器：它发的是 `\x1bP0;0;0q` 开头、
 * 颜色寄存器从 #0 起编、负载也更肥（同一张图 50KB vs 手写的 19KB），
 * 在部分终端上会被整段丢弃（表现为图不出现、行却占了）。手写版沿用
 * quota-footer 那条已被验证能显示的编码路径：`\x1bPq"1;1;W;H` 开头、
 * 调色板寄存器从 #1 起、每 6 像素一带、`!n<char>` 行程压缩。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CACHE_DIR = "/tmp/pi-sixel-image";
/** 最多 256 色，避免 sixel 体积失控 */
/**
 * 每通道量化级数。取 8 → 512 种颜色，是「终端 256 色寄存器上限」和
 * 「负载体积」之间的折中；再高寄存器就溢出，再低照片会明显色带。
 */
const COLOR_LEVELS = 8;
const MAX_BUFFER = 32 * 1024 * 1024;

export interface Raster {
	/** 完整的 sixel 负载，含 \x1bPq 头与 \x1b\\ 尾 */
	sixel: string;
	widthPx: number;
	heightPx: number;
	/** 源图经 EXIF 旋转后的显示尺寸（未缩放） */
	sourceWidth: number;
	sourceHeight: number;
}

async function run(args: string[], maxBuffer = MAX_BUFFER): Promise<string> {
	const { stdout } = await execFileAsync("convert", args, {
		maxBuffer,
		encoding: "binary",
	});
	return stdout;
}

function keyOf(path: string, stamp: string, widthPx: number) {
	return createHash("sha1").update(`${path}:${stamp}:${widthPx}`).digest("hex");
}

/** 读出图片经缩放压平后的 PNG 与真实像素尺寸 */
async function toPng(path: string, widthPx: number, stamp: string) {
	const cachePath = `${CACHE_DIR}/${keyOf(path, stamp, widthPx)}.png`;
	await mkdir(CACHE_DIR, { recursive: true });
	// [0] 只取第一帧（gif/apng），- > 表示只在需要时才放大
	await run([
		`${path}[0]`,
		"-auto-orient",
		"-resize",
		`${widthPx}x>`,
		"-background",
		"#101418",
		"-alpha",
		"remove",
		"-alpha",
		"off",
		"-strip",
		`png:${cachePath}`,
	]);
	const info = await execFileAsync("identify", ["-format", "%w %h", cachePath], {
		encoding: "utf8",
	});
	const [w, h] = info.stdout.trim().split(/\s+/).map(Number);
	if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
		throw new Error("identify 得到无效尺寸");
	}
	return { cachePath, widthPx: w, heightPx: h };
}

/** 读 PNG 的原始 RGB 像素（无压缩、无调色板） */
async function readRgb(path: string): Promise<{ width: number; height: number; rgb: Uint8Array }> {
	// -depth 8 保证每通道 1 字节；PNG 必须无 alpha，所以先压平再取像素
	const { stdout } = await execFileAsync(
		"convert",
		[`${path}[0]`, "-alpha", "off", "-depth", "8", "rgb:-"],
		{ encoding: "binary", maxBuffer: MAX_BUFFER },
	);
	const info = await execFileAsync("identify", ["-format", "%w %h", path], {
		encoding: "utf8",
	});
	const [width, height] = info.stdout.trim().split(/\s+/).map(Number);
	const rgb = new Uint8Array(Buffer.from(stdout, "latin1"));
	if (rgb.length < width * height * 3) throw new Error("读取像素数据不完整");
	return { width, height, rgb };
}

/** RGB → 颜色索引图 + 调色板（寄存器 0..N-1，与图像一起编码成 Sixel） */
function quantize(
	rgb: Uint8Array,
	pixels: number,
	levels: number,
): { index: Uint8Array; palette: number[][] } {
	const step = 255 / (levels - 1);
	// 调色板按 0..255 存，编码时直接写十进制
	const index = new Uint8Array(pixels);
	const palette: number[][] = [];
	const lookup = new Map<number, number>();

	for (let i = 0; i < pixels; i++) {
		const o = i * 3;
		// 每通道量化到 levels 级；抖动交给 Sixel 之外的均匀网格，避免体积膨胀
		const r = Math.round(rgb[o] / step);
		const g = Math.round(rgb[o + 1] / step);
		const b = Math.round(rgb[o + 2] / step);
		const key = (r << 16) | (g << 8) | b;
		let slot = lookup.get(key);
		if (slot === undefined) {
			slot = palette.length;
			palette.push([Math.round((r / (levels - 1)) * 255), Math.round((g / (levels - 1)) * 255), Math.round((b / (levels - 1)) * 255)]);
			lookup.set(key, slot);
		}
		index[i] = slot;
	}
	return { index, palette };
}

/**
 * 手写 Sixel 编码器，结构与 quota-footer/history/sixel.ts 的 generateSixelChart 一致：
 * 头部 `\x1bPq"1;1;W;H`，颜色定义从 #1 开始，每 6 像素一带逐颜色输出，
 * 相邻同色用 `!n<char>` 行程压缩，带间用 `-` 前进。
 */
function encodeSixel(
	width: number,
	height: number,
	index: Uint8Array,
	palette: number[][],
): string {
	// 调色板寄存器从 #1 起（和 quota-footer 图表一致，避开部分终端对 #0 的怪癖）。
	// 注意：Sixel 的颜色分量是 **0-100 百分比**，不是 0-255。写 219 会被终端
	// 截到 100 → 整张图发白（踩过：quota-footer 的调色板值都 <100 所以看不出来）。
	let out = `\x1bPq"1;1;${width};${height}`;
	palette.forEach(([r, g, b], slot) => {
		const pct = (v: number) => Math.max(0, Math.min(100, Math.round((v / 255) * 100)));
		out += `#${slot + 1};2;${pct(r)};${pct(g)};${pct(b)}`;
	});

	const bands = Math.ceil(height / 6);
	for (let band = 0; band < bands; band++) {
		const startY = band * 6;
		for (let slot = 0; slot < palette.length; slot++) {
			const color = slot + 1;
			let runChar = 0;
			let runCount = 0;
			let plane = "";
			for (let x = 0; x < width; x++) {
				let byte = 0;
				for (let bit = 0; bit < 6; bit++) {
					const y = startY + bit;
					if (y < height && index[y * width + x] === slot) byte |= 1 << bit;
				}
				if (byte === runChar) {
					runCount++;
				} else {
					if (runCount > 0) {
						plane +=
							runCount > 3 ? `!${runCount}${String.fromCharCode(63 + runChar)}` : String.fromCharCode(63 + runChar).repeat(runCount);
					}
					runChar = byte;
					runCount = 1;
				}
			}
			if (runCount > 0) {
				plane +=
					runCount > 3 ? `!${runCount}${String.fromCharCode(63 + runChar)}` : String.fromCharCode(63 + runChar).repeat(runCount);
			}
			// 整带都是空白就跳过，省掉大量 `#n$` 空平面
			if (/[^?]/.test(plane)) out += `#${color}${plane}$`;
		}
		if (band < bands - 1) out += "-";
	}
	out += "\x1b\\";
	return out;
}

/** 生成 sixel；同图同宽度只转一次 */
export async function renderSixel(
	path: string,
	targetWidthPx: number,
	_stamp: string,
): Promise<Raster> {
	const widthPx = Math.max(64, Math.round(targetWidthPx));
	const cachePath = `${CACHE_DIR}/${keyOf(path, _stamp, widthPx)}.png`;
	await mkdir(CACHE_DIR, { recursive: true });
	// [0] 只取第一帧（gif/apng），- > 表示只在需要时才放大
	await run([
		`${path}[0]`,
		"-auto-orient",
		"-resize",
		`${widthPx}x>`,
		"-background",
		"#101418",
		"-alpha",
		"remove",
		"-alpha",
		"off",
		"-colors",
		String(COLOR_LEVELS),
		"-strip",
		`png:${cachePath}`,
	]);
	const { width, height, rgb } = await readRgb(cachePath);
	const { index, palette } = quantize(rgb, width * height, COLOR_LEVELS);
	const sixel = encodeSixel(width, height, index, palette);
	const source = await execFileAsync("identify", ["-format", "%w %h", `${path}[0]`], {
		encoding: "utf8",
	}).catch(() => null);
	const [sw, sh] = (source?.stdout ?? "").trim().split(/\s+/).map(Number);

	return {
		sixel,
		widthPx: width,
		heightPx: height,
		sourceWidth: Number.isFinite(sw) ? sw : width,
		sourceHeight: Number.isFinite(sh) ? sh : height,
	};
}

/** 图片 mtime+size，用于缓存失效 */
export async function stampOf(path: string): Promise<string> {
	const { stdout } = await execFileAsync("identify", ["-format", "%T@ %b", path], {
		encoding: "utf8",
	});
	return stdout.trim();
}
