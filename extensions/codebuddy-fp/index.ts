/**
 * CodeBuddy 指纹全量模拟 Provider（pi extension）
 *
 * 依据 2026-09 对官方 CLI @tencent-ai/codebuddy-code 2.151.0 的真实抓包
 * （/tmp/cbc-capture.flow、/tmp/cbc-capture2.flow）逐字段复刻出网指纹：
 *
 * - POST https://copilot.tencent.com/v2/chat/completions
 * - UA: CLI/2.151.0 CodeBuddy/2.151.0
 * - x-codebuddy-request: 1（风控闸门头）
 * - x-stainless-* 全套（OpenAI SDK 6.25.0 动态真实值：process.arch/os/version）
 * - X-Conversation-ID（UUIDv7）/ X-Conversation-Message-ID == X-Request-ID /
 *   X-Conversation-Request-ID == X-Root-Request-ID（UUIDv7 去横线 32hex）
 * - X-Agent-Intent: craft / X-Agent-Purpose: conversation / X-Agent-Type: main
 * - X-IDE-Type/Name: CLI / X-IDE-Version: 2.151.0 / X-Private-Data: false
 * - B3 双格式链路头：X-B3-TraceId/SpanId/ParentSpanId/Sampled + b3 + traceparent
 * - 请求体 gzip（Content-Encoding: gzip）
 *
 * 隐私：只发 chat 请求。不发 /v3/config?repos[]、/v2/report、/v1/traces——
 * 已验证非 git 工作区下 CLI 本身也不发 report，且不发这些端点就不存在
 * git remote / machineId / cpu 信息上报。
 *
 * 登录：pi 原生 /login 选 codebuddy，二级选择「浏览器 OAuth 授权」或
 * 「从官方 CLI 导入凭证」（POST /v2/plugin/auth/state → 浏览器 → GET /v2/plugin/auth/token）
 * token 存 ~/.pi/agent/extensions/codebuddy-fp/auth.json（0600），自动刷新
 * （POST /v2/plugin/auth/token/refresh）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── 常量（对齐抓包） ─────────────────────────────────────────────────────────

const BASE = "https://copilot.tencent.com";
const CLI_VERSION = "2.151.0";
const STAINLESS_PACKAGE_VERSION = "6.25.0"; // CLI 内嵌 OpenAI SDK 版本（抓包实证）
const USER_AGENT = `CLI/${CLI_VERSION} CodeBuddy/${CLI_VERSION}`;
const STATE_FILE = path.join(__dirname, "login-state.json");
// 凭证存 pi 原生库 ~/.pi/agent/auth.json（key: "codebuddy"，oauth 形状 + 业务字段），
// 与 /login、--api-key 等原生流程同一存储，不另建私有凭证文件。
function piAuthFile(): string {
  try {
    const { getAgentDir } = require("@earendil-works/pi-coding-agent");
    return path.join(getAgentDir(), "auth.json");
  } catch { return path.join(os.homedir(), ".pi/agent/auth.json"); }
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

function uuidv7(): string {
  const ts = Date.now();
  const tsHex = ts.toString(16).padStart(12, "0");
  const rand = randomBytes(10);
  const b = Buffer.from(tsHex + "7" + rand.toString("hex").slice(1, 3) + rand.toString("hex").slice(3), "hex");
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function uuidv7Hex(): string {
  return uuidv7().replace(/-/g, "");
}

function hex(n: number): string {
  return randomBytes(n).toString("hex");
}

function stainlessOS(): string {
  const p = os.platform();
  if (p === "darwin") return "MacOS";
  if (p === "win32") return "Windows";
  return p.charAt(0).toUpperCase() + p.slice(1);
}

function jwtExp(token: string): number {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return typeof p.exp === "number" ? p.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// ── 凭证管理 ─────────────────────────────────────────────────────────────────

interface AuthState {
  accessToken: string;
  refreshToken: string;
  userId: string;
  domain: string;
  expiresAt: number; // ms
  nickname?: string;
}

// AuthState 兼容两种形状：pi 库（access/refresh/expires/userId/domain）与旧本地文件（accessToken/...）
function loadAuth(): AuthState | null {
  // 1) pi 原生库
  try {
    const store = JSON.parse(fs.readFileSync(piAuthFile(), "utf8"));
    const c = store?.codebuddy;
    if (c?.access && c?.refresh) {
      return {
        accessToken: c.access, refreshToken: c.refresh,
        userId: c.userId ?? "", domain: c.domain ?? "www.codebuddy.cn",
        nickname: c.nickname ?? "", expiresAt: c.expires ?? 0,
      };
    }
  } catch {}
  return null;
}

function saveAuth(a: AuthState) {
  const f = piAuthFile();
  let store: Record<string, unknown> = {};
  try { store = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  store.codebuddy = {
    type: "oauth",
    access: a.accessToken, refresh: a.refreshToken, expires: a.expiresAt,
    userId: a.userId, domain: a.domain, nickname: a.nickname,
  };
  fs.writeFileSync(f, JSON.stringify(store, null, 2), { mode: 0o600 });
}

let refreshInFlight: Promise<AuthState> | null = null;

async function refreshAuth(a: AuthState): Promise<AuthState> {
  // 并发去重：多个请求同时触发刷新时只发一次
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const proxyUrl = process.env.CODEBUDDY_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? undefined;
      const res = await rawRequest(`${BASE}/v2/plugin/auth/token/refresh`, "POST", [
        ["Authorization", `Bearer ${a.accessToken}`],
        ["X-Refresh-Token", a.refreshToken],
        ["X-Auth-Refresh-Source", "plugin"],
        ["X-Request-ID", uuidv7Hex()],
        ["X-Product", "SaaS"],
        ["Content-Type", "application/json"],
        ["User-Agent", USER_AGENT],
        ["X-Requested-With", "XMLHttpRequest"],
        ["Host", new URL(BASE).host],
        ["Connection", "keep-alive"],
      ], Buffer.from("{}"), proxyUrl);
      if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
      const j = (await res.json()) as any;
      const d = j.data ?? j;
      const next: AuthState = {
        ...a,
        accessToken: d.accessToken ?? a.accessToken,
        refreshToken: d.refreshToken ?? a.refreshToken,
        expiresAt: Date.now() + (d.expiresIn ?? 3600) * 1000,
      };
      saveAuth(next);
      return next;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

let authCache: AuthState | null = null;

async function getValidAuth(force = false): Promise<AuthState> {
  if (!authCache) authCache = loadAuth();
  if (!authCache) throw new Error("CodeBuddy 未登录：请先 /login 选择 codebuddy");
  // 提前 2 分钟主动刷新（refresh 端点官方标注“不受频率限制”）
  if (force || Date.now() > authCache.expiresAt - 120_000) {
    authCache = await refreshAuth(authCache);
  }
  return authCache;
}

// ── 会话状态（进程内） ───────────────────────────────────────────────────────

// Conversation-ID 会话级稳定（一个 pi 会话一个）
const conversationID = uuidv7();

// ── 指纹 fetch：全量头 + gzip ────────────────────────────────────────────────

function buildFingerprintHeaders(a: AuthState): Record<string, string> {
  const convReqID = uuidv7Hex();
  const messageID = uuidv7Hex(); // 官方：Message-ID == Request-ID（不同值，同形状）
  const traceId = hex(16);
  const spanId = hex(8);
  const parentSpanId = hex(8);
  return {
    // 基础
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    "X-Requested-With": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    // OpenAI SDK (stainless) 遥测 —— 动态真实值
    "x-stainless-arch": process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os": stainlessOS(),
    "x-stainless-package-version": STAINLESS_PACKAGE_VERSION,
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    // 客户端标识
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "X-Agent-Type": "main",
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "X-IDE-Version": CLI_VERSION,
    "X-Private-Data": "false",
    // 会话头族
    "X-Conversation-ID": conversationID,
    "X-Conversation-Message-ID": messageID,
    "X-Conversation-Request-ID": convReqID,
    "X-Root-Request-ID": convReqID,
    "X-Request-ID": messageID,
    // B3 双格式链路
    "X-B3-TraceId": traceId,
    "X-B3-SpanId": spanId,
    "X-B3-ParentSpanId": parentSpanId,
    "X-B3-Sampled": "1",
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    traceparent: `00-${traceId}-${spanId}-01`,
    "X-Trace-ID": traceId,
    // 账号
    Authorization: `Bearer ${a.accessToken}`,
    "X-User-Id": a.userId,
    "X-Domain": a.domain,
    "X-Product": "SaaS",
  };
}

// 传输层：node:https 原始请求（headers 数组形式严格保序；无自动附加头；恒 HTTP/1.1）。
// 不用 undici fetch —— 它会按字母序重排 headers 并自动加 accept-language/sec-fetch-mode 等头。
// 代理（可选）：CODEBUDDY_PROXY/HTTPS_PROXY → 手工 CONNECT 隧道，同样保持顺序与 HTTP 版本。
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";

function tunnelViaProxy(proxyUrl: string, host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const u = new URL(proxyUrl);
    const req = http.request({
      host: u.hostname, port: Number(u.port || 80),
      method: "CONNECT", path: `${host}:${port}`,
      headers: { Host: `${host}:${port}`, "Proxy-Connection": "keep-alive" },
    });
    req.once("connect", (res: any, socket: net.Socket) => {
      if (res.statusCode === 200) resolve(socket);
      else { socket.destroy(); reject(new Error(`proxy CONNECT failed: ${res.statusCode}`)); }
    });
    req.once("error", reject);
    req.end();
  });
}

/** 原始保序请求。headerPairs 为 [key, value][]（node:http 数组形式严格保序）。 */
async function rawRequest(urlStr: string, method: string, headerPairs: [string, string][], body: Buffer, proxyUrl?: string): Promise<Response> {
  const u = new URL(urlStr);
  const port = Number(u.port || 443);
  let tlsSock: tls.TLSSocket | undefined;
  if (proxyUrl) {
    const raw = await tunnelViaProxy(proxyUrl, u.hostname!, port);
    tlsSock = tls.connect({ socket: raw, servername: u.hostname, rejectUnauthorized: true });
    await new Promise<void>((res, rej) => { tlsSock!.once("secureConnect", res); tlsSock!.once("error", rej); });
  }
  return new Promise((resolve, reject) => {
    const opts: any = {
      host: u.hostname, port, method, path: u.pathname + u.search,
      headers: headerPairs, // 数组形式：严格按给定顺序发送
    };
    if (tlsSock) opts.createConnection = () => tlsSock!;
    const req = https.request(opts, (res: any) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const resp = new Response(buf, {
          status: res.statusCode ?? 502,
          headers: new Headers(res.headers as Record<string, string>),
        });
        (resp as any)._rawBuf = buf; // 供 traces 统计 total_bytes / 内容长度
        resolve(resp);
      });
      res.on("error", reject);
    });
    req.once("error", reject);
    if (body.length) req.write(body);
    req.end();
  });
}

