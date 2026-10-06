# web-search 后端对比实测报告（2026-10-06）

对 `extensions/web-search/` 的五个后端做跨领域实测，目标是回答两个问题：
一次搜索能否同时调用多个后端再聚合，以及结果是否更好。

**本报告只在下述条件下成立：harness 直接读取 `~/.pi/agent/auth.json`，绕过 Pi core 的凭据解析链路。**
因此测的是各后端的**相对表现**，不是真实认证路径下的行为。真实会话里 OAuth 令牌由 Pi 的
`resolveStoredOAuth()` 自动续期（`@earendil-works/pi-ai` 的 `auth/resolve.js`，剩余有效期不足 5 分钟即加锁刷新并落盘），
本 harness 不具备该行为。

原始逐例数据见 [`benchmarks/2026-10-06-web-search-backend-run.txt`](benchmarks/2026-10-06-web-search-backend-run.txt)。

## 规模

- 8 个领域 × 4 个用例 = 32 个用例，覆盖技术文档/技术排障/长尾事实/学术/法律合规/医疗健康/政务政策/数值时序
- synthesizer 阶段：deepseek、google、openai，共 **96 次真实调用**
- retriever 阶段：minimax、zai，共 **64 次真实调用**
- 每次回答额外做 URL 可达性校验（HEAD，8s 超时）

### 架构前提：当前实现是五选一，不是聚合

`extensions/web-search/index.ts` 是 `switch (currentBackend)`，**只注册一个** `web_search` 工具；
`backend-config.ts` 的 `WebSearchBackend` 是单值枚举，持久化在 `settings.json`。
所以"一次搜索同时调用所有后端"目前**在架构上不存在**，需要新增后端与归一化层才能实现。

五个后端的返回体并不同构，这是聚合的直接障碍：

| 后端 | 返回形态 |
|---|---|
| google | 散文 + 结构化 `sources[]`（最好归一化） |
| openai | 带引用的散文，`Sources` 块里 URL 重复出现 |
| deepseek | 带 citations 的散文，`Sources` 块格式干净 |
| minimax | `[n] title / url / snippet` 文本列表 |
| zai | **原始 JSON 数组**（`title`/`link`/`content`） |

去重只能按 URL 字符串，所以必须先把每个后端压成 `{title, url, snippet}`。

## 总体结果

**Synthesizer**

| 后端 | 成功 | 延迟 p50 | p25–p75 | avg | max | 正文 p50 | 权威域/例 | URL 存活 |
|---|---|---|---|---|---|---|---|---|
| deepseek | 32/32 | **5.7s** | 4.5–6.5 | 5.6s | 12.7s | 543 tok | 1.8 | 90% |
| google | 30/32 | 7.5s | 6.2–10.2 | 8.0s | 14.4s | 551 tok | 1.1 | 93% |
| openai | 32/32 | **39.3s** | 20.1–54.1 | 36.8s | **78.6s** | 712 tok | **4.2** | 94% |

google 的 2 次失败均为 `400: User location is not supported`（geo-block），非实现缺陷。

**Retriever**

| 后端 | 成功 | 延迟 p50 | 结果数 p50 | 去重域名 p50 | 权威域总数 | 含权威域用例 |
|---|---|---|---|---|---|---|
| minimax | 32/32 | **640ms** | 10 | 9 | **69** | 22/32 |
| zai | 32/32 | 1900ms | 8 | 7 | 24 | 15/32 |

**延迟是最确定的结论**：deepseek 在 32 个用例里 28 次最快（88%），中位比 openai 快 6.9 倍。
openai 的耗时与 query 复杂度强相关——`policy-zh` 类普遍 60–78s，`numeric` 类仅 16–22s。

## 判据

n=4/领域时中位数容易误导，因此主判据是**逐用例胜率**：某后端必须在同一用例上严格最优，
且计数 ≥75% 才算"领先一个轴"。同时：

- 至少 **2 个质量轴**达标才下结论，延迟单列为成本轴，不参与质量胜负
- 计数类轴加**绝对噪声地板**（如权威域需绝对差 ≥2），避免把 1.0 vs 1.25 判成领先
- 前后端调用间隔 2000ms（≤0.5 req/s），URL 校验并发上限 4，429 退避 30s

## 可以下的结论（3 个领域）

### 1. 中文政务政策 → openai 明显更好

| 轴 | deepseek | google | openai | 逐例胜率 |
|---|---|---|---|---|
| 权威引用数 | 5.00 | 2.25 | **17.75** | openai **4/4** |
| 正文厚度 | 323 | 373 | **777** | openai **4/4** |
| 免责标注率 | 0 | 0 | **0.5** | openai 2/4 |

抽查 D28（生育津贴）：openai 引用 `nhsa.gov.cn` 国家医保局原始公告，并在开头声明"生育津贴不是全国统一金额"；
deepseek 仅 1 个权威域。代价是 70.2s vs 3.7s。

### 2. 法律合规 → openai 明显更好

| 轴 | deepseek | google | openai | 逐例胜率 |
|---|---|---|---|---|
| 权威引用数 | 0.75 | 0.75 | **5.75** | openai **4/4**（7.7 倍） |
| 正文厚度 | 480 | 551 | **850** | openai 3/4 |

