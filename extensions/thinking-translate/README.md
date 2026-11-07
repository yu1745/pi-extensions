# thinking-translate

思考内容（thinking / CoT）自动翻译：只有当一段思考的**英文占比超过阈值**时才翻成中文，
译文用 `registerMarkdownTransformer` 顶在**显示层**，会话上下文和发给模型的内容一个字都不改。

- 默认**关闭**，按快捷键或 `/thinking-translate on` 打开。
- 只译英文思考；本来就中文的思考不花一分钱、不发一次请求。
- 翻译走一个便宜的模型（自动挑 `flash` / `mini` / `fast` 类，可配置）。

## 快捷键

默认按 `shortcuts` 顺序取第一个**没被占用**的键：`ctrl+k` → `alt+k` → `ctrl+alt+k`。

⚠️ 在 pi 1.5.0 里 **`ctrl+k` 被内置的 `tui.editor.deleteToLineEnd` 占着，而且它是「保留键」**
（`RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS`）——扩展注册这个键会被**直接丢弃**。
所以开箱实际生效的是 `alt+k`：`alt+k` 和现有内置/用户键位都不冲突，**启动时不会有任何警告**
（本扩展也只在配置坏了或所有候选键都被占时才提示；用了哪个键看 `/thinking-translate status`）。

想真的用 `ctrl+k`：把内置动作挪走（保留行尾删除），`~/.pi/agent/keybindings.json` 写

```json
{
  "tui.editor.deleteToLineEnd": "ctrl+shift+k"
}
```

然后 `/reload`。`ctrl+k` 空出来后，本扩展会自己选中它（候选顺序不变）。

冲突判断用的是「pi 内置默认键位 + 你的 `keybindings.json` 覆盖」（用户值替换默认，`[]` 表示禁用），
内置表抄自 pi 1.5.0 的 `docs/keybindings.md`；`alt+k`、`ctrl+alt+k` 与现有内置/用户键位均不冲突。

## 配置

`~/.pi/agent/thinking-translate.json`（可选，缺字段用默认值；文件不存在即默认关闭）：

```json
{
  "enabled": false,
  "shortcuts": ["ctrl+k", "alt+k", "ctrl+alt+k"],
  "englishRatio": 0.5,
  "minLatinLetters": 40,
  "maxChars": 6000,
  "model": "magpie/auto/deepseek-v4.1-flash",
  "targetLanguage": "简体中文",
  "finalizeWaitMs": 1500,
  "showStatus": true
}
```

| 字段 | 说明 |
|---|---|
| `enabled` | 启动时是否已开启 |
| `shortcuts` | 候选快捷键，按顺序取第一个无冲突的 |
| `englishRatio` | 拉丁字母 / (拉丁字母 + 汉字) ≥ 该值判定为英文 |
| `minLatinLetters` | 拉丁字母少于该值不翻译（`OK`、`TODO` 这类） |
| `maxChars` | 单次翻译请求的最大字符数，超过按段落分块 |
| `model` | 翻译模型，`provider/modelId` 或纯 `modelId`；留空自动挑便宜的（按输入单价升序，`flash`/`mini`/`fast` 类优先，跳过没有凭据的 provider，失败自动换下一个） |
| `targetLanguage` | 目标语言 |
| `finalizeWaitMs` | `message_end` 里最多等译文多久 |
| `showStatus` | 开启时在状态栏显示 `译` |
| `persist` | 是否把译文落盘到会话目录（默认 `true`） |
| `requestTimeoutMs` | 单次翻译请求超时，超时就换下一个候选模型（默认 `25000`） |
| `notifyFailure` | 翻译彻底失败时提示一次（默认 `true`；失败不影响正文） |
| `markerLabel` | 译文顶部的标记文字（默认 `🀄 译`；空字符串 = 不标记） |
| `markerStyle` | 标记的 Markdown 形态：`code`（行内代码，主题 violet）/ `heading`（标题，yellow）/ `quote`（引用，muted+边框）/ `none` |