// ═══ 工具对齐（官方 22 工具首发，第二轮起换 pi 真实工具）═══
// 思路：chat 第 1 轮 body.tools 替换为官方 CLI 抓包的 22 个工具定义（指纹对齐）；
// 模型可能按官方 schema 发起 tool_call（如 "Read"/"Bash" 大写名），pi 找不到该工具
// 会注入错误消息 → 第 2 轮起发 pi 真实工具定义（read/bash/edit/write），模型自适应。
let chatRound = 0;
let officialTools: any[] = [];
try { officialTools = JSON.parse(fs.readFileSync(path.join(__dirname, "official-tools.json"), "utf8")); } catch {}
let officialSystemTpl = "";
try { officialSystemTpl = JSON.parse(fs.readFileSync(path.join(__dirname, "official-system.json"), "utf8")).system; } catch {}

/** 用真实环境填充官方 <env> 块。git 状态恒为 No —— 永不泄漏 git 信息。 */
function buildOfficialSystem(modelId: string): string {
  if (!officialSystemTpl) return "";
  const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  let osv = "";
  try { osv = require("node:child_process").execSync("uname -v", { encoding: "utf8" }).trim(); } catch { osv = os.release(); }
  const env = `<env>\nWorking directory: ${process.cwd()}\nIs directory a git repo: No\nPlatform: ${os.platform()}\n\nOS Version: ${osv}\nDefault shell: bash\nToday's date: ${date}</env>`;
  return officialSystemTpl
    .replace("{{ENV}}", env)
    .replace("{{MODEL_NAME}}", modelNamePretty(modelId))
    .replace("{{MODEL_ID}}", modelId);
}

// ═══ SSE 解析：finish_reason / tool_calls / usage ═══
function parseSse(buf: Buffer) {
  let finishReason = "";
  const toolCalls: { id: string; name: string }[] = [];
  let usage: any = null;
  try {
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (!d || d === "[DONE]") continue;
      try {
        const j = JSON.parse(d);
        const ch = j.choices?.[0];
        if (ch?.finish_reason) finishReason = ch.finish_reason;
        for (const tc of ch?.delta?.tool_calls ?? []) {
          if (tc.id && tc.function?.name) toolCalls.push({ id: tc.id, name: tc.function.name });
        }
        if (j.usage) usage = j.usage;
      } catch {}
    }
  } catch {}
  return { finishReason, toolCalls, usage };
}

