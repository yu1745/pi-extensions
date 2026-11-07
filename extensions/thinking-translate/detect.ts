/**
 * 判断一段思考内容「有多英文」。
 *
 * 只看自然语言部分：代码块、行内代码、URL、文件路径里的拉丁字符全是噪声
 * （一段全中文的思考里夹一坨代码，按字符统计会被误判成英文），所以先剥掉
 * 这些再统计。
 */

const INLINE_CODE = /`[^`\n]*`/g;
const URL = /\b(?:https?|ftp|file):\/\/[^\s<>()"']+/g;
/** `foo/bar/baz.ts`、`./a/b`、`~/x/y` —— 至少两级、中间带 / */
const PATH = /(?:^|[\s(（"'`])[~.\w$@-]*(?:\/[\w.@$-]+){2,}\/?/g;

export interface EnglishStats {
	/** 拉丁字母个数 */
	latin: number;
	/** 汉字个数 */
	han: number;
	/** 拉丁字母 / (拉丁字母 + 汉字)，0 表示没有可判定的字母 */
	latinShare: number;
}

/**
 * 去掉不该参与「英文占比」统计的部分，返回剩下的自然语言文本。
 * 行扫描而不是一条大正则：围栏代码块要成对匹配，正则回溯容易出错。
 */
export function stripVerbatim(markdown: string): string {
	const kept: string[] = [];
	let fence: string | undefined;
	for (const line of markdown.split("\n")) {
		const opener = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence) {
			// 只有同种围栏、长度不短于开启者才算关闭
			if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length) fence = undefined;
			continue;
		}
		if (opener) {
			fence = opener[1];
			continue;
		}
		kept.push(line.replace(INLINE_CODE, " ").replace(URL, " ").replace(PATH, " "));
	}
	return kept.join("\n");
}

export function englishStats(text: string): EnglishStats {
	const natural = stripVerbatim(text);
	const latin = natural.match(/[A-Za-z]/g)?.length ?? 0;
	const han = natural.match(/\p{Script=Han}/gu)?.length ?? 0;
	const letters = latin + han;
	return { latin, han, latinShare: letters === 0 ? 0 : latin / letters };
}

export interface TranslateDecision {
	translate: boolean;
	stats: EnglishStats;
	/** 判定理由，用于 /thinking-translate status */
	reason: "english" | "too-short" | "already-chinese" | "empty";
}

/**
 * 是否值得翻译：拉丁字母够多（避免把 "OK" 也送去翻译），且占全部字母的比例
 * 达到阈值（默认 0.5，即英文字母比汉字多）。
 */
export function decideTranslate(
	text: string,
	options: { ratio: number; minLatin: number },
): TranslateDecision {
	const stats = englishStats(text);
	if (stats.latin === 0 && stats.han === 0) return { translate: false, stats, reason: "empty" };
	// 一个拉丁字母都没有：已经是中文，不该报成「太短」
	if (stats.latin === 0) return { translate: false, stats, reason: "already-chinese" };
	if (stats.latin < options.minLatin) return { translate: false, stats, reason: "too-short" };
	if (stats.latinShare < options.ratio) return { translate: false, stats, reason: "already-chinese" };
	return { translate: true, stats, reason: "english" };
}

/**
 * 把超长文本按段落切成不超过 maxChars 的块（单段超长时硬切）。
 * 分块翻译能避免长思考被模型截断或整段质量下滑。
 */
export function chunkMarkdown(text: string, maxChars: number): string[] {
	if (maxChars <= 0 || text.length <= maxChars) return [text];
	const chunks: string[] = [];
	let current = "";
	for (const paragraph of text.split(/\n{2,}/)) {
		const block = current ? `\n\n${paragraph}` : paragraph;
		if (current && current.length + block.length > maxChars) {
			chunks.push(current);
			current = paragraph;
			continue;
		}
		if (paragraph.length > maxChars && !current) {
			for (let i = 0; i < paragraph.length; i += maxChars) chunks.push(paragraph.slice(i, i + maxChars));
			current = "";
			continue;
		}
		current += block;
	}
	if (current.trim()) chunks.push(current);
	return chunks.length > 0 ? chunks : [text];
}
