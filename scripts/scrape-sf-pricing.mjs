// Scrape pricing table from https://www.siliconflow.cn/pricing (SSR HTML).
const html = await (await fetch("https://www.siliconflow.cn/pricing")).text();

// Each row: <a href=".../models?target=<encoded-id>" ...>DisplayName</a> ... followed by ¥ prices
// Sections: chat (input, output, cache) / others. We only take chat models.
const rowRe =
	/target=([A-Za-z0-9%._-]+)"[^>]*title="[^"]*">([^<]+)<\/a><\/div><div class="flex min-h-\[60px\] items-center justify-between gap-3 border-l border-\[#E1E8F2\] px-5 py-3"><span cla/g;

// Find chat section boundaries
const chatStart = html.indexOf("对话模型");
const imgStart = html.indexOf("生图模型");
const chatHtml = html.slice(chatStart, imgStart);

const results = {};
let m;
const rowRe2 = /target=([A-Za-z0-9%._-]+)"[^>]*>([^<]*)<\/a>/g;
while ((m = rowRe2.exec(chatHtml))) {
	const id = decodeURIComponent(m[1]);
	// prices follow within the rest of this row (until next target= or end)
	const rest = chatHtml.slice(m.index, m.index + 2500);
	const prices = [...rest.matchAll(/¥\s*([\d.]+)/g)].map((x) => Number(x[1]));
	if (!results[id]) results[id] = prices.slice(0, 3); // input, output, cache
}
console.log(JSON.stringify(results, null, 1));
console.error("count:", Object.keys(results).length);