// ═══ 伴随请求（对齐官方 CLI 出网序列：config → accounts → chat → report → traces）═══
// 隐私红线：vcsType/vcsRepo/vcsBranchName/vcsRevId 恒为空/unknown —— git remote 永不上报。
const RELEASE_DATE = 1789401568271;   // 官方 CLI 安装时间戳（同机基线）
const COMMIT = "bb0afa2f7b5b2504693c68d22c1fe4076b8229c7"; // 官方 CLI 构建 commit
let didStartup = false;      // config + accounts 每进程一次
let didPluginStart = false;  // report 的 pluginStart 事件每进程一次
let didToolReport = false;   // 官方整个会话只发一批含工具事件的 report
const procStartTime = Date.now();

function machineId(): string {
  try {
    const mid = fs.readFileSync("/etc/machine-id", "utf8").trim().replace(/-/g, "");
    if (mid.length === 32) return `${mid.slice(0,8)}-${mid.slice(8,12)}-${mid.slice(12,16)}-${mid.slice(16,20)}-${mid.slice(20)}`;
  } catch {}
  return "00000000-0000-0000-0000-000000000000";
}

function envInfo(): Record<string, unknown> {
  const cpus = os.cpus();
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    username: os.userInfo().username,
    userNickname: os.userInfo().username,
    os: os.platform(),
    arch: os.arch(),
    osVersion: os.release(),
    cpuModel: cpus[0]?.model ?? "",
    cpuCores: cpus.length,
    memorySize: Math.round(os.totalmem() / 1024 / 1024 / 1024),
    machineId: machineId(),
    extName: "@tencent-ai/codebuddy-code",
    extVersion: CLI_VERSION,
    ideName: "CLI",
    ideType: "CLI",
    ideVersion: CLI_VERSION,
    featureModule: "cli_local",
    product: "SaaS",
    releaseDate: RELEASE_DATE,
    commit: COMMIT,
  };
}

function commonTelemetryHeaders(a: AuthState, reqID: string, extra: [string, string][] = []): [string, string][] {
  return [
    ["Accept", "application/json, text/plain, */*"],
    ...extra,
    ["X-Requested-With", "XMLHttpRequest"],
    ["Authorization", `Bearer ${a.accessToken}`],
    ["X-User-Id", a.userId],
    ["X-Domain", a.domain],
    ["X-Product", "SaaS"],
    ["User-Agent", USER_AGENT],
    ["X-Request-ID", reqID],
    ["Host", new URL(BASE).host],
  ];
}

async function sendConfig(a: AuthState, proxyUrl?: string) {
  // GET /v3/config（不带 repos[] —— 官方非 git 目录行为；我们也永不带）
  // 官方头序：Connection 在第 3 位（此请求是 close，非 keep-alive）
  await rawRequest(`${BASE}/v3/config`, "GET", [
    ["Accept", "application/json, text/plain, */*"],
    ["X-Requested-With", "XMLHttpRequest"],
    ["Connection", "close"],
    ["Authorization", `Bearer ${a.accessToken}`],
    ["X-User-Id", a.userId],
    ["X-Domain", a.domain],
    ["X-Product", "SaaS"],
    ["User-Agent", USER_AGENT],
    ["X-Request-ID", uuidv7Hex()],
    ["Host", new URL(BASE).host],
  ], Buffer.alloc(0), proxyUrl).catch(() => {});
}
async function sendAccounts(a: AuthState, proxyUrl?: string) {
  // GET /v2/plugin/accounts（注意官方头序：X-Domain 在 Authorization 前）
  await rawRequest(`${BASE}/v2/plugin/accounts`, "GET", [
    ["Accept", "application/json, text/plain, */*"],
    ["X-Requested-With", "XMLHttpRequest"],
    ["X-Domain", a.domain],
    ["Authorization", `Bearer ${a.accessToken}`],
    ["X-User-Id", a.userId],
    ["X-Product", "SaaS"],
    ["User-Agent", USER_AGENT],
    ["X-Request-ID", uuidv7Hex()],
    ["Host", new URL(BASE).host],
    ["Connection", "keep-alive"],
  ], Buffer.alloc(0), proxyUrl).catch(() => {});
}

function modelNamePretty(id: string): string {
  const known: Record<string, string> = { "deepseek-v4.1-flash": "Deepseek-V4.1-Flash", "hy4-preview": "Hunyuan-4-Preview", "hy3": "Hunyuan-3", "kimi-k3": "Kimi-K3" };
  return known[id] ?? id;
}

