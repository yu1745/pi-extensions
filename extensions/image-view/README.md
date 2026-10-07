# image-view

在 pi 的对话流里显示本地图片：**入口在对话流，图片在 widget**。

- `read` 一张图 / 助手回复里的 `![alt](/abs/path.png)` / `/img <path>` → 对话流原位留下一行
  `🖼 展开图片 · alt · 路径`
- 点那一行 → 文案变 `🖼 收起图片`，图片在编辑器上方的 widget 里展开（此刻才转图）
- widget 右侧按钮：`−` `+` 缩放（默认铺满 100%，范围 1/8~1）、点百分比复位到 100%、`✕` 关闭
- 点入口行或 widget 的图片区域同样折叠 / 展开

只走 **Sixel**（`\x1bP`）。Kitty / iTerm2 分支曾实现并测过，最终删掉了：Kitty 序列
在本终端能完整写出（原始字节流确认），但画出来只剩顶上一条；本终端的
EL(`\x1b[2K`) 会连图形一起擦掉，而 pi 逐行重写预留行必然发 EL，重发序列也救不
回来（同一 image id 不会重画）。Sixel 这条路实测可用，就只留它。

协议判定（`/img-info` 可查）：

1. `PI_IMAGE_VIEW_SIXEL=0`（按终端声明）→ 不画；
2. `PI_IMAGE_PROTOCOL=none`（pi 官方按进程开关）→ 不画；
3. 其余都当这台终端认 Sixel。

命令：

| 命令 | 作用 |
|---|---|
| `/img <path>` | 在对话流插入图片入口（路径前缀 `!` 强制重新生成） |
| `/img-info` | 显示当前协议与判定依据（环境变量、TERM、终端尺寸、单元格像素） |

## 能力判定只依赖终端（不写任何共享状态）

判定顺序见上（`PI_IMAGE_VIEW_SIXEL` / `PI_IMAGE_PROTOCOL` / 默认当支持 Sixel）。

**不要用持久化文件存这类开关。** 这里踩过一次：早先用
`~/.cache/pi-image-view-sixel` 保存"Sixel 兜底开关"，而那是跨终端共享的——
在同一台机器上开两个终端会互相污染（A 里关掉，B 也一起关）。**能力属于
client，不属于 server**：环境变量随终端进程走，天然隔离。

需要按终端声明时，在 `~/.bashrc` 里用该终端自己的标识判定（`STY`/`TMUX` 下
关掉，那两个多路复用器会吃掉图片转义序列），例如：

```bash
[ -n "$WEBTERM_SESSION" ] && [ -z "$STY$TMUX" ] && export PI_IMAGE_VIEW_SIXEL=1
[ -n "$STY$TMUX" ] && export PI_IMAGE_VIEW_SIXEL=0
```

（本机当前未设置这些变量 —— 默认就当支持 Sixel。）

按进程禁用图片用 pi 官方开关：环境变量 `PI_IMAGE_PROTOCOL=none`，或
`settings.json` 的 `terminal.images: false`。

## 这个扩展为什么长这样

pi 的渲染模型对 Sixel 有几个不显然的硬约束，全部是实测得出的（诊断过程见 git 历史）：

### 1. 六像素负载必须走根级 widget，不能在对话流里画

- pi 的 `visibleWidth()` 把 Sixel 负载的**每个字符**都算作一列可见宽度：900×420 的图
  负载约 8896 字符 → 这一行"宽" 8896 列。
- 聊天区的盒子比终端**窄一列**（滚动条的 `fullscreenScrollbar: "auto"` 在内容超高时会占一列），
  于是这一行走进 layout 的 `compositeTuiLine()`，末尾的
  `sliceByColumn(line, 0, 内容列宽)` 会把它切断（实测 8896 → ~270 字符）。
  切断后连结尾的 `\x1b\\` 都没了，终端拿到未终止的 DCS 就**整段丢弃**——屏幕上什么都不显示，
  或只留下切断点之前的部分（表现为"上半截"图）。
- `paintBox` 有一条免切快路径，但它要求 `box.rect.x === 0 && box.rect.width >= totalWidth`，
  聊天区正好差这一列。widget 挂根级、盒子全宽，能走快路径。
- 另一种"躲开截断"的老办法是把负载压到内容列宽以内（约等于屏宽 1/3），但那样图很小。
  现在改为 widget 承载，宽度上限 2000px。

