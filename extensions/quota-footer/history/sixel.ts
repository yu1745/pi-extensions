import type { QuotaHistoryPoint } from "../types.ts";

export function formatShortDateTime(ts: number): string {
	const d = new Date(ts);
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	const h = String(d.getHours()).padStart(2, "0");
	const min = String(d.getMinutes()).padStart(2, "0");
	return `${m}-${day} ${h}:${min}`;
}

export function formatDurationHrs(ms: number): string {
	const hours = ms / (3600 * 1000);
	if (hours < 24) return `${hours.toFixed(1)}h`;
	const days = hours / 24;
	return `${days.toFixed(1)}d`;
}

export function generateSixelChart(
	points: QuotaHistoryPoint[],
	widthPx = 1120,
	heightPx = 540,
): string {
	const buffer = new Uint8Array(widthPx * heightPx);
	const minTime = points[0].timestamp;
	const lastTime = points[points.length - 1].timestamp;
	const maxTime = lastTime === minTime ? minTime + 60_000 : lastTime;

	// Draw labels inside the raster, not as terminal text over image rows.
	// A tiny 5x7 font keeps Sixel generation dependency-free (3x for readability).
	const glyphs: Record<string, number[]> = {
		"0": [14, 17, 19, 21, 25, 17, 14],
		"1": [4, 12, 4, 4, 4, 4, 14],
		"2": [14, 17, 1, 2, 4, 8, 31],
		"3": [30, 1, 1, 14, 1, 1, 30],
		"4": [2, 6, 10, 18, 31, 2, 2],
		"5": [31, 16, 16, 30, 1, 1, 30],
		"6": [14, 16, 16, 30, 17, 17, 14],
		"7": [31, 1, 2, 4, 8, 8, 8],
		"8": [14, 17, 17, 14, 17, 17, 14],
		"9": [14, 17, 17, 15, 1, 1, 14],
		"%": [25, 25, 2, 4, 8, 19, 19],
		"-": [0, 0, 0, 31, 0, 0, 0],
		":": [0, 4, 4, 0, 4, 4, 0],
	};
	const pixel = (x: number, y: number, color: number) => {
		if (x >= 0 && x < widthPx && y >= 0 && y < heightPx) buffer[y * widthPx + x] = color;
	};
	const fontScale = 3;
	const textWidth = (text: string) => (text.length * 6 - 1) * fontScale;
	const drawText = (text: string, x: number, y: number) => {
		for (const char of text) {
			const glyph = glyphs[char];
			if (glyph) {
				for (let row = 0; row < 7; row++) {
					for (let col = 0; col < 5; col++) {
						if (glyph[row] & (1 << (4 - col))) {
							for (let dy = 0; dy < fontScale; dy++) {
								for (let dx = 0; dx < fontScale; dx++) {
									pixel(x + col * fontScale + dx, y + row * fontScale + dy, 4);
								}
							}
						}
					}
				}
			}
			x += 6 * fontScale;
		}
	};
	const left = 86,
		right = widthPx - 12,
		top = 12,
		bottom = heightPx - 62;
	const plotWidth = right - left,
		plotHeight = bottom - top;
	const yFor = (percent: number) =>
		top + Math.round((1 - Math.max(0, Math.min(100, percent)) / 100) * plotHeight);

	// Dashed grid underneath the curve; area fill preserves these pixels.
	// Horizontal lines every 10%, vertical lines at quarter-time intervals.
	const dashLength = 8,
		dashPeriod = 14;
	for (let step = 1; step <= 9; step++) {
		const y = yFor(step * 10);
		for (let x = left + 1; x <= right; x++) {
			if ((x - left) % dashPeriod < dashLength) pixel(x, y, 1);
		}
	}
	for (const fraction of [0.25, 0.5, 0.75, 1]) {
		const x = left + Math.round(fraction * plotWidth);
		for (let y = top; y < bottom; y++) {
			if ((y - top) % dashPeriod < dashLength) pixel(x, y, 1);
		}
	}

	const coords = points.map((p) => ({
		x:
			left +
			Math.min(
				plotWidth,
				Math.max(0, Math.round(((p.timestamp - minTime) / (maxTime - minTime)) * plotWidth)),
			),
		y: yFor(p.leftPercent),
	}));

	const colY = new Int32Array(widthPx).fill(-1);
	for (let i = 0; i < coords.length - 1; i++) {
		const { x: x0, y: y0 } = coords[i];
		const { x: x1, y: y1 } = coords[i + 1];
		for (let x = x0; x <= x1; x++) {
			const frac = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
			colY[x] = Math.round(y0 + frac * (y1 - y0));
		}
	}

	// Draw smooth glow line and subtle area fill
	for (let x = 0; x < widthPx; x++) {
		const yLine = colY[x];
		if (yLine >= 0) {
			for (let y = yLine + 2; y < bottom; y++) {
				if (buffer[y * widthPx + x] === 0) buffer[y * widthPx + x] = 3;
			}
			for (let dy = -1; dy <= 1; dy++) {
				const y = yLine + dy;
				if (y >= top && y <= bottom) buffer[y * widthPx + x] = 2;
			}
		}
	}

	// Axes and tick labels are painted last so the area fill cannot cover them.
	for (let y = top; y <= bottom; y++) pixel(left, y, 4);
	for (let x = left; x <= right; x++) pixel(x, bottom, 4);
	for (let percent = 0; percent <= 100; percent += 10) {
		const y = yFor(percent);
		for (let x = left - 4; x < left; x++) pixel(x, y, 4);
		const label = `${percent}%`;
		drawText(label, left - 10 - textWidth(label), y - Math.floor((7 * fontScale) / 2));
	}
	for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
		const x = left + Math.round(fraction * plotWidth);
		for (let y = bottom; y <= bottom + 4; y++) pixel(x, y, 4);
		const [date, time] = formatShortDateTime(minTime + fraction * (maxTime - minTime)).split(" ");
		const labelX = Math.max(left, Math.min(widthPx - textWidth(date), x - Math.floor(textWidth(date) / 2)));
		drawText(date, labelX, bottom + 10);
		drawText(time, labelX, bottom + 36);
	}

	// Sixel color table:
	// #1: muted blue-gray dashed grid (RGB 32, 43, 49)
	// #2: vibrant cyan curve (RGB 22, 74, 97)
	// #3: soft dark-blue area gradient fill (RGB 5, 29, 43)
	let out = '\x1bPq"1;1;' + widthPx + ";" + heightPx;
	out += "#1;2;32;43;49";
	out += "#2;2;22;74;97";
	out += "#3;2;5;29;43";
	out += "#4;2;70;74;78"; // axes and labels

	const sixelBands = Math.ceil(heightPx / 6);
	for (let band = 0; band < sixelBands; band++) {
		const startY = band * 6;
		for (let color = 1; color <= 4; color++) {
			let runChar = 0;
			let runCount = 0;
			let planeStr = "";

			for (let x = 0; x < widthPx; x++) {
				let byte = 0;
				for (let bit = 0; bit < 6; bit++) {
					const y = startY + bit;
					if (y < heightPx && buffer[y * widthPx + x] === color) {
						byte |= 1 << bit;
					}
				}
				if (byte === runChar) {
					runCount++;
				} else {
					if (runCount > 0) {
						planeStr +=
							runCount > 3
								? `!${runCount}${String.fromCharCode(63 + runChar)}`
								: String.fromCharCode(63 + runChar).repeat(runCount);
					}
					runChar = byte;
					runCount = 1;
				}
			}
			if (runCount > 0) {
				planeStr +=
					runCount > 3
						? `!${runCount}${String.fromCharCode(63 + runChar)}`
						: String.fromCharCode(63 + runChar).repeat(runCount);
			}
			if (/[^\?]/.test(planeStr)) {
				out += `#${color}${planeStr}$`;
			}
		}
		// Advance only between bands; a trailing advance can scroll at the
		// bottom of the viewport even when the raster itself fits.
		if (band < sixelBands - 1) out += "-";
	}
	out += "\x1b\\";
	return out;
}
