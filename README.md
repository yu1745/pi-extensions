# pi-extensions

Monorepo of [pi](https://github.com/earendil-works/pi) extensions, all installed from one git package:

```sh
pi install git:github.com/yu1745/pi-extensions
```

## Extensions

| Extension | Path | What it does |
|---|---|---|
| `web_reader_spa` | `extensions/web-reader-spa/` | SPA-aware, anti-WAF web reader (Playwright + stealth + ARIA extraction) |
| `quota` | `extensions/quota-footer.ts` | Unified usage monitor in the footer: DeepSeek balance, GLM / MiniMax / Codex / Command Code quota (one widget, switch-dispatched) |
| `siliconflow` | `extensions/siliconflow.ts` | SiliconFlow (硅基流动) provider with native dynamic model refresh (`refreshModels` + persisted catalog) |
| `openai-codex-fast` | `extensions/openai-codex-fast.ts` | `/fast` and `/ultrafast` toggle Codex `service_tier=priority` / `service_tier=ultrafast` |
| `context-window` | `extensions/context-window.ts` | `/context-window` sets or overrides context window for the current model |
| `append` | `extensions/append.ts` | `/append` queues user messages until the agent run stops (at `agent_end`), avoiding tool-call interruption |
| `tokenspeed` | `extensions/tokenspeed.ts` | Model output speed (tokens/sec) status line |
| `working-bell` | `extensions/working-bell.ts` | Working bell + title status |
| `codex-timer` | `extensions/codex-timer.ts` | Codex-style timers: live "Thinking Ns" footer while thinking, `─ Worked for Xm YYs ─` separator after each agent run |
| `inject-resume` | `extensions/inject-resume.ts` | Inject-resume-on-exit (pi side, Linux/bash) |
| `cny-footer` | `extensions/cny-footer.ts` | Footer with session cost in RMB, turn/step counters, and last first-token latency (TTFT) |
| `deepseek-time-pricing` | `extensions/deepseek-time-pricing.ts` | DeepSeek 分时定价：按消息时间戳重算 `usage.cost`，成本统计跟随高峰/空闲价；`/deepseek-pricing` 查看当前档位。匹配 `deepseek-flash`、`deepseek-v4[.x]-flash*` 与 `deepseek-v4[.x]-pro`（provider 必须是 `deepseek`）；`tests/deepseek-time-pricing.test.ts` 覆盖各档位与边界 |
| `deepseek-effort`（已禁用） | `extensions/deepseek-effort.ts` | 未在加载列表注册；DeepSeek V4.1 / `deepseek-flash`：`/effort` 支持 API 预设和实验性 1–100 系统前缀，两种模式明确分离，按会话分支保存 |
| `clear-new-alias` | `extensions/clear-new-alias.ts` | Clears the new-version alias notice |
| `zvec-grep` | `extensions/zvec-grep/` | MCP bridge for zvec-grep's official agent search tool; handles server startup and remote-embedding authorization internally |

<details>
<summary><strong>Shadowed</strong> (code in repo, not activated)</summary>

| Extension | Path | What it does |
|---|---|---|
| `web_reader_local` | `shadowed/web-reader-local/` | Local HTML→Markdown reader — no API key needed, Readability-inspired content extraction. See [`shadowed/README.md`](shadowed/README.md) for the re-enable steps. |

</details>

> **17 extensions, one package.** Previously separate repos (`pi-web-reader-spa`) are merged here — uninstall the standalone packages before installing this one to avoid duplicate tool registration.
> pi-smart-compact is provided separately by the fork `git:github.com/yu1745/pi-smart-compact` (upstream + `allowUnverifiedApply`).>
> The `subagent` extension was **removed** in favor of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) (install with `pi install npm:@tintinweb/pi-subagents`).

### zvec-grep configuration

The `zvec-grep` extension assumes `zg` is installed and uses the model/provider/endpoint already configured by zg (for this setup, the remote LM Studio embedding model). Those implementation details are deliberately not exposed to the LLM. It starts the local MCP server and creates the workspace grant internally. The official MCP search tool expects an existing index; run `zg index` externally before semantic search.

### DeepSeek effort

**当前已禁用**：`package.json` 的 `pi.extensions` 不包含此插件。代码和测试仅保留供参考；以下命令说明仅适用于手动重新启用之后。

需要支持 `thinking_level_select` 的 pi（本仓库以 0.84.1 验证）。适用于 `deepseek-flash`、明确的 `deepseek-v4.1-*` 模型，以及使用 `compat.thinkingFormat: "deepseek"` 的兼容 Chat Completions 端点。需要模型的 `reasoning: true`。不会仅凭名称向 OpenRouter、Anthropic Messages 等其他协议写入 DeepSeek 字段；也不推断未来 V5 等模型的协议。