### 2. 这台终端的 EL(`\x1b[2K`) 会把 Sixel 图形一起擦掉

- pi 重写任何一行都是 `\x1b[<row>;1H\x1b[2K` + 内容。
- 对照组实测：画完图后对**图覆盖范围内**的行发 `\x1b[2K`，图消失（E1）；写空格只造成部分覆盖（E2）；
  什么都不做则完整（E3）。
- 后果：图先画出来，之后任意一帧重写它覆盖的行就把它擦掉；而图片行内容没变，pi 判定"没变"
  就不重发 → 图停在空白。
- 对策：图片行挂一个每 400ms 变化的零宽序列（`\x1b]8;;pi-image-view:<bucket>\x07`），
  再配 500ms 心跳（`requestRender`）逼 pi 重绘 → 图自动刷回来。心跳只在展开时运行。

### 3. 图片行必须自己占住它覆盖的所有行

widget 返回 `[图片行, ...预留空行]`。若只返回一行，图会视觉上溢出到编辑器那些**每帧都被重写**的行上，
立刻被 EL 擦掉。预留空行是让这些行"归我们所有"。

### 4. 宽度只能由 `prewarm()` 定一次，render 复用

`prewarm()` 用 `process.stdout.columns`，`Component.render()` 收到的是 `width`，两者不总相等。
各自算一遍就会缓存未命中、图上只出现"正在生成 Sixel…"占位行。现在用 `pinnedPx` 钉住。

### 5. 按钮位置 / 百分比要按**光栅实际宽度**算

`convert -resize Wx>` 里的 `>` 表示"只缩不放"：源图 900px 时请求 1600/2000px 都只会得到 900px。
按"请求宽度"算位置，缩放几次后按钮就漂到图右边去了。用 `knownActualWidth()` 记实际宽度。

### 6. 组件状态必须是共享对象

pi 重绘复用**同一个组件实例**（`setWidget` 只在重新挂载时才造新组件）。折叠/缩放状态若按值传进
构造函数，回调改了闭包变量、实例里还是旧值——表现就是"点了没反应"。

### 7. 鼠标事件只认 `click`

pi 一次点击会先发 `press` 再发 `click`，两个都处理等于执行两遍：折叠会自我抵消
（"展开只闪一下就回去"）、缩放一步跳两级、`✕` 连触发两次。
只认 `click` 后也会出现 `press`（未处理）→ `click`（处理）的顺序，但不会重复执行。

### 8. 回调里请求重绘必须带接收者

`tui?.requestRender?.(true)` 是把方法摘下来裸调用，`this` 变成 `undefined`，而
`TuiAltScreen.requestRender` 内部要用 `this.scheduleRender()` → 每次都抛 `TypeError`。
它发生在 `setInterval` / async 里，异常被吞掉，表现为"点了没反应、心跳形同虚设"。
统一走 `rerender()`（内部 `Reflect.apply(fn, target, [true])`）。

### 9. 所有列宽计算用 `visibleWidth()`，不能用 `.length`

`theme.fg()` 会插入 ANSI 转义序列（实测差约 40 字符），用 `.length` 算 padding 会让按钮
停不到目标位置，命中区也随之偏移。

## 文件

| 文件 | 职责 |
|---|---|
| `index.ts` | 扩展入口：entry renderer、`read`/`message_end` 触发、命令、心跳、widget 挂载 |
| `component.ts` | `ImageEntryComponent`（对话流入口）、`ImageGalleryComponent`（widget：header + 按钮 + 命中测试）、`ImageViewComponent`（Sixel 渲染） |
| `../sixel-image/sixel.ts` | 手写 Sixel 编码器（ImageMagick 只负责缩放/量化/输出 PNG 像素） |
| `../sixel-image/component.ts` | `SixelImageComponent`（DECSC 包裹 + 零宽 Kitty 占位 + 预留行 + 心跳标记） |

## 已知限制

- 小图放大到某点后**饱和**（`convert` 的 `>` 只缩不放），百分比会停在实际值。
- 宽度上限 2000px：铺满终端像素宽是 2430px，但每 500ms 重发的负载会到 MB 级，故折中。
- 只支持 Sixel：终端不认 Sixel 就没法显示（Kitty/iTerm2 分支已删）。
- widget 里最多同时留 2 张图（`MAX_GALLERY = 2`）——widget 固定在编辑器上方，不随对话流滚动。
