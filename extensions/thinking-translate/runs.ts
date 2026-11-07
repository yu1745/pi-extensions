/**
 * 从助手消息的 content 里切出「思考块 run」。
 *
 * pi 的渲染器把**连续的** thinking 块合并成一个 Markdown 组件：
 * 每块 `thinking.trim()` 之后用 "\n\n" 拼接（见 assistant-message 里的
 * markdownBlock("thinking", …)）。Markdown transformer 拿到的正是这个字符串，
 * 所以缓存的 key 必须用同样的拼法，否则永远命中不上。
 */

export interface ThinkingBlockLike {
	type?: string;
	thinking?: string;
}

/**
 * @param includeTrailing 最后一个 run 之后没有别的块时是否也算（流式中它可能还在长）
 */
export function thinkingRuns(content: readonly ThinkingBlockLike[], includeTrailing: boolean): string[] {
	const runs: string[] = [];
	let current: string[] = [];
	const flush = () => {
		if (current.length > 0) runs.push(current.join("\n\n"));
		current = [];
	};
	for (const block of content) {
		if (block?.type === "thinking") {
			const text = (block.thinking ?? "").trim();
			if (text) current.push(text);
			continue;
		}
		flush();
	}
	if (includeTrailing) flush();
	return runs;
}
