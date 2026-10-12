import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Tokenizer } from "@huggingface/tokenizers";
import {
	KIMI_SPECIAL_TOKENS,
	tiktokenModelToTokenizerJson,
} from "../extensions/shared/tiktoken-convert.ts";

/** Build a tiny tiktoken `.model`-shaped vocab (ASCII, ascending ranks). */
function syntheticVocab(): string {
	const rows: [string, number][] = [
		["a", 0],
		["b", 1],
		["c", 2],
	];
	// Multi-byte tokens must decompose greedily in rank order.
	rows.push(["ab", 3]);
	rows.push(["abc", 4]);
	rows.push(["abcab", 5]);
	return rows.map(([tok, rank]) => `${Buffer.from(tok, "utf8").toString("base64")} ${rank}`).join("\n");
}

test("tiktoken converter synthesizes reachable merges for every multi-byte token", () => {
	const json = tiktokenModelToTokenizerJson(syntheticVocab()) as {
		model: { type: string; vocab: Record<string, number>; merges: string[] };
		pre_tokenizer: { type: string };
		decoder: { type: string };
		added_tokens: { id: number; content: string; special: boolean }[];
	};

	assert.equal(json.model.type, "BPE");
	assert.equal(json.pre_tokenizer.type, "ByteLevel");
	assert.equal(json.decoder.type, "ByteLevel");

	// 3 multi-byte entries → exactly 3 merges.
	assert.equal(json.model.merges.length, 3);
	assert.equal(Object.keys(json.model.vocab).length, 6);

	// Greedy simulation: 'abcab' must split as (abc, ab).
	assert.ok(json.model.merges.includes("abc ab"), `merges: ${json.model.merges}`);

	// Kimi special tokens surface as added_tokens.
	for (const sp of KIMI_SPECIAL_TOKENS) {
		const entry = json.added_tokens.find((t) => t.id === sp.id);
		assert.ok(entry, `missing added token ${sp.content}`);
		assert.equal(entry.content, sp.content);
		assert.equal(entry.special, sp.special);
	}
});

test("converted vocab loads in @huggingface/tokenizers and roundtrips", async () => {
	const json = tiktokenModelToTokenizerJson(syntheticVocab());
	const tok = new Tokenizer(json, {});

	const sample = "abcababccab"; // chars fully covered by the toy vocab
	const ids = tok.encode(sample).ids;
	assert.ok(ids.length > 0);
	assert.equal(tok.decode(ids), sample);
});

test("cached Kimi K3 tokenizer encodes CJK/English close to tiktoken", { skip: !fs.existsSync(path.join(os.homedir(), ".pi/agent/cache/tokenizers/kimi.json")) }, () => {
	const tok = new Tokenizer(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi/agent/cache/tokenizers/kimi.json"), "utf8")), {});

	// Reference counts measured with tiktoken + the official Kimi-K3 pat_str.
	const expected: [string, number, number][] = [
		// [text, tiktoken exact, acceptable ±]
		["你好，世界！这是一个分词器速度测试，包含中英文混合内容。", 16, 1],
		["const x = await fetch(url); // fetch some data\n\treturn x.json();", 16, 1],
		["def foo(bar=None):\n    return [i*2 for i in bar if i > 10]", 21, 1],
		["🎉 emoji and unicode: café naïve 北京 {\"json\":true,\"n\":42}", 22, 1],
	];
	for (const [text, ref, tol] of expected) {
		const n = tok.encode(text).ids.length;
		assert.ok(
			Math.abs(n - ref) <= tol,
			`expected ${ref}±${tol} tokens, got ${n}: ${JSON.stringify(text)}`,
		);
	}

	// Roundtrip must be byte-exact.
	const tricky = "你好 world 🎉\n\t{\"k\": [1, 2, 3]}";
	assert.equal(tok.decode(tok.encode(tricky).ids), tricky);
});
