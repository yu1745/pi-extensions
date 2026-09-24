# qoder-fp

Qoder（阿里/通义千问）provider，出网请求对官方 CLI（`qoder`）做**全量指纹模拟**。

## 特性

- **逐字节同形的首轮请求**：保序 24 个 Headers（含大小写与字段序）、官方系统提示词模板、官方 31 个工具定义——均来自真实抓包基线。
- **自定义 Base64 与切片置换编解码**：实现 Qoder 特有的 64 字符字母表自定义 Base64 编码，并按前后 1/3 切片对调（`swapBodyOuterThirds`）。
- **全套 Cosy 族安全签名**：嵌入官方 1024-bit RSA 公钥 + AES-128-CBC 敏感数据加密 + MD5 完整性签名，生成 `Authorization: Bearer COSY.<payload>.<sig>`。
- **流式 SSE 协议解构与推理适配**：上游响应通过内层 JSON 包裹标准 OpenAI completions chunk，插件自动解包并提取正文与 `reasoning_content`（深度思考流），原生支持思考模型与工具调用。
- **Token 凭证与鉴权管理**：
  - 遵循 pi 原生规范，统一持久化至 `~/.pi/agent/auth.json`（`qoder` 键，`oauth` 格式）。
  - 支持官方 Device Flow 浏览器授权登录（`/qoder-login` 或 pi 原生 `/login` 选 `qoder`）。
  - 具备 401 自动刷新兜底机制与基于 `/api/v1/jobToken/refresh` 的静默续期。

## 使用

pi 原生 `/login` → 选 `qoder` → 二级选择：

1. **浏览器 OAuth 授权**（淘宝/支付宝/阿里云账号，弹出 URL，授权后自动继续）
2. **从官方 Qoder CLI 导入**（自动检测 `~/.qoder/.auth`，导入并激活已登录凭据）

此外还提供快捷命令：
- `/qoder-login`：直接发起登录
- `/qoder-import`：直接从官方 CLI 导入凭证

之后在 `/models` 选 `qoder/qwen3.8-flash`（限时免费 0x 倍率）或 `qoder/qwen3.8-max`。退出用原生 `/logout`。

## 环境变量

| 变量 | 说明 |
|---|---|
| `QODER_PROXY` / `HTTPS_PROXY` | 可选出网代理（CONNECT 隧道，保持头序与 HTTP/1.1） |

## 文件结构

- `index.ts` — 插件本体、Provider 注册、OAuth 设备流与流式适配器
- `codec.ts` — 自定义 Base64 编解码与外层切片对调算法
- `cosy.ts` — Cosy 头生成器、RSA/AES 密码学加密与 MD5 签名
- `official-tools.json` — 官方 CLI 1.1.63 的 31 个工具定义（抓包提取）
- `official-system.json` — 官方系统提示词模板
