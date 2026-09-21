# web_reader: Cloudflare 与懒加载的实验结论

两份调查的留档。**结论均为实测**（同一环境、同一时段内的 A/B 对照），并标注了被证伪的假设。

- 环境：Linux Mint 22.3，Playwright bundled Chromium，Jev = `api.typesafe.ai/v1/systemone`（`jev-1.13.0`）
- 相关提交：`899bd89` `9a001ab` `c0b6a63` `22a8758` `cd22206`

---

## 一、Cloudflare challenge：根因与结论

### 1.1 症状

访问 `https://linux.do/t/topic/2770639/11` 稳定返回 403 + "请稍候…"，永不通过。纯 `curl` 也拿到 403，响应头含 `cf-mitigated: challenge`。

### 1.2 根因（三组对照实验）

**结论：元凶是插件自身的指纹伪装，不是 Playwright 本身。**

在同一个能通过的 Chromium 上单独开关两个变量：

| 配置 | 结果 |
|---|---|
| 原生 UA + 不注入 stealth | **PASS** |
| **只**伪造 Windows UA | **FAIL** |
| **只**注入 stealth | **FAIL** |
| 两者都有（原插件默认） | **FAIL** |

原因是指纹自相矛盾：真实浏览器是 `Linux x86_64`，UA 却谎称 `Windows NT 10.0`；stealth 又覆盖 `navigator.plugins` / `languages` / WebGL 与原生值打架。**越伪装越像机器人。**

> 修正记录：早先曾结论"UA 伪造无用"。那次测量的 Chromium (rev 1243) 本身就被 CF 拒绝，连正常 headed 都过不了，所以该结论**推理依据是错的**。在可用的 rev 1228 上重测才有效。

### 1.3 headless 必败，headed 必需

同一 Chromium (rev 1228)，交错 2 轮：

| 模式 | UA | plugins | 结果 |
|---|---|---|---|
| headless | `HeadlessChrome/149.0.7827.55` | **0** | **0/2 FAIL** |
| headed | `Chrome/149.0.0.0` | 5 | **2/2 PASS** |

headless 在 UA 里暴露 `HeadlessChrome` 且 `navigator.plugins` 为 0，两者都是硬性特征。

**关于 Xvfb**：headed 是**必要条件**，Xvfb 只是在**没有显示服务器**的机器上实现 headed 的兜底手段（`ensureDisplay()`：`DISPLAY` 可用就直接用，否则自建私有 Xvfb）。有桌面环境的机器不会启动 Xvfb。Windows / macOS 直接跳过该逻辑（有原生合成器）。

### 1.4 决定性变量：Chromium 版本（必须锁版本）

Playwright 捆绑的是 **dev-channel "Chrome for Testing"**，版本领先于 stable，被 CF 直接拒绝。交错复现（排除时间漂移）：

| 构建 | Chrome | 结果 |
|---|---|---|
| chromium-1219 | 147 | **3/3 PASS** |
| chromium-1223 | 148 | **3/3 PASS** |
| **chromium-1228** | **149** | **3/3 PASS** ← 锁定 |
| chromium-1234 | 151 | 0/2 FAIL |
| chromium-1243 | 153 | 0/3 FAIL |

**为什么是锁版本而不是打补丁**：对比通过版与失败版的指纹，**JS 层完全一致**（canvas hash、WebGL、plugins、brands 结构、时区、并发数……），唯一差异是版本号字符串。且把 153 伪装成 147/146 **也无效**（3 种变体全 FAIL）→ 差异在 TLS/HTTP2 层，JS 补不了。

因此 `package.json` 将 `playwright` 从 `^1.62.1` 锁到精确的 **`1.61.0`**（→ chromium 1228）。**升级 Playwright 会破坏此修复**，必须重新验证。

### 1.5 点击必须在真实的 widget 上

Turnstile 挂在 **closed shadow root** 里，`page.$()` / `document.querySelector()` 都找不到。只能通过 CDP `DOM.getDocument {pierce: true}` 穿透枚举。