## 怎么一眼看出这是译文

pi 把 thinking 块整块用 `theme.fg("thinkingText", …)`（灰）包住，扩展换不了这个颜色；
但 Markdown **内部结构**的颜色是主题自己上的，会盖过外层灰。所以每段译文顶部加一行标记，
用结构本身的颜色来区分（默认行内代码 → dark 主题的 violet）：

```
🀄 译            ← 行内代码，紫色，和正文灰色明显不同

用户问的（笔误「/re;p」= /reload）……
```

- `markerStyle: "heading"` → 黄色标题；`"quote"` → muted + `│` 边框；`"none"` → 不标记
- `markerLabel: ""` → 完全关闭标记
- 标记在**渲染时**加，不写入缓存，改配置立刻生效（不需要重新翻译）

## 开关会写回配置

按快捷键或 `/thinking-translate on|off` 切换时，`enabled` 会**写回 `thinking-translate.json`**（其它字段原样保留）。
不写回的话，`/reload`、重启、`/new` 都会重建扩展实例、把开关读回默认的「关」，
表现就是「突然不翻了」。想让某个会话临时关掉：`/thinking-translate off`，同样会写回。

## 命令

`/thinking-translate`（等同 `status`）看状态；`/thinking-translate on` / `off` 开关。

## 译文持久化（重启/续会话后还在）

每个会话的文件就放在**它自己的 jsonl 旁边**，不集中、也不做一堆小文件：

```
~/.pi/agent/sessions/--home-wangyu--/2026-11-06T...-<uuid>.jsonl
~/.pi/agent/sessions/--home-wangyu--/2026-11-06T...-<uuid>.thinking-translate.txt
```

- 内容仍是 **jsonl**（一行一条 `{"k":"<sha1(原文)>","t":"译文"}`），加载时只按行解析；
- 后缀故意**不是** `.jsonl`：pi 发现会话全靠 `file.endsWith(".jsonl")`，多一个 `.jsonl`
  会被 `/resume` 当成坏会话去解析；换个后缀就完全不会被扫到；
- 只存原文的 sha1，不存原文（思考里可能夹代码、路径、密钥）；
- 追加写、坏行跳过；会话删了/归档了，缓存跟着走，不需要额外清理；
- `persist: false` 或 `--no-session` 时退化成纯内存。

`session_start` 会把当前会话的缓存读回内存，所以**续会话/重启后历史思考直接显示中文**，
不会重新发一次翻译请求。

## 实现要点

1. **判定**：先剥掉围栏代码块、行内代码、URL、文件路径（`detect.ts`），再数拉丁字母和汉字。
   全代码的思考直接判为「没有可译内容」。
2. **缓存 key**：pi 把**连续**的 thinking 块 `trim()` 后用 `"\n\n"` 拼成一个 Markdown 组件渲染，
   transformer 拿到的正是这个字符串；所以译文缓存的 key 必须用同样拼法（`runs.ts`），否则永远命中不上。
3. **触发时机**：`thinking_end` 时该块不再变化，立刻开翻；`message_end` 再兜一遍并**有界等待**
   （扩展事件先于 UI 渲染，等一会儿就能让最终帧直接是译文）。
4. **显示**：transformer 只做一次 Map 查找，同步、零 IO。译文晚到了也不用额外处理——
   后续任意 `updateContent` 都会 `setText` 同一个 thinking 文本并清掉 Markdown 缓存，
   下一帧自然换成译文；同时会主动 `requestRender(true)` 催一帧。
5. **失败可见、不堵队**：每个请求带 `requestTimeoutMs` 超时（超时换下一个候选模型），
   彻底失败只把该段标记跳过并提示一次，绝不影响正文；串行队列因此不会卡死。
   翻译前先按「配置的模型 → 便宜模型 → 会话模型」排行候选，单个请求内最多试前 3 个，全挂了才跳过。