```text
/effort          查看状态
/effort low      API 模式：reasoning_effort="low"（对应 50）
/effort high     API 模式：reasoning_effort="high"（对应 75）
/effort max      API 模式：reasoning_effort="max"（对应 100）
/effort 42       实验性 prompt 模式：精确写入系统前缀 42
/effort off      关闭思考（0 也可）
```

**模型的连续 effort 能力与托管 API 的参数范围是两回事。** 官方技术报告 §5.1.4 明确支持 1–100 的中间数值；同节说明公开 API 提供 low/high/max 三档。实测官方 API 拒绝整数 `reasoning_effort`（HTTP 400），但系统前缀对生成长度有影响的迹象，不能据此否定连续控制能力，也不能保证托管服务精确采用指定值。

- 数字命令使用**论文版**格式：`Reasoning Effort: 42 (range 1-100; higher values request more thorough reasoning)`，之后空一行再接原系统提示词。只在最终 provider payload 中注入，不改 Pi 的基础系统提示词。支持字符串、文本块，以及不存在系统消息的请求；重复调用会替换旧前缀，不累积。
- Prompt 模式删除 Pi 自动生成的 `reasoning_effort`，避免客户端同时提交不同数值的控制信号。**省略该参数仍意味着服务端默认 high，不能证明服务端没有额外前缀。** 页脚显示 `Effort: 42 [prompt?]`，表示已发送的数值，不是服务端确认的实际 effort。
- 命名预设使用官方 API 字段，不注入系统前缀。页脚显示 `Effort: 75 [API]`。因此 `/effort 75` 与 `/effort high` 是不同传递路径，不能宣称完全等价。
- 初始模式为 API，遵守 Pi 当前档位（包括 `off`），不会擅自把关闭思考的会话重新开启。内置档位在 API 模式映射为 minimal/low→50、medium/high/xhigh→75、max→100；在 prompt 模式保留 minimal→25、low→50、medium→60、high→75、xhigh→90、max→100。这些额外数值是插件的约定，不是官方新增预设。实际可选档位仍由模型的 `thinkingLevelMap` 决定，插件不改全局模型配置。
- 数字命令同步 Pi 的有效档位只是为了保持思考开启；即使档位被钳制或事件延迟，也保留完整数值。状态按模型保存在当前会话分支，支持 `/reload`、恢复及 `/tree`；新的会话不会继承旧会话的数值。切换模型或启动恢复时，若 Pi 的有效档位与已保存档位不同，则遵守当前 Pi 档位并重新映射；`/tree` 则恢复目标分支的已保存数值及配套档位（Pi 本身只恢复消息，不恢复该档位）。
- 其他扩展若在本扩展之后修改请求，仍可改变最终 payload；本扩展不能保证服务端实际 token 序列中的绝对位置，也不覆盖绕过 Pi 请求钩子的独立模型调用。

官方资料：[技术报告](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/DeepSeek_V41_Tech_Report.pdf) · [编码器](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/encoding/encoding.py) · [API 字段](https://api-docs.deepseek.com/api/create-chat-completion/)。注意编码器使用另一种措辞：`(range 1-100, the higher the value, the more thorough the reasoning)`，与论文并非逐字相同。

审查问题、对照实验及局限见 [docs/deepseek-effort-audit.md](docs/deepseek-effort-audit.md)。离线回归测试（无网络、无需 API key）：

```sh
node --experimental-strip-types --test tests/deepseek-effort.test.ts
```

## API keys

No keys are hardcoded. Z.AI-backed tools (`web-search`) resolve the key in this order:

1. env var (`Z_AI_MCP_API_KEY`, `Z_AI_VISION_API_KEY` …)
2. pi's configured auth for the `zai-coding-cn` provider (via `modelRegistry.getProviderAuth` — independent of the session's current provider)
3. error with a hint to run `/login zai-coding-cn`

Provider quota monitor (`quota-footer`) reads keys at runtime from `modelRegistry.getApiKeyForProvider(...)`, never from source. The old `/ds-balance`, `/glm-quota`, `/minimax-quota`, `/openai-codex-quota` commands still work as aliases of `/quota`. For `commandcode` it watches the same account endpoints as `pi-commandcode-provider`'s `/commandcode-quota` (`/alpha/billing/credits` + `/alpha/billing/subscriptions`), honoring `COMMANDCODE_API_BASE`.

## Development

```sh
npm install          # types + typebox for local typecheck
npx tsc --noEmit ... # typecheck an extension
```

Load a single extension without installing the package:

```sh
pi -e git:github.com/yu1745/pi-extensions
```
