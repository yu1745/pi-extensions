# DeepSeek effort 插件审查与 API 对照实验

## 原实现中的确定问题

1. **数值被自身事件覆盖。** `/effort 42` 先设置 `state.effort=42`，再调用 `pi.setThinkingLevel("low")`；`thinking_level_select` 将其覆盖成 50。通知仍声称设置为 42。用事件 mock 已复现实际请求前缀为 50。模型配置将 minimal/medium 钳制到受支持档位时同样会发生。
2. **未识别当前官方 model ID。** `^deepseek-v4\.[1-9]` 不匹配 `deepseek-flash`，却可误匹配 `deepseek-v4.1garbage`。
3. **全局状态不属于会话。** `globalThis` 导致同进程实例共享设置；没有会话分支持久化，进程重启丢失，无法正确恢复 `/tree` 的历史状态。
4. **默认强制开启。** 不读取 Pi 初始 thinking level，默认 75 并在请求中设置 enabled；即使 Pi 是 off 也可能被重新开启。
5. **输入验证宽松。** `parseInt("50abc", 10)` 和 `parseInt("2.5", 10)` 都会被接受；使用 `in` 检查普通对象还会把继承属性当预设。
6. **请求可能带有陈旧/冲突的控制。** 先按回合修改系统提示词，再在每次请求只检查是否以 `Reasoning Effort:` 开头，不会更新已有数值；切换 off 不清理旧前缀。Pi 生成的离散 `reasoning_effort` 仍被保留。
7. **协议和内容形态假设过宽。** 只检查模型 ID，不检查 API 类型；只支持第一个消息是字符串 system/developer，不处理文本块和缺失 system。原注释还宣称有 `/think` 别名，实际未注册。

## 官方资料能证明什么

[技术报告 §5.1.4](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/DeepSeek_V41_Tech_Report.pdf) 说明在系统提示词前加入：

```text
Reasoning Effort: {effort} (range 1-100; higher values request more thorough reasoning)
```

模型支持 1–100 的中间数值。该节同时说明生产 API 提供 low/high/max，对应 50/75/100。

[官方 encoding.py](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/encoding/encoding.py) 接受整数或三种预设，并使用略有不同的字符串：

```text
Reasoning Effort: {budget} (range 1-100, the higher the value, the more thorough the reasoning)
```

两种字符串都来自官方，不能把措辞差异说成原实现凭空编造。编码器显示前缀放在原系统内容之前，但它并不能证明托管服务的实际内部拼接方式。

