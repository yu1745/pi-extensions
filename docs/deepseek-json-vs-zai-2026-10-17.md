# deepseek-json vs zai 检索后端对比实测（2026-10-17）

针对 `extensions/web-search/` 中两个 **JSON/REST 形态** 的后端做同批用例实测：

- `deepseek-json` — DeepSeek Search API（`POST https://api.deepseek.com/v1/tools/search`）
- `zai` — 智谱 BigModel MCP `web_search_prime`（`https://open.bigmodel.cn/api/mcp/web_search_prime/mcp`）

目标：确定两者在**跨领域召回质量**上的真实分工，并单独验证一个此前没有答案的问题——
**专搜国外内容时该选谁，以及 zai 的 `location: "us"` 到底有没有用。**

原始逐例数据见 [`benchmarks/2026-10-17-deepseek-json-vs-zai-run.txt`](benchmarks/2026-10-17-deepseek-json-vs-zai-run.txt)。

> **本文档取代 2026-10-06 报告中的 retriever 部分。** 旧报告测的是 deepseek（Anthropic 兼容、模型综合答案式）与 minimax/zai 的对比，
> 不包含本次新增的 `deepseek-json`，且旧结论"zai 相比 minimax 无任何领域优势"**不适用于本次对比的对象**。

## 方法学声明

- harness 直接 import 并调用 `deepseek-json-search.ts` / `zai-search.ts` 的导出函数，读取 `~/.pi/agent/auth.json` 取 key。
  **绕过 Pi core 的凭据解析链路**，测的是后端行为，不是真实认证路径。
- 每用例单次采样，后端间隔 1200ms（DeepSeek QPS 上限 5/账号）。
- 17 个跨领域用例 × 2 后端 = 34 次调用；5 个国外专项 × 3 配置（ds-json / zai / zai+location:us）= 15 次调用。
- 指标均为**代理指标**：域名命中 ≠ 内容支持论点；正文长度 ≠ 正确性。未做事实正确性人工核验。
- 单次采样无方差估计，只有"逐用例轴胜负一致"的差异才下结论。

## 规模

| 项 | 数量 |
|---|---|
| 领域 | 技术文档 / 中文排障 / 学术 / 金融数据 / 新闻 / 中文政策 / 国外政策·监管·社媒 |
| 跨领域用例 | 17（C1–C17） |
| 国外专项用例 | 5（F1–F5） |
| 后端配置 | 3（ds-json、zai 默认、zai `location:us`） |
| 实际调用 | 49 |
| 失败 | 0（ds-json 一次空结果为 HTTP 200，非失败） |

## 总体结果（英文 + 国外用例，n=19）

| 轴 | deepseek-json | zai（默认） | zai `location:us` |
|---|---|---|---|
| 非空返回 | 18/19 | **19/19** | 5/5 |
| 延迟 p50 / max | **508ms** / 1.15s | 1687ms / 2.96s | 4923ms / 8.47s |
| 输出体积 p50 | **25.5k 字符** | 2.9k 字符 | 2.8k 字符 |
| 单条正文 p50 | **2300 字符** | 158 字符 | 144 字符 |
| 去重域名 p50 | **9** | 7 | 7 |
| 命中预设权威域 | 8/18 | **18/20** | 6/7 |
| 关键词命中 | 18/18 | 18/19 | 5/5 |
| gov 域总数 | 4 | **12** | 3 |
| 中国站占比（均值） | 0.09 | **0.01** | 0 |

## 主判据：逐用例轴胜负

n=1/用例，中位数会掩盖分歧，因此主判据是**每用例逐轴两两对比**（覆盖、预期域命中、关键词命中、gov 域数、去重域名数、正文厚度、低中国站污染）。

**用例级比分：8 : 8 : 6**

| 结果 | 用例数 | 用例 |
|---|---|---|
| zai 赢 | 8 | C2 C4 C5 C10 C12 F1 F2 F4 |
| deepseek-json 赢 | 8 | C7 C8 C9 C13 C14 C15 C17 F5 |
| 平局 | 6 | C1 C3 C6 C11 C16 F3 |

**轴级比分（22 个两两用例，不含成本轴）：41 : 39**

| 轴 | deepseek-json | zai | 平 |
|---|---|---|---|
| 覆盖（非空） | 0 | 1 | 21 |
| **预期域命中** | 0 | **11** | 11 |
| 关键词命中 | 0 | 0 | 22 |
| gov 域数 | 5 | **8** | 9 |
| **去重域名数** | **14** | 6 | 2 |
| **正文厚度** | **21** | 1 | 0 |
| **低中国站污染** | 1 | **12** | 9 |
| 延迟（成本轴） | **22** | 0 | 0 |