点击走真实鼠标轨迹（三次贝塞尔 + 微颤 + 变速缓动 + 过冲），并**三重门控**：仅当 `state === "challenge"` 且 Jev 指定了候选元素且该元素属于 `challenges.cloudflare.com` frame 时才点。第三重是关键——候选列表和 Jev 读到的文本都由页面控制，恶意页面可以把任意链接伪装成"Verify you are human"。

### 1.6 相关缺陷与修复

| 问题 | 说明 |
|---|---|
| `spawn` 异步错误导致进程崩溃 | `spawn("Xvfb")` 失败是**异步 `'error'` 事件**，`try/catch` 抓不到；无监听器 → 未捕获 ENOENT → **pi 进程直接死**。Windows（无 DISPLAY、无 Xvfb）必崩，任何未装 Xvfb 的 Linux 同样崩。 |
| Windows 弹出 node.exe 黑框 | `spawn(process.execPath, …, { detached: true })` 且无 `windowsHide`。Windows 上 `detached: true` 会请求**独立控制台并覆盖 `windowsHide`**。修复：总是设 `windowsHide`，Windows 上不用 `detached`。 |
| deadline 形同虚设 | 只在轮末检查 → 最坏超时 ~2×；且未把剩余预算传给 Jev 超时与轮间 sleep。已改为轮首检查并下发预算。 |
| Xvfb 泄漏 | 仅在 `session_shutdown` 清理；崩溃/热重载会留下守护进程与 X socket。已加 `exit` / SIGINT / SIGTERM / SIGHUP 清理。 |
| 预检网误触发 | 旧逻辑把"正文为空"当作疑似 challenge，而 `domcontentloaded` 时几乎所有 SPA 正文都为空 → 白烧 Jev 调用。已改为只认正向 CF 信号。 |
| 403 显示误导 | challenge 的 403 是**初始响应**的状态码，正文其实已渲染成功。已在 header 注明。 |

### 1.7 验证

- **CF 端到端**：`solved=true`，1~3 轮点击，约 10–14s
- **SPA 回归 7/7**，且普通页面 **Jev 调用数 = 0**（新增分支对正常浏览零影响）
- **误报边界**：CF blog / Turnstile 文档 / Cloudflare 官网三个"提及 Cloudflare"的页面均**不误判**
- 测试脚本：`tests/web-reader-cloudflare.integration.mjs`、`tests/web-reader-spa-regression.mjs`、`tests/cf-false-positive.mjs`

### 1.8 已知限制

1. **任务栏图标无法消除**：`--window-position=-32000,-32000` + `--start-minimized` 能消除弹窗抢焦点，但窗口仍存在，任务栏/Alt-Tab 照样显示。真正的无窗口方案 `--headless=new`（含修正 UA 后）**2/2 FAIL** —— "无窗口"与"过 CF"在此互斥。默认开启 offscreen（`PI_WEBREADER_VISIBLE=1` 可关闭）。
2. **点击视口外元素会静默落空**：代码不检查目标是否在视口内。Turnstile 实测在视口内，未触发。
3. **Jev 判定依据本质由页面控制**：已用 CF frame 门控大幅收窄，但属设计上的信任边界。

---

## 二、懒加载终止判定：DOM 启发式 vs Jev 语义

### 2.1 问题

是否值得加"自动下拉（懒加载）"，并且**由 Jev 判断是否翻到底**？限制条件：只针对懒加载、不针对显式分页、且必须限制轮数。

### 2.2 方法

四个策略跑同一批夹具，**共享**滚动动作、轮数上限、动作后等待窗口与每格时间预算：

| 策略 | 决策依据 |
|---|---|
| `dom` | body / 内层容器 `scrollHeight` 与文本长度连续 N 轮不变即停 |
| `domplus` | dom + 正则匹配的原地展开按钮点击 |
| `jev` | 每轮问 Jev：scroll / 点击元素索引 / end |
| `jevadaptive` | 内容仍在增长时**不问模型**（快速轮询）；停滞且等待已足够耐心后才问 Jev，并按轮退避 |