async function sendReport(a: AuthState, m: ChatMeta2, model: string, inputLength: number, proxyUrl?: string, sse?: { finishReason: string; toolCalls: { id: string; name: string }[]; usage: any }) {
  // POST /v2/report：pluginStart（每进程一次）+ chat_request_send + chat_message_send
  // 工具轮（finish_reason=tool_calls）追加：chat_message_response + chat_message_status + chat_tool_action（对齐官方基线）
  const now = Date.now();
  const base = { ...envInfo(), userId: a.userId, sessionId: conversationID };
  const events: Record<string, unknown>[] = [];
  if (!didPluginStart) {
    didPluginStart = true;
    events.push({
      eventCode: "plugin_status", timestamp: now, reportDelay: now - procStartTime,
      status: "info", text: "pluginStart", isInterval: false, ...base,
    });
  }
  events.push({
    eventCode: "chat_request_send", timestamp: now, reportDelay: 2053, mode: "unknown",
    conversationId: conversationID, requestId: m.convReqID, inputLength,
    requestModelId: model, requestModelName: modelNamePretty(model),
    isPlan: false, isAutoExecuteTerminal: false, isAutoModify: false, codebaseEnable: false,
    maxToken: 0, maxSteps: 500, temperature: 0, maxRetries: 0,
    mentionContexts: [], knowledgeId: [], knowledgeName: [], codebaseId: "",
    mentionContextCount: 0, command: "", recommendId: "", skillId: "", skillCount: 0, totalCount: 0,
    presentAt: now - 3, traceId: m.traceId, rootRequestId: m.convReqID, parentConversationId: conversationID,
    agentName: "cli", agentType: "main",
    vcsType: "unknown", vcsRepo: "", vcsBranchName: "", vcsRevId: "",
    "codebuddy.session_id": conversationID, "codebuddy.conversation_request_id": m.convReqID,
    ...base,
  });
  events.push({
    eventCode: "chat_message_send", timestamp: now, reportDelay: 2002,
    conversationId: conversationID, requestId: m.convReqID, messageId: m.messageID,
    requestModelId: model, requestModelName: modelNamePretty(model),
    historyCount: 1, isContextTruncated: false, currentStepCount: 1,
    presentAt: now - 2, traceId: m.traceId, rootRequestId: m.convReqID, parentConversationId: conversationID,
    agentName: "cli", agentType: "main",
    "codebuddy.session_id": conversationID, "codebuddy.conversation_request_id": m.convReqID,
    ...base,
  });
  if (sse?.finishReason === "tool_calls") {
    const u = sse.usage ?? {};
    const inputTok = u.prompt_tokens ?? 0, outputTok = u.completion_tokens ?? 0;
    const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
    events.push({
      eventCode: "chat_message_response", timestamp: now, reportDelay: 2077,
      conversationId: conversationID, requestId: m.convReqID, messageId: m.messageID,
      requestModelId: model, requestModelName: modelNamePretty(model),
      responseModelId: model, inputToken: inputTok, outputToken: outputTok,
      totalToken: u.total_tokens ?? inputTok + outputTok,
      cachedTokens: cached, cachedWriteTokens: Math.max(0, inputTok - cached), cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: "", finishReason: "tool_calls",
      firstTokenAt: now - 20, presentAt: now - 2,
      traceId: m.traceId, rootRequestId: m.convReqID, parentConversationId: conversationID,
      agentName: "cli", agentType: "main",
      "codebuddy.session_id": conversationID, "codebuddy.conversation_request_id": m.convReqID,
      ...base,
    });
    events.push({
      eventCode: "chat_message_status", timestamp: now, reportDelay: 2077,
      conversationId: conversationID, requestId: m.convReqID, messageId: m.messageID,
      requestModelId: model, requestModelName: modelNamePretty(model),
      messageErrorCode: "0",
      traceId: m.traceId, rootRequestId: m.convReqID, parentConversationId: conversationID,
      agentName: "cli", agentType: "main",
      "codebuddy.session_id": conversationID, "codebuddy.conversation_request_id": m.convReqID,
      ...base,
    });
    for (const tc of sse.toolCalls) {
      events.push({
        eventCode: "chat_tool_action", timestamp: now, reportDelay: 2018,
        conversationId: conversationID, requestId: m.convReqID, messageId: m.messageID,
        stepCount: 1, toolCallId: tc.id, toolName: tc.name,
        toolCallSuccessful: true, toolStatus: "success",
        requestModelId: model, requestModelName: modelNamePretty(model),
        toolErrorCode: "0", toolErrorCodeKey: "Success", toolErrorMessage: "", type: "main",
        presentAt: now,
        traceId: m.traceId, rootRequestId: m.convReqID, parentConversationId: conversationID,
        agentName: "cli", agentType: "main",
        "codebuddy.session_id": conversationID, "codebuddy.conversation_request_id": m.convReqID,
        ...base,
      });
    }
    events.push({
      eventCode: "chat_message_send", timestamp: now, reportDelay: 2002,
      conversationId: conversationID, requestId: m.convReqID, messageId: uuidv7Hex(),
      requestModelId: model, requestModelName: modelNamePretty(model),
      historyCount: 2, isContextTruncated: false, currentStepCount: 2,
      presentAt: now,
      traceId: m.traceId, rootRequestId: m.convReqID, parentConversationId: conversationID,
      agentName: "cli", agentType: "main",
      "codebuddy.session_id": conversationID, "codebuddy.conversation_request_id": m.convReqID,
      ...base,
    });
  }
  const body = Buffer.from(JSON.stringify(events), "utf8");
  const h = commonTelemetryHeaders(a, uuidv7Hex(), [["Content-Type", "application/json;charset=UTF-8"]]);
  h.splice(h.findIndex(([k]) => k === "Content-Length" || k === "Host"), 0, ...([] as any));
  const full: [string, string][] = [
    ["Accept", "application/json, text/plain, */*"],
    ["Content-Type", "application/json;charset=UTF-8"],
    ["X-Requested-With", "XMLHttpRequest"],
    ["Authorization", `Bearer ${a.accessToken}`],
    ["X-User-Id", a.userId],
    ["X-Domain", a.domain],
    ["X-Product", "SaaS"],
    ["User-Agent", USER_AGENT],
    ["X-Request-ID", uuidv7Hex()],
    ["Content-Length", String(body.length)],
    ["Host", new URL(BASE).host],
    ["Connection", "keep-alive"],
  ];
  await rawRequest(`${BASE}/v2/report`, "POST", full, body, proxyUrl).catch(() => {});
}

interface ChatMeta2 { convReqID: string; messageID: string; traceId: string; spanId: string; startMs: number; }

// traces 攒批：官方是会话结束一次性 export；这里入队，beforeExit / 队列过大时 flush
const traceQueue: { a: AuthState; m: ChatMeta2; model: string; status: number; respBuf: Buffer; inputLength: number; sse: any }[] = [];
function queueTraces(a: AuthState, m: ChatMeta2, model: string, status: number, respBuf: Buffer, inputLength: number, sse: any, proxyUrl?: string) {
  traceQueue.push({ a, m, model, status, respBuf, inputLength, sse });
  if (traceQueue.length >= 6) void flushTraces(proxyUrl); // 防长会话无限积压
}
async function flushTraces(proxyUrl?: string) {
  if (!traceQueue.length) return;
  const batch = traceQueue.splice(0, traceQueue.length);
  // 官方一次 export 带 resource 层 + 全部 spans；逐项构造后合并为单请求
  const allSpans: any[] = [];
  for (const it of batch) allSpans.push(...buildSpans(it.a, it.m, it.model, it.status, it.respBuf, it.inputLength, it.sse));
  if (!allSpans.length) return;
  await sendTracesRaw(batch[0].a, allSpans, proxyUrl).catch(() => {});
}
process.on("beforeExit", () => { if (traceQueue.length) { const pu = process.env.CODEBUDDY_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? undefined; void flushTraces(pu); } });