质量轴 41 : 39 —— **总体打平**。任何"某一方全面更好"的说法都是把单轴差距当成总体结论。

## 可以下的结论（4 条）

### 1. 需要官方一手来源 → zai，差距 11:0（最强单轴）

| 用例 | 期望域 | ds-json 实际给到 | zai 实际给到 |
|---|---|---|---|
| F1 EU AI Act 罚则 | `europa.eu` | dastra.eu、orrick.com、compyl.com | **ai-act-service-desk.ec.europa.eu** |
| F2 FDA 新药 | `fda.gov` | practicalneurology.com、ajmc.com、pharmexec.com | **fda.gov**、prnewswire.com |
| F3 UK HMRC | `gov.uk` | litrg.org.uk、icaew.com、tinytax.co.uk | **gov.uk**、xero.com |
| C12 诺贝尔物理 | `nobelprize.org` | aps.org、yna.co.kr、sina、163 | **nobelprize.org**、reuters.com |
| C10 FOMC 声明 | `federalreserve.gov` | fa-mag.com、finance.sina.com.cn、eastmoney | **federalreserve.gov** |
| C3 Kubernetes | `kubernetes.io` | 命中 | 命中（10 个去重域） |
| C15–C17 中文政策 | `gov.cn` 系 | 命中，且 gov 域更多（6/1/7） | 命中（4/3/1） |

逐例 11:0 且差异是"官方站 vs 行业二手站"，不是噪声。**这是唯一达到压倒性阈值的结论。**

### 2. 需要直接读正文 → deepseek-json，差距 21:1

zai 每条 `content` 硬截断在 100–170 字符且断在句中（`... Read more`），本质是"点进去之前的预览"。
ds-json 每条 `summary` 600–800 字符完整成段，`need_content: true` 可取整页（实测 5 条 = 41k 字符）。
配合 3 倍延迟优势（508ms vs 1687ms），**"搜到并读懂"这个场景 ds-json 明显更省一次 web_reader 往返**。

典型对照（F5 日银决议）：

- ds-json 给出 `nikkei.com` 完整报道段落 + 腾讯/新浪中文述评；zai 给 `boj.or.jp` 原始公告标题 + 93 字符摘要。
- 结论：**要知道"官方说了什么原文"，zai；要知道"这件事的来龙去脉"，ds-json。**

### 3. 中文查询污染 → zai 干净，但中文政策 → ds-json 更厚

- 英文/日文查询下，ds-json 仍混入 10–30% 中文聚合站（F5 达 0.30，C11 达 0.20）；zai 默认近 0（cnShare 0.01）。
- 但**中文政策反过来**：C15 购置税 ds-json gov 域 6（`12366.chinatax.gov.cn`、`fgk.mof.gov.cn`）vs zai 4；
  C17 以旧换新 ds-json 7 vs zai 1。C16 医保目录 zai 3 vs ds-json 1（zai 直达 `nhsa.gov.cn`）。
- 中文政策合计 **2:1 略偏 ds-json**，且 ds-json 正文厚度让"直接读条文"成为可能。

### 4. 专搜国外 → 必须用 zai，`location:us` 只在目标是 GFW 站点时才值得

**GFW 站点可达性（`site:<host> latest news`，各请求 10 条）**

| host | deepseek-json | zai |
|---|---|---|
| x.com | **0** | 10 |
| youtube.com | **0** | 10 |
| reddit.com | **0** | 7 |
| medium.com | **0** | 10 |
| quora.com | **0** | 10 |
| linkedin.com | 2 | 10 |
| instagram.com | 5 | 2 |
| google.com / pypi.org / techcrunch / reuters / bloomberg / wsj / nytimes | 10 | 8–10 |

deepseek-json 的爬虫在境内，**无法取 GFW 站点，且失败方式是静默返回空数组（HTTP 200、无报错、不计费）**。
这是结构性缺陷，也是本次最危险的失效模式：模型会把"墙导致的 0 结果"读成"Reddit/YouTube 上没人讨论"。

**`location: "us"` 的真实收益（F1–F5）**

| 用例 | zai 默认 | zai `location:us` | 判断 |
|---|---|---|---|
| F1 EU AI Act | 1.9s，命中 ec.europa.eu | 3.6s，域名集完全相同 | 无用，纯变慢 |
| F2 FDA | 1.9s，命中 fda.gov | 8.5s，同集合 + facebook | 无用 |
| F3 UK HMRC | 1.5s，命中 gov.uk | 2.0s，同集合 | 无用 |
| **F4 `site:x.com`** | 1.5s，返回 treasury.gov/sec.gov/merriam-webster 等垃圾 | 4.9s，**10 条全是 x.com** | **唯一有效场景** |
| F5 日银 | 2.2s，全日本本土站 | 6.2s，同上（换了几家券商） | 无用 |

