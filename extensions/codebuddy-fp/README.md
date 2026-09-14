# codebuddy-fp

CodeBuddy（腾讯）provider，出网请求对官方 CLI（`@tencent-ai/codebuddy-code`）做**全量指纹模拟**。

## 特性

- **逐字节同形的首轮请求**：39 个头（顺序+大小写）、body 字段序、官方系统提示词（15.7K 字符模板化，env 块真值填充）、官方 22 个工具定义——均来自真实抓包基线
- **第 2 轮起切换 pi 真实提示词/工具**（`read/bash/edit/write`），落在官方 `ToolSearch`/`DeferExecuteTool` 背书的"动态工具"合法空间
- **完整出网序列**：`config → accounts → chat → report → traces`，全部走 `node:https` 原始请求（保序头、HTTP/1.1、可选 CONNECT 代理）
- **遥测对齐**：report 三类事件 + 工具轮五类事件（`chat_message_response/status`、`chat_tool_action`）、OTLP traces（含官方 SDK bug 字段照抄）、真实 machineId（`/etc/machine-id`）
- **隐私红线**：`vcsRepo` 等字段恒空、config 永不带 `repos[]`——**git remote 绝不上报**；工作目录等环境信息为真值
- **token 管理**：pi 原生 `/login` OAuth 流程（provider `oauth` 接口：`login`/`refresh`/`toAuth`，pi 到期自动刷新）、便捷命令 `/codebuddy-login`、官方 CLI 明文凭证导入 `/codebuddy-import`、请求内 401 兜底重试 + 并发去重

## 使用

```sh
# 方式一：OAuth（浏览器登录）
/codebuddy-login

# 方式二：从官方 CLI 导入（先 npm i -g @tencent-ai/codebuddy-code && codebuddy /login）
/codebuddy-import
```

然后 `/models` 选 `codebuddy/deepseek-v4.1-flash`（或 `hy4-preview` / `hy3` / `kimi-k3`）。

## 文件

- `index.ts` — 扩展本体
- `official-tools.json` — 官方 CLI 2.151.0 的 22 个工具定义（抓包提取）
- `official-system.json` — 官方系统提示词模板（`{{ENV}}`/`{{MODEL_NAME}}`/`{{MODEL_ID}}` 占位符）
- 凭证存 **pi 原生库** `~/.pi/agent/auth.json`（`codebuddy` 条目，oauth 形状 + `userId`/`domain`/`nickname` 业务字段）——与 `/login`、自动刷新等原生流程同一存储，无扩展私有凭证文件

## 环境变量

| 变量 | 说明 |
|---|---|
| `CODEBUDDY_PROXY` / `HTTPS_PROXY` | 可选出网代理（CONNECT 隧道，保持头序与 HTTP/1.1） |

## 已知设计取舍

- 带工具任务多 1~2 轮（首轮官方工具被否定 → 模型自适应 pi 工具）
- 首轮多烧约 25K input tokens（官方提示词+工具定义的价格，即"长得像官方"的成本）
- refresh 时点、连接复用等连接层细节与官方有细微差异