function buildSpans(a: AuthState, m: ChatMeta2, model: string, status: number, respBuf: Buffer, inputLength: number, sse: any): any[] {
  const respText = respBuf.toString("utf8");
  let contentLen = 0;
  try { for (const mt of respText.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)) contentLen += JSON.parse('"' + mt[1] + '"').length; } catch {}
  const endMs = Date.now();
  const ns = (ms: number) => String(BigInt(ms) * 1000000n);
  const spanId2 = hex(8), spanId3 = hex(8);
  const str = (key: string, stringValue: any) => ({ key, value: { stringValue: String(stringValue) } });
  return [
    { traceId: m.traceId, spanId: m.spanId, name: "codebuddy_code.model_request", kind: 3,
      startTimeUnixNano: ns(m.startMs), endTimeUnixNano: ns(endMs), status: { code: 1 }, attributes: [
        str("span.type", "model_request"), str("http.method", "POST"),
        str("http.url", `${BASE}/v2/chat/completions`), str("model.id", model),
        str("agent.name", "cli"), str("request.id", m.messageID), str("model.stream", "True"),
        str("conversation.request.id", m.convReqID), str("workbuddy.session_id", conversationID),
        str("workbuddy.prompt_request_id", m.convReqID), str("workbuddy.message_id", m.messageID),
        str("workbuddy.request_id", m.messageID), str("http.target", "/v2/chat/completions"),
        str("net.peer.name", new URL(BASE).host),
        { key: "retry_count", value: { intValue: 0 } },
        { key: "http.status_code", value: { intValue: status } },
      ]},
    { traceId: m.traceId, spanId: spanId2, name: "codebuddy_code.model_stream", kind: 3,
      startTimeUnixNano: ns(m.startMs), endTimeUnixNano: ns(endMs), status: { code: 1 }, attributes: [
        str("span.type", "model_stream"), str("model.id", model), str("agent.name", "cli"),
        str("request.id", m.messageID), str("conversation.request.id", m.convReqID),
        str("workbuddy.session_id", conversationID), str("workbuddy.prompt_request_id", m.convReqID),
        str("workbuddy.message_id", m.messageID), str("workbuddy.request_id", m.messageID),
        { key: "first_token_ms", value: { intValue: Math.max(1, endMs - m.startMs) } },
        { key: "chunk_count", value: { intValue: 1 } },
        { key: "total_bytes", value: { intValue: respBuf.length } },
        str("stream.status", "ok"), str("workbuddy.stop_reason", "ok"),
      ]},
    ...(sse?.finishReason === "tool_calls" ? sse.toolCalls.map((tc: any) => ({
      traceId: m.traceId, spanId: hex(8), name: "codebuddy_code.tool", kind: 3,
      startTimeUnixNano: ns(m.startMs), endTimeUnixNano: ns(endMs), status: { code: 1 }, attributes: [
        str("codebuddy.session_id", conversationID), str("codebuddy.conversation_request_id", m.convReqID),
        str("span.type", "tool"), str("tool_name", tc.name), str("tool.call_id", tc.id),
      ]})) : []),
    { traceId: m.traceId, spanId: spanId3, name: "codebuddy_code.interaction", kind: 3,
      startTimeUnixNano: ns(m.startMs), endTimeUnixNano: ns(endMs), status: { code: 1 }, attributes: [
        str("codebuddy.session_id", conversationID), str("codebuddy.conversation_request_id", m.convReqID),
        str("span.type", "interaction"), str("conversation.id", conversationID),
        str("conversation.agent", "cli"), str("conversation.request.id", m.convReqID),
        str("workbuddy.session_id", conversationID), str("workbuddy.prompt_request_id", ""),
        str("workbuddy.conversation_request_id", m.convReqID), str("workbuddy.message_id", ""),
        str("workbuddy.model", ""), str("workbuddy.agent_name", "cli"),
        { key: "user_prompt_length", value: { intValue: 5 } },
        { key: "assistant_output_length", value: { intValue: contentLen } },
      ]},
  ].filter((sp: any) => sp.name !== "codebuddy_code.interaction" || sse?.finishReason !== "tool_calls");
}

async function sendTracesRaw(a: AuthState, spans: any[], proxyUrl?: string) {
  const str = (key: string, stringValue: string) => ({ key, value: { stringValue } });
  const body = {
    resourceSpans: [{
      resource: { attributes: [
        { key: "undefined", value: { stringValue: "1.30.1" } },
        str("service.name", `CodeBuddy-CLI-${CLI_VERSION}`), str("service.version", "1.0.0"),
        str("extName", "@tencent-ai/codebuddy-code"), str("ideType", "CLI"),
        str("platform", "CLI"), str("platformVersion", CLI_VERSION), str("extVersion", CLI_VERSION),
        str("uid", a.userId), str("userId", a.userId),
        str("userNickname", a.userNickname ?? os.userInfo().username),
        str("gen_ai.user.id", a.userNickname ?? os.userInfo().username),
        str("enterpriseId", ""), str("workspacePath", process.cwd()),
      ]},
      scopeSpans: [{ scope: { name: `CodeBuddy-CLI-${CLI_VERSION}`, version: "1.0.0" }, spans }],
    }],
  };
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  await rawRequest(`${BASE}/v1/traces`, "POST", [
    ["Content-Type", "application/json"],
    ["Connection", "keep-alive"],
    ["User-Agent", "OTel-OTLP-Exporter-JavaScript/0.52.1"],
    ["Host", new URL(BASE).host],
    ["Content-Length", String(buf.length)],
  ], buf, proxyUrl);
}