外加两个反直觉点：

- 非 GFW 查询加 `location:us` 后，延迟从 p50 1.7s 涨到 4.9s，**域名集合几乎不变**。
- 它会让结果**更单一**：F4 的 10 条全部来自 x.com，多样性反而下降。

**所以"专门搜国外"的正确姿势不是换后端，而是：**

1. 主体用 **zai**，查询里直接写 `site:`（这是唯一能覆盖 X/Reddit/YouTube/Medium/Quora 的路径）；
2. 仅当目标本身是被墙站点时追加 `location: "us"`（并接受 5–8s）；
3. **不要让 deepseek-json 单独承担国外检索**——它的空结果会伪装成"不存在"；
4. 想减少中文聚合站污染，zai 默认档已天然做到（cnShare 0.01 vs 0.09），不需要额外过滤参数。

## 实现缺陷（实测确认，非推测）

三处是本次顺带查出的**代码/契约问题**，与选型无关但会影响使用体验：

**1. `zai-search.ts` 的 `search_domain_filter` 与 `content_size` 完全无效**

MCP `tools/list` 声明了 5 个参数，但：

- `domain_filter: "arxiv.org"` 查 postgres 主题 → 返回 `postgresql.org, bytebase.com, pgpedia.info, medium.com`，
  与**不加 filter 的结果完全一致**，命中率 0.00。服务端接收了参数但未生效。
- `content_size: high` vs `medium` → 正文长度 155 vs 155 字符，**完全一致**。
  服务端对所有结果统一截断到 ~100–170 字符，该参数在当前 MCP 版本下无意义。

→ `index.ts` 里 zai 的 tool schema 仍在对外宣传这两个参数（"Result snippet detail level"、"Target domain filter"），
**属于误导性 prompt**。可行修法：从 schema 移除，或在 description 注明"当前服务端未生效"。

**2. `zai-search.ts` 的 `formatSearchResults` 未能生效，实际输出原始 JSON**

`zaiSearch()` 的 `parseSSE()` 已把内层文本 `JSON.parse` 成数组，理论上应走
`Array.isArray(result.data)` → `formatSearchResults(...)`，但实测输出仍是
`[{"title":"...","link":"...","content":"...","refer":"ref_1"},...]` 的转义 JSON 字符串，
模型每轮要多消化一层转义。需按实际返回形态（`result.data` 到底解到哪一层）补归一化到 `{title,url,snippet}` 再渲染。

**3. `deepseek-json-search.ts` 的 `count > ~16` 会在渲染层被静默截断**

`MAX_OUTPUT_CHARS = 50_000`，`count: 25` 时 `count` 字段报 25、`chars=50035`、**文本实际只渲染 16 条**，
末尾附 `[Output truncated at 50000 chars]`。若模型按 `count` 假设拿到 25 条会漏读 9 条。
建议渲染时按剩余预算提前停止并显式写 "N of M due to output cap"。

## 选型建议

| 场景 | 推荐 | 理由 |
|---|---|---|
| 默认档 | **deepseek-json** | 延迟 1/3、正文厚度 ~15×、带 rerank/authority/date、语法完整（`site:` / `-site:` / `lang:` / `after:` / 双引号精确短语） |
| 政策·法规·监管·学术原文 | **zai** | 官方一手站命中 11:0，唯一压倒性差距 |
| 中文政策条文 | **deepseek-json**（备选 zai） | gov 域 6/1/7 vs 4/3/1，正文可直读 |
| 海外社媒 / UGC / GFW 内容 | **zai**（目标被封时加 `location:us`） | ds-json 结构性 0 结果 |
| 需要整页正文 | **deepseek-json** + `need_content: true` | zai 无此能力，正文硬截断 |

## 若要据此改造（本次未改动任何代码）

- **补齐 zai 的 schema 真实性**：移除或标注 `domain_filter` / `content_size`，避免继续误导模型。
- **修 zai 渲染**：归一化为 `{title,url,snippet}` 再输出，顺手带上 `refer`。
- **修 ds-json 截断**：`count` 与实际渲染条数保持一致，或显式声明截断。
- **空结果语义**：ds-json 返回 0 条时应主动提示"可能是境内爬虫无法访问该域名，建议改用 zai"，
  否则模型无法区分"真的没有"和"被墙"。
- **不要做多后端聚合**：本次数据支持"按场景路由"而非"并发合并"——两者返回形态不同构
  （ds-json 结构化 + 打分，zai 裸 JSON），且 zai 的正文短到无法与 ds-json 的 summary 等价合并。