[Chat Completions API 文档](https://api-docs.deepseek.com/api/create-chat-completion/) 公开 `reasoning_effort` 为字符串 none/low/high/max，默认 high。**API 不接受整数不等于模型不支持连续 effort，也不等于系统前缀无效。**

## 实测设计

测试日期：2026-09-10（UTC）。

- 官方端点：`https://api.deepseek.com/chat/completions`。
- 模型：`deepseek-flash`；所有成功响应的 model 字段同名。
- 独立测试题，不包含用户会话/文件内容。
- 所有实验设置 `thinking: {"type":"enabled"}`，非流式响应。
- 不设置 temperature/seed；官方文档说明 thinking 模式忽略 temperature，不能靠 temperature=0 假装确定性实验。
- 前缀置于下面固定 system 内容之前，间隔两个换行。

System：

```text
You are a precise mathematical assistant.
```

User：

```text
How many integers n with 1 <= n <= 1000000 have n^2+n+1 divisible by 91? Give the exact count and a short justification.
```

正确答案为 43,956，另用 Python 枚举 1..1,000,000 验证。

### 第一轮：协议探测

9 次请求，`max_tokens=1536`。整数 API 参数 `1` 与 `100` 均返回 HTTP 400：

```text
Failed to parse the request body as JSON: reasoning_effort: expected value ...
```

其余 7 次成功，但 6 次 `finish_reason="length"`。这轮数据不能用于直接比较完整推理长度，因此补测时增加输出上限。

### 第二轮：重复比较

9 组 × 3 次，共 27 次请求。`max_tokens=8192`，并发上限 3，重复轮之间轮转组顺序；不是随机化试验。各组除指定的前缀/参数外条件相同。所有响应均 HTTP 200、`finish_reason="stop"`，最终答案均包含正确计数，没有任何响应触及上限。

使用 API 返回的 `usage.completion_tokens_details.reasoning_tokens`，不是字符数估算。下表包含每个样本，均值按整数四舍五入；耗时为非流式端到端时间，不是首 token 延迟。

| 组别 | 系统前缀 | API reasoning_effort | 三次思考 tokens | 平均思考 tokens | 平均耗时（秒） |
|---|---|---|---|---:|---:|
| 默认 | 无 | 省略（默认 high） | 2485 / 1960 / 2245 | 2230 | 10.10 |
| 论文 1 | 论文版，1 | 省略 | 1073 / 927 / 1083 | 1028 | 5.34 |
| 论文 100 | 论文版，100 | 省略 | 984 / 2067 / 2360 | 1804 | 8.25 |
| API low | 无 | low | 945 / 686 / 1876 | 1169 | 6.58 |
| API max | 无 | max | 2524 / 1658 / 1316 | 1833 | 8.64 |
| 冲突：论文 1 + max | 论文版，1 | max | 940 / 1466 / 978 | 1128 | 5.83 |
| 冲突：论文 100 + low | 论文版，100 | low | 1057 / 2011 / 985 | 1351 | 6.57 |
| 编码器 1 | 编码器版，1 | 省略 | 1886 / 1695 / 1158 | 1580 | 7.62 |
| 编码器 100 | 编码器版，100 | 省略 | 1630 / 1290 / 1167 | 1362 | 6.68 |

第二轮总计输入 2,346 tokens、输出 47,179 tokens，其中思考 40,452 tokens。不包含第一轮探测，未记录或保存凭据。

## 合理结论与边界

- **确定**：此时官方 API 拒绝整数 `reasoning_effort`；字符串档位以及两种系统前缀均可提交。
- **初步观察**：本题论文版 effort=1 比 effort=100 平均推理更短；API low 也比 max 平均更短。系统前缀=1 同时叠加 API max 时仍较短，说明不能先验认定系统前缀必然无效。
- **不能下的结论**：这不足以证明系统前缀总是覆盖 API 参数，更不能证明全部 1–100 值都在托管 API 中精确、单调地生效。编码器措辞的 1/100 对照甚至未呈现相同方向。默认组比 API max 组更长，同样提示小样本随机波动不可忽略。
- **未测试**：中间值校准、多个任务的统计显著性、复杂 agent/tool 多轮任务，以及服务端真实的内部 prompt。测试题相对简单、每组仅 3 次、全部答对，不能评价质量—成本曲线。
- **省略 API 参数不代表去掉服务端默认控制**：服务端仍默认 high。客户端可以消除自己提交的重复信号，不能据此断言完全掌控服务端序列。

## 实现取舍

保留 `/effort 1..100` 为显式实验性模式，继续使用论文措辞；用命名 `/effort low|high|max|off` 选择官方 API 路径。默认遵守 Pi 当前 thinking level 并使用 API 模式。数值模式只注入最终 provider payload，并删除客户端离散字段；模式/数值/有效 Pi 档位共同存入会话分支，避免误把宿主档位钳制当成用户要量化数值。

页脚 `[prompt?]` 表示客户端发送了该值，不是托管服务确认的实际 effort；`[API]` 表示走官方预设。模型的未来版本、其他网关协议与后续扩展改写不作自动兼容承诺。

最终验证：20 项离线回归测试通过，插件及测试的严格 TypeScript 定向检查通过。复核中进一步补齐了真实 `/tree` 生命周期、前缀独立消息清理、延迟 UI 事件与连续数字命令的竞态测试。测试 mock 使用实际 pi-ai 的 `clampThinkingLevel`，没有假设所有档位都可用；尚未做交互式 TUI 端到端测试。

离线测试：

```sh
node --experimental-strip-types --test tests/deepseek-effort.test.ts
```