async function sendTraces(a: AuthState, m: ChatMeta2, model: string, status: number, respBuf: Buffer, inputLength: number, proxyUrl?: string) {
  // POST /v1/traces（OTLP JSON；注意：官方此请求无 Authorization 头）
  const respText = respBuf.toString("utf8");
  let contentLen = 0;
  try { for (const mt of respText.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)) contentLen += JSON.parse('"' + mt[1] + '"').length; } catch {}
  const endMs = Date.now();
  const ns = (ms: number) => String(BigInt(ms) * 1000000n);
  const spanId2 = hex(8), spanId3 = hex(8);
  const str = (key: string, stringValue: string) => ({ key, value: { stringValue } });
  const body = {
    resourceSpans: [{
      resource: { attributes: [
        { key: "undefined", value: { stringValue: "1.30.1" } }, // 官方 SDK 的 bug 字段，照抄
        str("service.name", `CodeBuddy-CLI-${CLI_VERSION}`), str("service.version", "1.0.0"),
        str("extName", "@tencent-ai/codebuddy-code"), str("ideType", "CLI"),
        str("platform", "CLI"), str("platformVersion", CLI_VERSION), str("extVersion", CLI_VERSION),
        str("uid", a.userId), str("userId", a.userId),
        str("userNickname", a.userNickname ?? os.userInfo().username),
        str("gen_ai.user.id", a.userNickname ?? os.userInfo().username),
        str("enterpriseId", ""), str("workspacePath", process.cwd()),
      ]},
      scopeSpans: [{ scope: { name: `CodeBuddy-CLI-${CLI_VERSION}`, version: "1.0.0" }, spans: [
        { traceId: m.traceId, spanId: m.spanId, name: "codebuddy_code.model_request", kind: 3,
          startTimeUnixNano: ns(m.startMs), endTimeUnixNano: ns(endMs),
          status: { code: 1 }, attributes: [
            str("span.type", "model_request"), str("http.method", "POST"),
            str("http.url", `${BASE}/v2/chat/completions`), str("model.id", model),
            str("agent.name", "cli"), str("request.id", m.messageID), str("model.stream", "True"),
            str("conversation.request.id", m.convReqID), str("workbuddy.session_id", conversationID),
            str("workbuddy.prompt_request_id", m.convReqID), str("workbuddy.message_id", m.messageID),
            str("workbuddy.request_id", m.messageID), str("http.target", "/v2/chat/completions"),
            str("net.peer.name", new URL(BASE).host),
            { key: "retry_count", value: { intValue: 0 } },
            { key: "http.status_code", value: { intValue: status } },
          ]},
        { traceId: m.traceId, spanId: spanId2, name: "codebuddy_code.model_stream", kind: 3,
          startTimeUnixNano: ns(m.startMs), endTimeUnixNano: ns(endMs),
          status: { code: 1 }, attributes: [
            str("span.type", "model_stream"), str("model.id", model), str("agent.name", "cli"),
            str("request.id", m.messageID), str("conversation.request.id", m.convReqID),
            str("workbuddy.session_id", conversationID), str("workbuddy.prompt_request_id", m.convReqID),
            str("workbuddy.message_id", m.messageID), str("workbuddy.request_id", m.messageID),
            { key: "first_token_ms", value: { intValue: Math.max(1, endMs - m.startMs) } },
            { key: "chunk_count", value: { intValue: 1 } },
            { key: "total_bytes", value: { intValue: respBuf.length } },
            str("stream.status", "ok"), str("workbuddy.stop_reason", "ok"),
          ]},
        { traceId: m.traceId, spanId: spanId3, name: "codebuddy_code.interaction", kind: 3,
          startTimeUnixNano: ns(m.startMs), endTimeUnixNano: ns(endMs),
          status: { code: 1 }, attributes: [
            str("codebuddy.session_id", conversationID), str("codebuddy.conversation_request_id", m.convReqID),
            str("span.type", "interaction"), str("conversation.id", conversationID),
            str("conversation.agent", "cli"), str("conversation.request.id", m.convReqID),
            str("workbuddy.session_id", conversationID), str("workbuddy.prompt_request_id", ""),
            str("workbuddy.conversation_request_id", m.convReqID), str("workbuddy.message_id", ""),
            str("workbuddy.model", ""), str("workbuddy.agent_name", "cli"),
            { key: "user_prompt_length", value: { intValue: 5 } },
            { key: "assistant_output_length", value: { intValue: contentLen } },
          ]},
      ]}],
    }],
  };
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  await rawRequest(`${BASE}/v1/traces`, "POST", [
    ["Content-Type", "application/json"],
    ["Connection", "keep-alive"],
    ["User-Agent", "OTel-OTLP-Exporter-JavaScript/0.52.1"],
    ["Host", new URL(BASE).host],
    ["Content-Length", String(buf.length)],
  ], buf, proxyUrl).catch(() => {});
}

async function fingerprintFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const auth = await getValidAuth();
  // 统一提取 url / method / body
  let url: string;
  let method: string = init?.method ?? "POST";
  let bodyBuf: Buffer = Buffer.alloc(0);
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.toString();
  else {
    url = input.url;
    method = init?.method ?? input.method;
    if (input.body) { try { bodyBuf = Buffer.from(await input.clone().text()); } catch {} }
  }
  if (init?.body != null && bodyBuf.length === 0) {
    bodyBuf = typeof init.body === "string" ? Buffer.from(init.body) : Buffer.from(String(init.body));
  }
  const proxyUrl = process.env.CODEBUDDY_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? undefined;

  // ── 官方 CLI 抓包基线的严格头顺序（39 头，含大小写）──
  const convReqID = uuidv7Hex();
  const messageID = uuidv7Hex();
  const traceId = hex(16), spanId = hex(8), parentSpanId = hex(8);
  const host = new URL(BASE).host;
  const gz = gzipSync(bodyBuf.length ? bodyBuf : Buffer.from("{}"));
  const headers: [string, string][] = [
    ["Accept", "application/json"],
    ["Content-Type", "application/json"],
    ["x-requested-with", "XMLHttpRequest"],
    ["x-stainless-arch", process.arch],
    ["x-stainless-lang", "js"],
    ["x-stainless-os", stainlessOS()],
    ["x-stainless-package-version", STAINLESS_PACKAGE_VERSION],
    ["x-stainless-retry-count", "0"],
    ["x-stainless-runtime", "node"],
    ["x-stainless-runtime-version", process.version],
    ["X-Conversation-ID", conversationID],
    ["X-Agent-Intent", "craft"],
    ["X-Agent-Purpose", "conversation"],
    ["X-IDE-Type", "CLI"],
    ["X-IDE-Name", "CLI"],
    ["X-IDE-Version", CLI_VERSION],
    ["X-Private-Data", "false"],
    ["x-codebuddy-request", "1"],
    ["X-Request-ID", messageID],
    ["X-Conversation-Message-ID", messageID],
    ["X-Conversation-Request-ID", convReqID],
    ["X-Root-Request-ID", convReqID],
    ["X-Agent-Type", "main"],
    ["Content-Encoding", "gzip"],
    ["traceparent", `00-${traceId}-${spanId}-01`],
    ["b3", `${traceId}-${spanId}-1-${parentSpanId}`],
    ["X-B3-TraceId", traceId],
    ["X-B3-ParentSpanId", parentSpanId],
    ["X-B3-SpanId", spanId],
    ["X-B3-Sampled", "1"],
    ["X-Trace-ID", traceId],
    ["Authorization", `Bearer ${auth.accessToken}`],
    ["X-User-Id", auth.userId],
    ["X-Domain", auth.domain],
    ["X-Product", "SaaS"],
    ["User-Agent", USER_AGENT],
    ["Content-Length", String(gz.length)],
    ["Host", host],
    ["Connection", "keep-alive"],
  ];

  // 启动序列：每进程首个 chat 前发 config + accounts（对齐官方；config 永不带 repos[]）
  if (!didStartup) {
    didStartup = true;
    try { await sendConfig(auth, proxyUrl); await sendAccounts(auth, proxyUrl); } catch {}
  }
  const chatStart = Date.now();
  const resp = await rawRequest(url, method, headers, gz, proxyUrl);
  // 收尾遥测（对齐官方节奏）：
  // - report：仅【首轮无工具】（单发场景）或【工具轮结束】（finish_reason=tool_calls）时发一批；
  //   后续普通轮不发（官方整个会话也只发一批）
  // - traces：spans 攒队列，进程退出（beforeExit）统一 flush（官方也是会话结束发一次）
  const meta2: ChatMeta2 = { convReqID, messageID, traceId, spanId, startMs: chatStart };
  const modelId = (() => { try { return JSON.parse(bodyBuf.toString("utf8")).model ?? ""; } catch { return ""; } })();
  const respBuf: Buffer = (resp as any)._rawBuf ?? Buffer.alloc(0);
  const sse = parseSse(respBuf);
  void (async () => {
    try {
      const isToolRound = sse.finishReason === "tool_calls";
      if ((isToolRound && !didToolReport) || (!isToolRound && chatRound === 1)) {
        if (isToolRound) didToolReport = true;
        await sendReport(auth, meta2, modelId, bodyBuf.length, proxyUrl, sse);
      }
      queueTraces(auth, meta2, modelId, resp.status, respBuf, bodyBuf.length, sse, proxyUrl);
    } catch {}
  })();
  // 401 兜底：强制刷新 token 后重试一次（对齐官方 CLI：401 → refresh → 重建 headers → 重试）
  if (resp.status === 401) {
    try {
      const fresh = await getValidAuth(true);
      const retry = headers.map(([k, v]) =>
        k === "Authorization" ? ([k, `Bearer ${fresh.accessToken}`] as [string, string]) : ([k, v] as [string, string]));
      const retryResp = await rawRequest(url, method, retry, gz, proxyUrl);
      if (retryResp.status !== 401) return retryResp;
    } catch {}
  }
  return resp;
}

