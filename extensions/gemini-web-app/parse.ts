/**
 * StreamGenerate wrb.fr response parsing (port of gemini-web2api-go gemini.go).
 * The stream is line-delimited; each line contains a JSON array whose [0][2] is
 * a JSON string ("inner"). Text lives at inner[4][i][1][j], reasoning at
 * inner[4][0][37][0][0]; upstream failure replies carry inner[31] = true.
 */
import type { WebModelConfig } from "./protocol.js";

export interface ParsedLine {
	texts: string[];
	reasoning: string;
	failureReply: boolean;
}

function parseInner(line: string): unknown[] | null {
	if (!line.includes('"wrb.fr"') || line.length < 200) return null;
	let arr: unknown[];
	try {
		arr = JSON.parse(line) as unknown[];
	} catch {
		return null;
	}
	const first = arr?.[0];
	if (!Array.isArray(first) || first.length < 3) return null;
	const innerStr = first[2];
	if (typeof innerStr !== "string" || innerStr.length < 50) return null;
	let inner: unknown[];
	try {
		inner = JSON.parse(innerStr) as unknown[];
	} catch {
		return null;
	}
	if (!Array.isArray(inner)) return null;
	return inner;
}

export function parseLine(line: string): ParsedLine {
	const empty: ParsedLine = { texts: [], reasoning: "", failureReply: false };
	const inner = parseInner(line);
	if (!inner || inner.length <= 4) return empty;

	const out: ParsedLine = { ...empty };

	const parts = inner[4];
	if (Array.isArray(parts)) {
		// Reasoning: inner[4][0][37][0][0]
		const p0 = parts[0];
		if (Array.isArray(p0) && p0.length > 37) {
			const lvl1 = p0[37];
			if (Array.isArray(lvl1) && lvl1.length > 0 && Array.isArray(lvl1[0])) {
				const s = lvl1[0][0];
				if (typeof s === "string") out.reasoning = s;
			}
		}
		// Candidate texts: inner[4][i][1][j]
		for (const p of parts) {
			if (!Array.isArray(p) || p.length < 2 || !Array.isArray(p[1])) continue;
			for (const t of p[1]) {
				if (typeof t === "string" && t !== "") out.texts.push(t);
			}
		}
	}

	// Failure reply bit: inner[31] truthy.
	const failBit = inner[31];
	if (failBit === true || (typeof failBit === "number" && failBit !== 0)) {
		out.failureReply = true;
	}

	return out;
}

const codeArtifactRe =
	/```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/g;
const codeMarkerRe =
	/```(python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+/g;

export function cleanGeminiText(text: string): string {
	return text.replace(codeArtifactRe, "").trim();
}

/** Strip the code-artifact fence marker, keeping the code itself (fallback path). */
export function cleanKeepCode(text: string): string {
	return text.replace(codeMarkerRe, "```$1").trim();
}

/** Server-reported model display name, e.g. "4 Argon" — used to catch silent downgrades. */
export function extractUpstreamModel(raw: string): string {
	const re = /\\"[0-9a-f]{16}\\",null,null,\\"([^"\\]{1,40})\\"/g;
	let last = "";
	for (const m of raw.matchAll(re)) last = m[1] ?? "";
	return last;
}

/** Prefix-diff accumulator: upstream sends cumulative full text per frame. */
export class DeltaTracker {
	private emitted = "";

	push(fullText: string): string {
		const cleaned = cleanGeminiText(fullText);
		if (cleaned.length <= this.emitted.length || !cleaned.startsWith(this.emitted)) return "";
		const delta = cleaned.slice(this.emitted.length);
		this.emitted = cleaned;
		return delta;
	}

	get value(): string {
		return this.emitted;
	}
}
