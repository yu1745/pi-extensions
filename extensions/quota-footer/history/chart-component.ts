import { getCellDimensions, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export class SixelChartEntryComponent implements Component {
	private sixel: string;
	private header: string;
	private footer: string;
	private heightPx: number;

	constructor(sixel: string, header: string, footer: string, heightPx = 160) {
		this.sixel = sixel;
		this.header = header;
		this.footer = footer;
		this.heightPx = heightPx;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = wrapTextWithAnsi(this.header, Math.max(1, width));
		// Use pi's measured cell height (or its fallback), including the final
		// six-pixel Sixel band. Recompute on render so cell-size changes take effect.
		const rowsNeeded = Math.ceil((Math.ceil(this.heightPx / 6) * 6) / getCellDimensions().heightPx);

		// pi currently recognizes image blocks through Kitty metadata. Keep this
		// quiet marker until pi supports Sixel natively. Reserved rows MUST have
		// zero visible width: spaces disable tui-main-screen's block pre-clear.
		// Let the renderer clear ALL rows before painting, never erase after it.
		// Sixel terminals differ in final cursor position; restore the origin so
		// pi alone advances through the reserved rows (as for Kitty images).
		lines.push(`\x1b7${this.sixel}\x1b8\x1b_Gq=2,r=${rowsNeeded};\x1b\\`);
		for (let i = 1; i < rowsNeeded; i++) lines.push("");
		lines.push(...wrapTextWithAnsi(this.footer, Math.max(1, width)));
		return lines;
	}
}