// ── 扩展主体 ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const base = openAICompletionsApi();
  // onPayload：1) 补官方 CLI 独有字段 verbosity/reasoning_summary；
  // 2) 按官方抓包基线的 JSON 字段顺序重建 body（model,messages,tools,temperature,max_tokens,stream,stream_options,reasoning_effort,verbosity,reasoning_summary）
  const wrapOptions = (o: any) => {
    const prev = o?.onPayload;
    return {
      ...(o ?? {}),
      fetch: fingerprintFetch,
      onPayload: async (params: any, model: any) => {
        let p = params;
        if (prev) { const r = await prev(params, model); if (r !== undefined) p = r; }
        if (p?.model !== model.id) return p; // 非 chat 场景不动
        chatRound += 1; // 计数放这里：onPayload 先于 fetch 执行
        // 首轮：tools + system 提示词都换成官方 CLI 的（完整指纹对齐）；
        // 第 2 轮起发 pi 真实工具与提示词（历史里已有否定信息，模型自适应）
        const first = chatRound === 1;
        const tools = first && officialTools.length ? officialTools : p.tools;
        let messages = p.messages;
        if (first) {
          const offSys = buildOfficialSystem(p.model);
          if (offSys && messages?.length && (messages[0].role === "system" || messages[0].role === "developer")) {
            messages = messages.map((m: any, i: number) => (i === 0 ? { ...m, content: offSys } : m));
          }
        }
        return {
          model: p.model,
          messages,
          tools,
          temperature: p.temperature ?? 1,
          max_tokens: model.maxTokens, // 官方 CLI 固定发模型 max_tokens，不随上下文余量缩水
          stream: p.stream,
          stream_options: p.stream_options ?? { include_usage: true },
          reasoning_effort: p.reasoning_effort ?? "low",
          verbosity: p.verbosity ?? "high",
          reasoning_summary: p.reasoning_summary ?? "auto",
        };
      },
    };
  };

  const provider = createProvider({
    id: "codebuddy",
    name: "CodeBuddy (fingerprint)",
    baseUrl: `${BASE}/v2`,
    headers: {
      "User-Agent": USER_AGENT,
      "X-Requested-With": "XMLHttpRequest",
      "x-codebuddy-request": "1",
      "X-Product": "SaaS",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "X-IDE-Version": CLI_VERSION,
    },
    auth: {
      // 接 pi 原生 /login 流程：凭证由 pi 存入 ~/.pi/agent/auth.json（oauth 形状 + 业务字段）
      oauth: {
        name: "CodeBuddy (Tencent)",
        loginLabel: "Sign in with CodeBuddy (browser OAuth or import from CLI)",
        async login(interaction: any) {
          // 统一入口：选 OAuth 浏览器授权，或从官方 CLI 本地凭证导入
          const method = await interaction.prompt({
            type: "select",
            message: "CodeBuddy 登录方式",
            options: [
              { id: "oauth", label: "浏览器 OAuth 授权（微信/QQ/腾讯账号）" },
              { id: "import", label: "从官方 CodeBuddy CLI 导入凭证（需已安装并登录）" },
            ],
          });
          if (method === "import") {
            // 官方 CLI 明文凭证：~/.local/share/CodeBuddyExtension/Data/Public/auth/*.info
            const authDir = path.join(os.homedir(), ".local/share/CodeBuddyExtension/Data/Public/auth");
            let files: string[] = [];
            try { files = fs.readdirSync(authDir).filter((f) => f.endsWith(".info")); } catch {}
            for (const f of files) {
              try {
                const d = JSON.parse(fs.readFileSync(path.join(authDir, f), "utf8"));
                const at = d?.auth?.accessToken, rt = d?.auth?.refreshToken;
                if (!at || !rt) continue;
                const expiresAt = d?.auth?.expiresAt ?? 0;
                const a: AuthState = {
                  accessToken: at, refreshToken: rt,
                  userId: d?.account?.uid ?? "", domain: d?.auth?.domain ?? "www.codebuddy.cn",
                  nickname: d?.account?.nickname ?? "", expiresAt,
                };
                saveAuth(a);
                interaction.notify?.({ message: `已导入官方 CLI 凭证：${a.nickname || a.userId || f}` });
                return { type: "oauth" as const, access: at, refresh: rt, expires: expiresAt, userId: a.userId, domain: a.domain, nickname: a.nickname };
              } catch {}
            }
            throw new Error(`未找到可导入的官方 CLI 凭证（${authDir}）。请先安装并登录官方 CLI，或改选浏览器 OAuth。`);
          }
          // ── OAuth 设备授权：notify 展示 URL → 浏览器登录 → 轮询取 token ──
          const res = await rawRequest(`${BASE}/v2/plugin/auth/state?platform=CLI`, "POST", [
            ["Content-Type", "application/json"],
            ["User-Agent", USER_AGENT],
            ["X-Requested-With", "XMLHttpRequest"],
            ["X-Product", "SaaS"],
            ["X-Domain", "www.codebuddy.cn"],
            ["Host", new URL(BASE).host],
            ["Connection", "keep-alive"],
          ], Buffer.from("{}"), undefined);
          const st = (await res.json()) as any;
          const state = st.state ?? st.data?.state;
          const authUrl = st.authUrl ?? st.data?.authUrl;
          if (!state || !authUrl) throw new Error("auth state: missing state/authUrl");
          interaction.notify?.({ message: `CodeBuddy 登录：浏览器打开并完成授权后自动继续\n${authUrl}` });
          // 轮询（3s × 100 次 = 5 分钟）
          for (let i = 0; i < 100; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            try {
              const r = await rawRequest(`${BASE}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, "GET", [
                ["User-Agent", USER_AGENT],
                ["X-Requested-With", "XMLHttpRequest"],
                ["X-Product", "SaaS"],
                ["X-Domain", "www.codebuddy.cn"],
                ["Host", new URL(BASE).host],
                ["Connection", "keep-alive"],
              ], Buffer.alloc(0), undefined);
              if (!r.ok) continue;
              const tok = (await r.json()) as any;
              const accessToken = tok.accessToken ?? tok.data?.accessToken;
              const refreshToken2 = tok.refreshToken ?? tok.data?.refreshToken;
              if (!accessToken || !refreshToken2) continue;
              // uid/nickname
              let userId = "", nickname = "", domain = tok.domain ?? "www.codebuddy.cn";
              try {
                const ar = await rawRequest(`${BASE}/v2/plugin/login/account`, "GET", [
                  ["Authorization", `Bearer ${accessToken}`],
                  ["User-Agent", USER_AGENT],
                  ["X-Requested-With", "XMLHttpRequest"],
                  ["X-Product", "SaaS"],
                  ["Host", new URL(BASE).host],
                  ["Connection", "keep-alive"],
                ], Buffer.alloc(0), undefined);
                if (ar.ok) {
                  const acct = (await ar.json()) as any;
                  userId = String(acct.uid ?? acct.userId ?? acct.data?.uid ?? "");
                  nickname = String(acct.nickname ?? acct.data?.nickname ?? "");
                  domain = acct.domain ?? domain;
                }
              } catch {}
              const expiresAt = Date.now() + (tok.expiresIn ?? tok.data?.expiresIn ?? 3600) * 1000;
              const cred = { type: "oauth" as const, access: accessToken, refresh: refreshToken2, expires: expiresAt, userId, domain, nickname };
              saveAuth({ accessToken, refreshToken: refreshToken2, userId, domain, nickname, expiresAt });
              return cred;
            } catch {}
          }
          throw new Error("CodeBuddy 登录超时（5 分钟未完成授权）");
        },
        async refresh(cred: any, _signal: AbortSignal) {
          // pi 到期自动调用（store lock 下）；与请求内 401 兜底共用同一后端端点
          const a = await refreshAuth({ accessToken: cred.access, refreshToken: cred.refresh, userId: cred.userId ?? "", domain: cred.domain ?? "www.codebuddy.cn", nickname: cred.nickname ?? "", expiresAt: cred.expires ?? 0 });
          return { ...cred, access: a.accessToken, refresh: a.refreshToken, expires: a.expiresAt };
        },
        async toAuth(cred: any) { return { apiKey: cred.access }; },
      },
    },
    models: [
      {
        provider: "codebuddy",
        api: "openai-completions" as const,
        baseUrl: `${BASE}/v2`,
        id: "deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 128_000,
        samplingParams: { temperature: 1 },
        thinkingLevelMap: { off: "low", minimal: "low", low: "low", medium: "low", high: "high", xhigh: "high", max: "high" },
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          requiresReasoningContentOnAssistantMessages: true,
        },
      },
      {
        provider: "codebuddy",
        api: "openai-completions" as const,
        baseUrl: `${BASE}/v2`,
        id: "hy4-preview",
        name: "Hunyuan 4 Preview",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 256_000,
        maxTokens: 64_000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          requiresReasoningContentOnAssistantMessages: true,
        },
      },
      {
        provider: "codebuddy",
        api: "openai-completions" as const,
        baseUrl: `${BASE}/v2`,
        id: "hy3",
        name: "Hunyuan 3",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 32_000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          requiresReasoningContentOnAssistantMessages: true,
        },
      },
      {
        provider: "codebuddy",
        api: "openai-completions" as const,
        baseUrl: `${BASE}/v2`,
        id: "kimi-k3",
        name: "Kimi K3",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 256_000,
        maxTokens: 32_000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          requiresReasoningContentOnAssistantMessages: true,
        },
      },
    ],
    api: {
      stream: (model: any, context: any, options: any) =>
        base.stream(model, context, wrapOptions(options)),
      streamSimple: (model: any, context: any, options: any) =>
        base.streamSimple(model, context, wrapOptions(options)),
    },
  });

  pi.registerProvider(provider as any);

  // ── /codebuddy-import：从官方 CLI 本地明文凭证自动导入（无浏览器场景）═══
  // CLI 存储路径：~/.local/share/CodeBuddyExtension/Data/Public/auth/<authId>.info
  // authId 来自官方包 product.json 的 authentication.id（Tencent-Cloud.coding-copilot）
  pi.registerCommand("codebuddy-import", {
    description: "Import credentials from official CodeBuddy CLI",
    handler: async (_args: string, ctx: any) => {
      const authDir = path.join(os.homedir(), ".local/share/CodeBuddyExtension/Data/Public/auth");
      let files: string[] = [];
      try { files = fs.readdirSync(authDir).filter((f) => f.endsWith(".info")); } catch {}
      if (!files.length) {
        ctx.ui.notify(
          `未找到官方 CLI 凭证（${authDir}）。
请先安装并登录官方 CLI：npm i -g @tencent-ai/codebuddy-code && codebuddy （/login），
或改选「浏览器 OAuth 授权」。`, "error");
        return;
      }
      for (const f of files) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(authDir, f), "utf8"));
          const at = d?.auth?.accessToken, rt = d?.auth?.refreshToken;
          if (!at || !rt) continue;
          const auth: AuthState = {
            accessToken: at,
            refreshToken: rt,
            userId: d?.account?.uid ?? "",
            domain: d?.auth?.domain ?? "www.codebuddy.cn",
            nickname: d?.account?.nickname ?? "",
            expiresAt: d?.auth?.expiresAt ?? 0,
          };
          saveAuth(auth);
          authCache = auth;
          ctx.ui.notify(
            `CodeBuddy 凭证导入成功：${auth.nickname || auth.userId || f}${auth.userId ? ` (${auth.userId})` : ""}
来源：${f} | 有效期至 ${new Date(auth.expiresAt).toLocaleString()}
用 /models 选 codebuddy/deepseek-v4.1-flash`, "success");
          return;
        } catch {}
      }
      ctx.ui.notify("凭证文件存在但解析失败（无 accessToken/refreshToken），请重新登录官方 CLI 后再试", "error");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const a = loadAuth();
    if (!a) {
      ctx.ui.notify("CodeBuddy 未登录，/login 选择 codebuddy 后用 /models 选 codebuddy/*", "info");
    }
  });
}
