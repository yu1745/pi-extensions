# codebuddy-fp

CodeBuddy（腾讯）provider，出网请求对官方 CLI（`@tencent-ai/codebuddy-code`）做**全量指纹模拟**。

## 特性

- **伪装级别可开关**（`/codebuddy-fp`，默认 `off`）：
  - `on`（`full`）——**逐字节同形的首轮请求**：39 个头（顺序+大小写）、body 字段序、官方系统提示词（15.7K 字符模板化，env 块真值填充）、官方 22 个工具定义——均来自真实抓包基线
  - `off`（默认）——**完全不伪装**：不做任何提示词/工具替换，模型只会看到 pi 的一份提示词与一份工具，也不存在「首轮官方、次轮 pi」的双份历史
- **完整出网序列**：`config → accounts → chat → report → traces`，全部走 `node:https` 原始请求（保序头、HTTP/1.1、可选 CONNECT 代理）
- **遥测对齐**：report 三类事件 + 工具轮五类事件（`chat_message_response/status`、`chat_tool_action`）、OTLP traces（含官方 SDK bug 字段照抄）、真实 machineId（`/etc/machine-id`）
- **隐私红线**：`vcsRepo` 等字段恒空、config 永不带 `repos[]`——**git remote 绝不上报**；工作目录等环境信息为真值
- **token 管理**：pi 原生 `/login` OAuth 流程（provider `oauth` 接口：`login`/`refresh`/`toAuth`，pi 到期自动刷新）、便捷命令 `/codebuddy-login`、官方 CLI 明文凭证导入 `/codebuddy-import`、请求内 401 兜底重试 + 并发去重

## 伪装级别

默认 **`off`（不伪装）**。开启后是最高伪装级别，代价是首轮多烧约 25K input tokens，
且带工具任务会多 1~2 轮（首轮官方工具被否定 → 模型自适应 pi 工具）。

```
/codebuddy-fp          # 查看当前级别
/codebuddy-fp on       # 首轮完全对齐官方 CLI（full）
/codebuddy-fp off      # 完全不伪装
```

- 级别**持久化**在 `<agent-dir>/settings.json` 的 `codebuddyFingerprint` 键（`"full"` / `"off"`），
  与其他插件设置共存，写盘为临时文件 + `rename` 原子操作；切换后立即生效，无需重启。
- 环境变量 `CODEBUDDY_FINGERPRINT`（`full` / `on` / `off`）优先于设置文件；此时命令改动对外网无效，
  footer 会标注 `(env)`。
- 当前模型属于 `codebuddy` provider 时，footer 显示 `CB fp: full|off`。

## 使用

pi 原生 `/login` → 选 `codebuddy` → 二级选择：

1. **浏览器 OAuth 授权**（微信/QQ/腾讯账号，弹 URL，授权后自动继续）
2. **从官方 CodeBuddy CLI 导入**（需先 `npm i -g @tencent-ai/codebuddy-code && codebuddy /login`，读其本地明文凭证）

之后 `/models` 选 `codebuddy/deepseek-v4.1-flash`（或 `hy4-preview` / `hy3` / `kimi-k3`）。退出用原生 `/logout`。

## 思考档位（thinking level）

pi 的 `/thinking` 档位映射成出网的 `reasoning_effort`：

| pi 档位 | 出网 reasoning_effort |
|---|---|
| off | `none`（仅当官方 `canDisableThinking`；否则该档隐藏——上游根本关不掉思考） |
| low / medium / high / max | 同名档位（官方声明 `supportedEfforts` 时严格 1:1，未声明的档位不可选） |
| minimal | 官方默认档（`defaultEffort`/`effort`） |
| xhigh | `max`（模型没声明 `xhigh` 时） |

官方没声明 `supportedEfforts` 的模型（hy3 / kimi-k3-1 / glm-4.x / minimax-* 等）：
旧实现返回 undefined，pi 会把 `minimal`/`xhigh` 这类 pi 自己的档位名原样发给上游，
上游不认 → 该档位形同虚设；现在按同名档位走，minimal 落到官方默认档。

pi 没给档位时（模型关不掉思考、思考档被隐藏）用该模型的官方默认档，而不是硬编码 `high`。

**注意：档位传对了 ≠ 一定看得到思考。** 上游模型在工具轮（直接调工具）经常一个思考
token 都不产生（同一模型走 river 网关也一样），低档位本身思考也少；
另外 pi 的 `hideThinkingBlock` 为 true 时思考块默认不显示（Ctrl+T 切换）。

## 启动加载