retriever 侧佐证：minimax 在该领域命中 `cac.gov.cn`（网信办）、`npc.gov.cn`（全国人大）等 12 个权威域名，
关键事实断言（EU AI Act 罚款 1500 万欧元 / 3%）**minimax 3/3 全中，zai 0/3**。

### 3. 数值时序 → deepseek 明显更好，且更快

| 轴 | deepseek | google | openai | 逐例胜率 |
|---|---|---|---|---|
| 数值密度 | **26** | 14 | 7 | deepseek **4/4** |
| 正文厚度 | **318** | 211 | 170 | deepseek 3/4 |
| 延迟 | **4.7s** | 5.4s | 20.9s | deepseek 3/4 |

这是唯一一个质量与成本双赢的领域。

### 跨领域：minimax 是被低估的廉价召回器

0.64s、32/32 成功、权威域总数 69（zai 仅 24）。分领域权威域名总数：

| 领域 | minimax | zai |
|---|---|---|
| tech-doc-en | 4 | 3 |
| niche-fact-en | **9** | 4 |
| legal | **12** | 3 |
| health | **8** | 2 |
| policy-zh | **31** | 10 |
| debug-zh / academic / numeric | 1 / 2 / 2 | 0 / 1 / 1 |

minimax 不产出总结，但作为"补充候选源"性价比显著高于 zai：延迟低 3 倍、权威覆盖约 3 倍。

## 明确不下结论的领域（5 个）

| 领域 | 原因 |
|---|---|
| **health（高风险）** | 信号互相矛盾：openai 正文 3/4、权威 2/4；deepseek 数值密度 3/4 但权威仅 1.5/4。医疗域无任何一家明显更好 |
| tech-doc-en | openai 仅"正文厚度"单轴 3/4，权威引用 2/4 未达阈值 |
| debug-zh | 同上，权威引用 2.5/4 |
| niche-fact-en | deepseek 仅正文厚度单轴 3/4 + 更快，权威引用三家都在 1–2 个，属噪声 |
| academic | 纯粹权衡：openai 正文厚度 4/4 vs deepseek 延迟 4/4，权威 2/4 |

## 两个负面确认

**google**：在全部 8 个领域、5 个轴上**没有任何一次达到压倒性阈值**（数值密度 0/32、正文厚度 3/32、
权威引用 0.5/32），唯一优势是 URL 存活（8/32），且 32 次里有 2 次 geo-block 硬失败。
注意这不等于"google 更差"，而是**没有证据支持选它**。

**zai**：相比 minimax 无任何领域优势，延迟高 3 倍、权威覆盖仅 1/3。

## 聚合的可行性判断

曾评估"拿到 sources 就提前 abort 流"以省掉答案生成时间。实测**不可行**：
提前 abort 确实能把 14s 压到 3.7–8.9s（sources 数不变，13 = 13），但丢掉的是不可替代的结论。
例如票房用例，openai 给出的排名表含精确数字、时间戳与数据来源声明；排障用例给出的诊断步骤与
具体 release note 引用——这类内容无法从 title/snippet 列表拼出。

真正的浪费在别处：**openai 输出的 51–93% 是 `Sources` 块**，且同一 URL 出现两次
（citation 格式 + `title — url` 格式），URL 重复计数 24–48 个。deepseek/google 该项为 0–2。
去重可省 38–63% token，零信息损失、零延迟代价。但这只对 openai 有意义，
而把 openai 移出默认档即可绕过该缺陷，无需改代码。

## 可靠性正面信号

D31（2026 年 9 月 CPI）当天数据尚未发布，是个**不可答用例**。三家全部正确回答"数据未公布"，
无一编造。deepseek 额外给出 8 月实际值与 5 家机构预测；openai 引 `stats.gov.cn` 给出预计发布日 10 月 14 日。

## 方法学限制

1. **n=4/领域**，置信区间宽。只有"逐例 4/4 一致 + 大幅差"的三条计入确认结论。
2. **指标是代理指标**：正文长度 ≠ 正确性；权威域名 ≠ 引用内容支持论点；URL 存活只测可达，不测是否被正确引用。
3. **高风险领域未做事实正确性验证**：仅 3 个关键词断言（D17/D25/D29），均命中。
4. **单次采样**，未重复测方差，无法区分后端差异与采样噪声。
5. **retriever 只测了召回本身**，没测"召回结果喂给 synthesizer 后是否改善最终答案"——
   而这才是评判召回器的正确方式。
6. harness 绕过 Pi core（见开头声明），且实测中刷新的 antigravity OAuth 令牌已写回 `~/.pi/agent/auth.json`。

## 若要据此改造（本次未改动任何代码）

- 需要新增 `normalize.ts`（各后端 → `{title,url,snippet}` 适配）与 `multi-search.ts`
  （`Promise.allSettled` 并发，任一失败不影响其他——google 的 geo-block 已证明不能用 `Promise.all`），
  再在 `index.ts` 加 `case "multi"`、`backend-config.ts` 加枚举值与菜单项。
- zai 的 `location`/`recency`/`domain_filter` 只对 zai 转发，其余后端忽略，schema 需写明。
- 已确认可路由：数值时序 → deepseek；政务政策/法律合规 → 并发 openai 并接受 60–80s。
- **未定领域保持现状不路由**：没有证据就不动。