夹具以 `window.__f = {created, ended}` 公布真值；`ended` 表示该夹具能产出的内容已全部出现。

### 2.3 结果（3 轮 × 10 夹具，cap 8 轮）

原始输出：`docs/benchmarks/2026-09-22-lazy-strategy-final-run.txt`

| 策略 | 正确率 | Jev 调用 | 平均轮数 |
|---|---|---|---|
| `dom` | 18/30 (60%) | 0 | 4.5 |
| **`domplus`** | **21/30 (70%)** | 0 | 5.0 |
| `jev` | 18/30 (60%) | **126** | 4.2 |
| `jevadaptive` | 18/30 (60%) | **27** | 6.1 |

**核心发现：Jev 用于"是否到底"的判定没有优势，且并不便宜地用。** 但**轮询策略是有效的杠杆**：自适应把调用从 126 降到 27（**省 4.7×**），准确率不变。

### 2.4 三个语义夹具：Jev 全部失败

| 夹具 | 设计意图 | Jev | 正则 |
|---|---|---|---|
| `icon-expander` | 按钮无文字，仅 `aria-label="Show more comments"` | ❌ 8 轮后仍判 end | ❌ |
| `pager-is-expander` | 按钮写"下一页"但实为**原地展开**（语义陷阱） | ❌ 第 2 轮判 end | ❌ |
| `very-slow-8s` | 每次追加需 8 秒 | ❌ 2 轮后判 end | ❌ |

**已排除实现问题**：debug 确认 Jev 收到的候选为 `label: "Show more comments"`（正确可读），它仍未选择；`very-slow-8s` 是在只等 1.5s 时断言"已停止增长"。

### 2.5 结论与建议（未实施）

**不要用 Jev 做"是否到底"的判定；可以用它做"该点哪个元素"的判定。**

- **终止判据** → DOM 信号 + 硬轮数上限。它是机械事实、免费、实测更准
- **点击决策** → 这才是真正需要语义之处（区分原地展开 vs 分页跳转、识别图标按钮）

### 2.6 对结论的保留（重要）

1. **夹具对 Jev 不公平**：只给了每轮刷新的 1.5s 快照，而生产代码可提供完整 ARIA 树，信息量差距大。
2. **`very-slow-8s` 的失败是参数问题**：耐心阈值 2s < 8s，属可调，不能算判断力缺陷。
3. **正则基线有过拟合成分**：`domplus` 的 70% 建立在我照着夹具文案写的正则上。真实网页按钮文案多变、多语言、图标化，正则必然退化——**该分数不能外推到真实站点**。
4. **夹具是合成的**：`pager-is-expander` 这类"文案与行为相反"在真实站点罕见。真机验证缺位。

### 2.7 过程中被修正的错误（留档以免重蹈）

| 错误 | 影响 |
|---|---|
| 夹具写坏 4 次（不可滚动、目标不可达、缺 `},` 致夹具被覆盖、标签取错） | 其中数次**输出了看似结论的假数据**（如某策略 0/0 NaN%），发现后重跑 |
| 状态摘要只报 body 滚动 | 把内层容器滚动的页面误报为"已到底"，制造了一次**假 Jev 失败** |
| 证据窗口不等（DOM 1.5s vs Jev 0.3s） | 不公平对比，Jev 被饿死证据 |
| 并发下调用计数串台 | 126 次调用全记到一个策略上 |

### 2.8 复现方式

```bash
# 全量（约 40s；并发 8）
BENCH_TRIALS=3 BENCH_CONCURRENCY=8 node tests/lazy-strategy-bench.mjs all

# 只看某几个夹具（全量较慢）
BENCH_ONLY=icon-expander,pager-is-expander node tests/lazy-strategy-bench.mjs all
```

需要网络、Jev key（`~/.pi/agent/auth.json` 的 `typesafe-jev`）与 X 显示（可用 `xvfb-run`）。