凭证路径通过静态导入的 `getAgentDir()` 读取，复用 Pi 已加载的 SDK；不要在凭证读取函数中同步 `require("@earendil-works/pi-coding-agent")`，否则 jiti 可能重新加载整棵 SDK 依赖树，使每次启动额外阻塞数秒。模型目录仍在初始化时读取，认证和请求行为不变。

## 文件

- `index.ts` — 扩展本体
- `settings.ts` — 伪装级别的持久化读写（`<agent-dir>/settings.json`）
- `official-tools.json` — 官方 CLI 2.151.0 的 22 个工具定义（抓包提取）
- `official-system.json` — 官方系统提示词模板（`{{ENV}}`/`{{MODEL_NAME}}`/`{{MODEL_ID}}` 占位符）
- 凭证存 **pi 原生库** `~/.pi/agent/auth.json`（`codebuddy` 条目，oauth 形状 + `userId`/`domain`/`nickname` 业务字段）——与 `/login`、自动刷新等原生流程同一存储，无扩展私有凭证文件

## 环境变量

| 变量 | 说明 |
|---|---|
| `CODEBUDDY_PROXY` / `HTTPS_PROXY` | 可选出网代理（CONNECT 隧道，保持头序与 HTTP/1.1） |
| `CODEBUDDY_FINGERPRINT` | 覆盖伪装级别（`full`/`on`/`off`），优先于 settings.json |
| `CODEBUDDY_DEBUG_BODY` | 调试：把每轮出网 body 摘要追加到指定文件 |

## 积分换算（未经求证，仅供参考）

模型名后缀的倍率（如 `(x0.03)`）来自官方 `/v3/config` 的 `credits` 字段。社区对网关
`usage.credit` 字段的实测给出过如下换算，**注意：以下为网络搜索所得，未本地求证，真假不确定**：

```
积分 = (总 tokens ÷ 1000) × 模型倍率    （基准 1 credit / 1K tokens）
```

- 例：deepseek-v4.1-flash（x0.03）100M tokens ≈ 3,000 credits
- 输入/输出合并计费，不分方向；提示缓存命中价据称为 miss 的约 1/24，多轮 agent 场景实际消耗会显著更低
- 因此 cost 字段留零不做折算，倍率仅用于展示

上游最终 SSE 用量块含 `usage.credit` 时，TUI 会在对应 assistant turn 结束位置显示
`CodeBuddy · 本次消耗 N 积分`（含工具调用的轮次则位于工具结果之后）。该条目随会话持久化，
但不会发送给模型；接口未返回此字段时不做推算、不显示。重启会话或修改扩展后执行 `/reload` 生效。

## 已知上游风控陷阱（400 阻断 / 会话自毁）

腾讯网关内置了针对“第三方套壳反代给 Claude Code 官方 CLI 使用”的签名级风控拦截，是一个**只要触发就会永久报废当前会话**的死穴：

- **现象**：请求被上游直接阻断，返回 `400`（内部错误码 `code: 11128, msg: "Illegal API invocation from an unapproved channel"` / `请求被安全策略拦截`），pi 表现为 `Error: 400 status code (no body)` 且当前 session 后续所有输入持续报 400。
- **实测拦截规则矩阵**：
  - `role: "system"` 或 `role: "assistant"` 中包含该字符串：❌ **100% 阻断**
  - `role: "user"` 或 `role: "tool"` 中包含该字符串：✅ **放行**
- **自毁机制**：
  敏感签名字符串为 Claude Code 官方首句：
  ```
  You are Claude Code, Anthropic's official CLI for Claude.
  ```
  若在对话中诱导或由于分析源码导致 `assistant`（模型自己）输出了这句文本，**当前轮次能正常输出**，但由于其被持久化写入多轮历史，**在下一轮用户输入时，作为历史 assistant 消息上报，网关检测到即刻 400 拦截**，导致当前 session 彻底自毁。
- **官方现象对照**：官方 CodeBuddy CLI 在系统提示词中对该句设有极严格的拒答防线（严词拒绝复述该句或写入代码注释），正是为了防止模型自身输出该句从而炸毁后续会话。
- **应对**：开启新会话（`/new`），避免让模型在回答或上下文引用中出现该完整签名。

## 已知设计取舍

- 开启伪装（`full`）后，带工具任务多 1~2 轮（首轮官方工具被否定 → 模型自适应 pi 工具）
- 开启伪装（`full`）后，首轮多烧约 25K input tokens（官方提示词+工具定义的价格，即"长得像官方"的成本）
- 关闭伪装（`off`，默认）时，仅请求头/body 字段序/伴随遥测保持官方形状，提示词与工具是 pi 自己的
- refresh 时点、连接复用等连接层细节与官方有细微差异
