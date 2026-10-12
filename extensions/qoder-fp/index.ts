/**
 * Qoder 指纹全量模拟 Provider（pi extension）
 *
 * 依据对 Qoder CLI 1.1.63 的真实抓包（/tmp/qoder-capture.flow）与协议还原，逐字段复刻出网指纹：
 *
 * - POST https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
 * - UA: Bun/1.4.2
 * - 24 个保序 Cosy 族请求头（Cosy-Key, Cosy-User, Cosy-MachineId, Cosy-MachineOS 等）
 * - 密码学签名：RSA-1024 + AES-128-CBC + MD5 组装 Authorization: Bearer COSY.<payload>.<sig>
 * - 请求体编码：自定义 64 字符 Base64 字母表 + swapBodyOuterThirds 前后 1/3 对调
 * - 响应协议：SSE 外层解构，提取内层 OpenAI chat.completion.chunk，透传 reasoning_content 与 content
 *
 * 登录与凭证：
 * - pi 原生 /login 选 qoder，通过官方标准 Device Flow 浏览器授权
 * - 凭据存入 pi 原生库 ~/.pi/agent/auth.json（qoder 键，oauth 格式，mode 0600）
 * - 支持请求内 401 自动刷新重试与到期刷新（POST /api/v1/jobToken/refresh）
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { encodeRequestBody } from "./codec.ts";
import { buildCosyHeaders, type QoderUser } from "./cosy.ts";
import {
  MAX_QUEUE_RECOVERIES,
  POLL_TIMEOUT_MS,
  QUEUE_FINISH_PATH,
  QUEUE_STATUS_PATH,
  buildQueueFinishBody,
  createQueueTelemetry,
  createQueueStatusSinks,
  setHeader,
  queueFailureReason,
  decodeQueueError,
  formatQueueView,
  parseQueueStatus,
  resolveMaxWaitMs,
  waitInQueue,
  type QueueSignal,
  type QueueStatusFetch,
  type QueueView,
} from "./queue.ts";

// ── 常量定义 ─────────────────────────────────────────────────────────────────

const OPENAPI_BASE = "https://openapi.qoder.sh";
const INFER_BASE = "https://api1.qoder.sh";
const DEVICE_FLOW_HOST = "https://qoder.com";
const CLIENT_ID = "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa";
const REDIRECT_URI = "qoder-app://";
const CHAT_ENDPOINT =
  `${INFER_BASE}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;

// 官方工具与系统词定义（抓包提取）
let officialTools: any[] = [];
try {
  officialTools = JSON.parse(
    fs.readFileSync(path.join(__dirname, "official-tools.json"), "utf8")
  );
} catch {}

let officialSystem: any[] = [];
try {
  officialSystem = JSON.parse(
    fs.readFileSync(path.join(__dirname, "official-system.json"), "utf8")
  );
} catch {}

/**
 * 尽力复制到系统剪贴板。逐个尝试常见的 Wayland/X11/macOS 后端，
 * 都没有就返回 false（不抛错，剪贴板只是锦上添花）。
 */
function copyToClipboard(text: string): boolean {
  const backends: Array<[string, string[]]> = [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
    ["pbcopy", []],
  ];
  for (const [cmd, args] of backends) {
    try {
      execFileSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
      return true;
    } catch {
      // 该后端不存在或失败，试下一个
    }
  }
  return false;
}

/**
 * OSC 8 超链接：把可点击目标放进转义载荷，显示文本另计。
 * 这样链接再长也不会被折行截断——折行只影响“看得见的文字”，不影响真实 URL。
 */
function osc8(url: string, label: string): string {
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
}

/**
 * 展示 Device Flow 授权链接。
 *
 * 链接约 285 字符，在 TUI 里必然折行成 3~4 个视觉行；Ctrl+点击的超链接识别
 * 只按视觉行截取，于是用户拿到的 URL 必然残缺、授权页打不开。
 * 解法是把可点击目标和显示文本解耦：用 OSC 8 把完整 URL 放进转义载荷，
 * 界面上只显示一行短标签。折行只影响看得见的文字，不影响真实 URL。
 * 另外尽力复制一份到剪贴板，供不方便点击时直接 Ctrl+V。
 */
function emitLoginUrl(url: string): string {
  const copied = copyToClipboard(url);

  const lines = ["请在浏览器中打开以下链接授权 Qoder 登录（5 分钟内有效）："];
  lines.push(osc8(url, "▶ 点击打开授权页"));
  if (copied) {
    lines.push("已复制到剪贴板：浏览器地址栏 Ctrl+V 即可。");
  }

  // 仅拼装文案，由调用方统一 notify 一次
  return lines.join("\n");
}

function piAuthFile(): string {
  try {
    const { getAgentDir } = require("@earendil-works/pi-coding-agent");
    return path.join(getAgentDir(), "auth.json");
  } catch {
    return path.join(os.homedir(), ".pi/agent/auth.json");
  }
}

function getLocalMachineId(): string {
  try {
    const p = path.join(os.homedir(), ".qoder/.auth/machine_id");
    if (fs.existsSync(p)) {
      const mid = fs.readFileSync(p, "utf8").trim();
      if (mid) return mid;
    }
  } catch {}
  try {
    const p2 = "/etc/machine-id";
    if (fs.existsSync(p2)) {
      const mid = fs.readFileSync(p2, "utf8").trim();
      if (mid) return mid;
    }
  } catch {}
  return crypto.randomUUID();
}

const machineId = getLocalMachineId();

// ── 凭证管理 ─────────────────────────────────────────────────────────────────

export interface AuthState {
  accessToken: string; // jobToken (jt-...)
  refreshToken: string;
  userId: string;
  expiresAt: number; // ms
  email?: string;
  username?: string;
  deviceToken?: string;
}

function loadAuth(): AuthState | null {
  try {
    const store = JSON.parse(fs.readFileSync(piAuthFile(), "utf8"));
    const q = store?.qoder;
    if (q?.access && (q?.userId || q?.uid)) {
      return {
        accessToken: q.access,
        refreshToken: q.refresh ?? "",
        userId: q.userId ?? q.uid ?? "",
        expiresAt: q.expires ?? 0,
        email: q.email ?? "",
        username: q.username ?? "",
        deviceToken: q.deviceToken,
      };
    }
  } catch {}
  return null;
}

function saveAuth(a: AuthState) {
  const f = piAuthFile();
  let store: Record<string, unknown> = {};
  try {
    store = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {}
  store.qoder = {
    type: "oauth",
    access: a.accessToken,
    refresh: a.refreshToken,
    expires: a.expiresAt,
    userId: a.userId,
    email: a.email,
    username: a.username,
    deviceToken: a.deviceToken,
  };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(store, null, 2), { mode: 0o600 });
}

let refreshInFlight: Promise<AuthState> | null = null;

async function refreshAuth(a: AuthState): Promise<AuthState> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      if (!a.refreshToken) {
        throw new Error("Qoder refresh token 缺失，请重新登录");
      }
      const proxyUrl =
        process.env.QODER_PROXY ??
        process.env.HTTPS_PROXY ??
        process.env.HTTP_PROXY ??
        undefined;
      const res = await rawRequest(
        `${OPENAPI_BASE}/api/v1/jobToken/refresh`,
        "POST",
        [
          ["Accept", "application/json"],
          ["Content-Type", "application/json"],
          ["Host", new URL(OPENAPI_BASE).host],
          ["Connection", "close"],
        ],
        Buffer.from(JSON.stringify({ refresh_token: a.refreshToken })),
        proxyUrl
      );
      if (!res.ok) {
        throw new Error(`Qoder token refresh failed: HTTP ${res.status}`);
      }
      const j = (await res.json()) as any;
      const next: AuthState = {
        ...a,
        accessToken: j.token ?? a.accessToken,
        refreshToken: j.refresh_token ?? a.refreshToken,
        expiresAt: Date.now() + 24 * 3600 * 1000,
      };
      saveAuth(next);
      authCache = next;
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
  if (!authCache) {
    throw new Error("Qoder 未登录：请先 /login 选择 qoder，或使用 /qoder-login");
  }
  if (force || (authCache.expiresAt > 0 && Date.now() > authCache.expiresAt - 120_000)) {
    authCache = await refreshAuth(authCache);
  }
  return authCache;
}

// ── 传输层：node:https 原始保序请求 ──────────────────────────────────────────

function tunnelViaProxy(proxyUrl: string, host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const u = new URL(proxyUrl);
    const req = http.request({
      host: u.hostname,
      port: Number(u.port || 80),
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}`, "Proxy-Connection": "keep-alive" },
    });
    req.once("connect", (res: any, socket: net.Socket) => {
      if (res.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: ${res.statusCode}`));
      }
    });
    req.once("error", reject);
    req.end();
  });
}

export async function rawRequest(
  urlStr: string,
  method: string,
  headerPairs: [string, string][],
  body: Buffer,
  proxyUrl?: string,
  signal?: AbortSignal
): Promise<Response> {
  const u = new URL(urlStr);
  const port = Number(u.port || 443);
  let tlsSock: tls.TLSSocket | undefined;
  if (proxyUrl) {
    const raw = await tunnelViaProxy(proxyUrl, u.hostname, port);
    tlsSock = tls.connect({ socket: raw, servername: u.hostname, rejectUnauthorized: true });
    await new Promise<void>((res, rej) => {
      tlsSock!.once("secureConnect", res);
      tlsSock!.once("error", rej);
    });
  }
  return new Promise((resolve, reject) => {
    const opts: any = {
      host: u.hostname,
      port,
      method,
      path: u.pathname + u.search,
      headers: headerPairs,
      agent: false,
    };
    if (tlsSock) opts.createConnection = () => tlsSock!;
    const req = https.request(opts, (res: any) => {
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          res.on("data", (c: Buffer) => {
            ctrl.enqueue(new Uint8Array(c));
          });
          res.on("end", () => {
            try { ctrl.close(); } catch {}
          });
          res.on("error", (e: unknown) => {
            try { ctrl.error(e); } catch {}
          });
        },
        cancel() {
          try { res.destroy(); } catch {}
        },
      });
      const resp = new Response(stream, {
        status: res.statusCode ?? 502,
        headers: new Headers(res.headers as Record<string, string>),
      });
      resolve(resp);
    });
    if (signal) {
      const onAbort = () => {
        try { req.destroy(signal.reason); } catch {}
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    req.once("error", reject);
    if (body.length) req.write(body);
    req.end();
  });
}

// ── 上游瞬时错误（排队/容量）处理 ───────────────────────────────────────────

/** 上游繁忙时的恢复次数：对齐官方 bve = 10（Qwen3.8-Flash 为 0× 免费池，争抢激烈）。 */
const MAX_QUEUE_RETRIES = MAX_QUEUE_RECOVERIES;

/** 通知通道：在 TUI 里走ui.notify，headless 下退回 stderr。 */
let statusNotify: ((message: string) => void) | null = null;
function notifyStatus(message: string): void {
  if (statusNotify) {
    try { statusNotify(message); return; } catch {}
  }
  try { console.error(`[qoder-fp] ${message}`); } catch {}
}

/**
 * 解开 Qoder 上游错误并判定是否可自愈。
 *
 * 上游会把同一个错误**反复**包进 message 字符串里，实测三层：
 *   {"code":"403","message":"{\"code\":\"10605\",\"message\":\"{\"isQueued\":true,...}\"}"}
 * 最外层 code 是 403，真正指示排队的 10605 在第二层，可用信号在第三层。
 * 只剥两层会误判成「永久错误」，所以用 queue.ts 里那份剥到信号出现为止的实现。
 * 403 签名错误、401 认证等没有排队信号，属于永久错误，不能重试。
 */
function decodeUpstreamError(body: string): { codes: string[]; detail?: QueueSignal; raw: string } {
  return decodeQueueError(body);
}

/**
 * 构造一个非 2xx 响应，用于「重试耗尽」这类终态。
 *
 * 为什么不用 throw：pi-ai 会把 fetch 的抛异常包成 APIConnectionError，
 * 其 message 被写死为 "Connection error."（我们的原文只进 cause 被丢弃），
 * 而 "connection error" 正好命中 pi 的可重试正则，于是 pi 会叠加一层
 * 全局重试，两层重试相乘把等待拖到数分钟。
 *
 * 返回普通 400 响应则能让 pi-ai 把 error.message 原样透出，
 * 该文本不命中任何可重试特征，于是只有本插件自己重试。
 * 状态码刻意避开 429/5xx，那些同样在 pi 的可重试列表里。
 */
function upstreamBusyResponse(message: string): Response {
  // 用 text/plain：pi-ai 对 JSON 体是整块转储的，只有纯文本才能干净地透出
  return new Response(message, {
    status: 400,
    statusText: "Bad Request",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** 可被 AbortSignal 打断的 sleep。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 偷看响应的第一个 SSE 信封，判断是否为瞬时排队错误。
 *
 * 错误是裹在 SSE 信封里的（HTTP 层已 200），且下游 transformQoderSseResponse
 * 在读到第一个信封时就已经往下游转发内容了，所以不能在那里重试。
 * 这里用 tee() 分一路出来做前置探测，探测完把完整流重新包好交还给调用方。
 */
async function peekQueueError(
  resp: Response
): Promise<{
  response: Response;
  codes: string[];
  queue?: QueueSignal;
}> {
  const headers = { "Content-Type": "text/event-stream; charset=utf-8" };
  if (!resp.body) return { response: resp, codes: [] };

  const [probe, rest] = resp.body.tee();
  const reader = probe.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  let codes: string[] = [];
  let queue: QueueSignal | undefined;

  try {
    // 只需读到第一个信封，最多兜 64 KiB
    while (acc.length < 64 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      const m = acc.match(/data:\s*(\{[^\n]*\})/);
      if (!m) continue;
      try {
        const envelope = JSON.parse(m[1]);
        if (envelope?.statusCodeValue && envelope.statusCodeValue >= 400) {
          const decoded = decodeUpstreamError(
            typeof envelope.body === "string" ? envelope.body : JSON.stringify(envelope.body ?? {})
          );
          codes = decoded.codes;
          queue = decoded.detail;
        }
      } catch {}
      break; // 第一个信封就是它，够了
    }
  } catch {
    // 探测失败不阻断主流程，按“没有瞬时错误”处理
  } finally {
    try { reader.cancel(); } catch {}
  }

  return {
    response: new Response(rest, { status: resp.status, statusText: resp.statusText, headers }),
    codes,
    queue,
  };
}

// ── 官方排队状态轮询（GET /api/v2/service/ask/queue/status）──────────────────

/** 官方在 chat 请求之外独立签名的 GET：Accept 是 application/json，不是 SSE。 */
async function pollQueueStatus(
  user: QoderUser,
  params: {
    requestSetId: string;
    modelKey: string;
    queueType?: string;
    signal?: AbortSignal;
    timeoutMs: number;
  }
): Promise<QueueSignal> {
  const proxyUrl =
    process.env.QODER_PROXY ??
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY ??
    undefined;

  const qs = new URLSearchParams();
  qs.set("requestSetId", params.requestSetId);
  qs.set("modelKey", params.modelKey);
  if (params.queueType) qs.set("queueType", params.queueType);
  const url = `${INFER_BASE}${QUEUE_STATUS_PATH}?${qs.toString()}`;

  // 官方 `yve`：单次轮询超时，且不得超过剩余预算
  const timeout = Math.max(0, Math.min(POLL_TIMEOUT_MS, params.timeoutMs));
  if (timeout <= 0) {
    throw Object.assign(new Error("model queue status request timed out"), {
      queue_fatal: true,
    });
  }

  // 官方在这个 GET 上单独做一次 401/403 强制刷新重试（Eve 的 for(let l=0;l<2;l++) 循环）
  let current = user;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("queue status timeout")), timeout);
    const signal = params.signal
      ? AbortSignal.any([params.signal, controller.signal])
      : controller.signal;

    try {
      const headers = setHeader(
        buildCosyHeaders(url, current, "", machineId),
        "accept",
        "application/json"
      );
      const resp = await rawRequest(url, "GET", headers, Buffer.alloc(0), proxyUrl, signal);
      const body = await resp.text().catch(() => "");

      if (resp.status === 401 || resp.status === 403) {
        if (attempt === 0) {
          // 官方：强制刷新 token 后原样重试一次（不再改变 requestSetId）
          const fresh = await getValidAuth(true);
          current = {
            uid: fresh.userId,
            token: fresh.accessToken,
            email: fresh.email,
            name: fresh.username,
          };
          continue;
        }
        throw Object.assign(new Error(`model queue status auth error: HTTP ${resp.status}`), {
          queue_auth: true,
        });
      }
      if (resp.status === 404) {
        // 官方把 404 视为端点不可用且**立即失败**（queue_endpoint_unavailable）
        throw Object.assign(new Error("model queue status endpoint unavailable"), {
          queue_endpoint_unavailable: true,
        });
      }
      if (!resp.ok) {
        throw new Error(`model queue status request failed: HTTP ${resp.status}`);
      }

      const parsed = parseQueueStatus(body);
      if (!parsed) {
        throw Object.assign(new Error("model queue status response is invalid"), {
          queue_endpoint_unavailable: true,
        });
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }
  throw Object.assign(new Error("model queue status request failed after auth retry"), {
    queue_auth: true,
  });
}

/**
 * 归还排队租约（POST /api/v2/service/ask/finish）。
 *
 * 官方在 turn 收尾时对本 turn 用过的所有 requestSetId 各发一次；失败只告警，
 * 因为服务端 TTL 到期也会释放。这里同样做成尽力而为。
 */
async function releaseQueueLease(params: {
  modelKey: string;
  requestSetId: string;
  timeConsumedMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  const auth = await getValidAuth().catch(() => null);
  if (!auth) return;
  const user: QoderUser = {
    uid: auth.userId,
    token: auth.accessToken,
    email: auth.email,
    name: auth.username,
  };

  const proxyUrl =
    process.env.QODER_PROXY ??
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY ??
    undefined;

  const url = `${INFER_BASE}${QUEUE_FINISH_PATH}`;
  // 原子：finish 与 chat 一样是 `?Encode=1`，体必须过自定义 Base64。
  // 明文 JSON 实测返回 500 Internal Server Error，所以这里不能省 encodeRequestBody。
  const wireBody = buildQueueFinishBody({
    encodeRequestBody,
    modelKey: params.modelKey,
    requestSetId: params.requestSetId,
    userId: auth.userId,
    timeConsumedMs: params.timeConsumedMs,
  });

  // 注意：buildCosyHeaders 已带 Content-Type / Accept，这里只能覆写，
  // 不能再 push 一份 —— 重复头会让上游返回 500（伪装成服务端故障，极难归因）。
  const headers = setHeader(
    setHeader(buildCosyHeaders(url, user, wireBody, machineId), "accept", "application/json"),
    "content-type",
    "application/json"
  );

  const resp = await rawRequest(
    url,
    "POST",
    headers,
    Buffer.from(wireBody, "utf8"),
    proxyUrl,
    params.signal
  );
  const respBody = await resp.text().catch(() => "");
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${respBody.slice(0, 200)}`);
  }
}

/** 本 turn 内进入过排队的 requestSetId，用于 turn 结束时归还租约。 */
const touchedRequestSets = new Map<string, number>();

function noteQueuedRequestSet(requestSetId: string): void {
  if (!touchedRequestSets.has(requestSetId)) {
    touchedRequestSets.set(requestSetId, Date.now());
  }
}

/** 把一帧排队状态画到状态栏（TUI 有 ui 时）。 */
let queueStatusSink: ((text: string | undefined) => void) | null = null;
function renderQueueView(view: QueueView): void {
  if (queueStatusSink) {
    try {
      queueStatusSink(formatQueueView(view));
      return;
    } catch {}
  }
  notifyStatus(formatQueueView(view));
}

// ── SSE 响应解包转换 ─────────────────────────────────────────────────────────

function transformQoderSseResponse(rawResp: Response): Response {
  if (!rawResp.body) return rawResp;
  const reader = rawResp.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let isClosed = false;

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (!isClosed) {
              isClosed = true;
              try { controller.enqueue(encoder.encode("data: [DONE]\n\n")); } catch {}
              try { controller.close(); } catch {}
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            if (!dataStr) continue;

            if (dataStr === "[DONE]") {
              if (!isClosed) {
                isClosed = true;
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              }
              try { reader.cancel(); } catch {}
              return;
            }

            try {
              const outer = JSON.parse(dataStr);
              if (outer.body === "[DONE]") {
                if (!isClosed) {
                  isClosed = true;
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                }
                try { reader.cancel(); } catch {}
                return;
              }

              // 检查上游错误（如 403 Forbidden / Signature invalid 等）
              if (outer.statusCodeValue && outer.statusCodeValue >= 400) {
                const errObj = typeof outer.body === "string" ? JSON.parse(outer.body) : outer.body;
                throw new Error(`Qoder upstream error: ${errObj?.message || outer.statusCode}`);
              }

              // 外层结构: {"headers":..., "body": "{\"choices\":[...]}", "statusCodeValue": 200}
              if (typeof outer.body === "string" && outer.body.length > 0) {
                controller.enqueue(encoder.encode(`data: ${outer.body}\n\n`));

                // 检查内层是否已经结束 (finish_reason)
                try {
                  const inner = JSON.parse(outer.body);
                  if (inner.choices?.[0]?.finish_reason === "stop") {
                    // 内层已正常结束，发送结束标志并优雅断开连接
                    if (!isClosed) {
                      isClosed = true;
                      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                      controller.close();
                    }
                    try { reader.cancel(); } catch {}
                    return;
                  }
                } catch {}
              }
            } catch (e: any) {
              if (e.message?.startsWith("Qoder upstream error")) {
                throw e;
              }
              // 忽略解析失败的非标准元数据行（如 firstTokenDuration）
            }
          }
        }
      } catch (err) {
        if (!isClosed) {
          try { controller.error(err); } catch {}
        }
      }
    },
    cancel() {
      try { reader.cancel(); } catch {}
    },
  });

  return new Response(readable, {
    status: rawResp.status,
    statusText: rawResp.statusText,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ── 请求包装器与指纹 fetch ───────────────────────────────────────────────────

let chatRound = 0;

interface ChatIds {
  requestId: string;
  requestSetId: string;
}

function newChatIds(): ChatIds {
  return {
    requestId: crypto.randomUUID().replace(/-/g, ""),
    requestSetId: crypto.randomUUID().replace(/-/g, ""),
  };
}

async function doChat(
  authUser: QoderUser,
  openAiBody: any,
  proxyUrl?: string,
  signal?: AbortSignal,
  ids: ChatIds = newChatIds()
): Promise<Response> {
  chatRound++;
  const modelDisplayName = openAiBody.model?.includes("max")
    ? "Qwen3.8-Max"
    : "Qwen3.8-Flash";

  // 首轮注入官方工具与系统词（长得像官方 CLI）；后续使用 pi 传入的真实工具
  const isFirst = chatRound === 1;
  const tools = isFirst && officialTools.length ? officialTools : (openAiBody.tools ?? []);

  const inputMessages: any[] = [];
  for (const m of openAiBody.messages ?? []) {
    let content = m.content;
    if (typeof content === "string") {
      content = [{ type: "text", text: content }];
    }
    inputMessages.push({ ...m, content });
  }

  const systemPrompt = isFirst && officialSystem.length
    ? officialSystem
    : [{ type: "text", text: "You are Qoder. Use the instructions below and the tools available to you to assist the user." }];

  // 动态处理思考级别（支持 none/off 关闭思考，及 low/medium/high/xhigh/max）
  const rawEffort = openAiBody.reasoning_effort;
  const isNone = rawEffort === "none" || rawEffort === "off" || rawEffort === "disabled";
  const reasoningEffort = isNone ? "none" : (rawEffort ?? "medium");
  const enableThinking = !isNone;

  const qoderBody = {
    // request_set_id 必须与排队轮询用的一致：服务端按它登记/查询排队条目
    request_id: ids.requestId,
    request_set_id: ids.requestSetId,
    chat_record_id: crypto.randomUUID().replace(/-/g, ""),
    session_id: crypto.randomUUID().replace(/-/g, ""),
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    agent_id: "agent_common",
    task_id: "common",
    session_type: "qodercli",
    aliyun_user_type: "",
    model_config: {
      key: "qfmodel",
      display_name: modelDisplayName,
      model: "",
      format: "openai",
      is_vl: true,
      is_reasoning: enableThinking,
      api_key: "",
      url: "",
      source: "system",
      max_input_tokens: 180000,
    },
    system: systemPrompt,
    messages: inputMessages,
    tools,
    parameters: {
      max_tokens: openAiBody.max_tokens ?? 32000,
      reasoning_effort: reasoningEffort,
      enable_thinking: enableThinking,
    },
    business: {
      product: "cli",
      version: "1.1.63",
      type: "agent",
      id: crypto.randomUUID().replace(/-/g, ""),
      name: "pi session",
      begin_at: Date.now(),
      stage: "start",
    },
  };

  const wireBody = encodeRequestBody(JSON.stringify(qoderBody));
  const headers = buildCosyHeaders(CHAT_ENDPOINT, authUser, wireBody, machineId);

  return rawRequest(
    CHAT_ENDPOINT,
    "POST",
    headers,
    Buffer.from(wireBody, "utf8"),
    proxyUrl,
    signal
  );
}

async function fingerprintFetch(input: any, init?: any): Promise<Response> {
  const proxyUrl =
    process.env.QODER_PROXY ??
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY ??
    undefined;

  const auth = await getValidAuth();
  const authUser: QoderUser = {
    uid: auth.userId,
    token: auth.accessToken,
    email: auth.email,
    name: auth.username,
  };

  const openAiBody = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? {};

  /**
   * 发一次请求；若命中服务端容量队列，则按官方算法轮询等待后重发。
   *
   * 官方语义：排队不是「本地重试」，而是「等服务端放行」——
   * 客户端只按服务端下发的 retryAfterSeconds 轮询 queue/status，
   * 期间不换实例、不降级模型。request_set_id 必须保持不变，
   * 服务端靠它关联排队条目（只重生成 request_id）。
   * 永久错误（403 签名失效、401 认证）直接向上抛，由调用方处理。
   */
  const send = async (userIn: QoderUser): Promise<Response> => {
    let user = userIn;
    // requestSetId 跨「排队 → 放行后重发」保持不变，对齐官方只重生成 requestId 的做法
    let ids = newChatIds();
    let resp = await doChat(user, openAiBody, proxyUrl, init?.signal, ids);

    // 401 自动刷新兜底
    if (resp.status === 401) {
      try {
        const fresh = await getValidAuth(true);
        user = {
          uid: fresh.userId,
          token: fresh.accessToken,
          email: fresh.email,
          name: fresh.username,
        };
        resp = await doChat(user, openAiBody, proxyUrl, init?.signal, ids);
      } catch {}
    }

    const telemetry = createQueueTelemetry();

    for (let recovery = 0; ; recovery++) {
      if (!resp.ok || !resp.body) return resp;

      const peeked = await peekQueueError(resp);
      resp = peeked.response;

      // 没有排队信号：正常响应（或永久错误）直接透传
      if (peeked.queue === undefined) return resp;

      // 官方上限：一个 turn 内最多恢复 10 次
      if (recovery >= MAX_QUEUE_RETRIES) {
        try { (resp as any).body?.cancel?.(); } catch {}
        return upstreamBusyResponse(
          `Qoder 上游繁忙（10605）：已进入排队恢复 ${MAX_QUEUE_RETRIES} 次仍无空闲实例，请稍后再试`
        );
      }

      // 外层 code 常是 403，排队信号真正在里面的 10605
      const code = peeked.codes[peeked.codes.length - 1] ?? "10605";
      noteQueuedRequestSet(ids.requestSetId);
      notifyStatus(`上游繁忙（${code}），进入排队等待…`);

      // 丢弃本次响应体，否则每轮都会漏一个未消费的 HTTP 连接
      try { (resp as any).body?.cancel?.(); } catch {}

      try {
        await waitInQueue({
          initialQueue: peeked.queue,
          requestSetId: ids.requestSetId,
          modelKey: peeked.queue.modelKey ?? "qfmodel",
          signal: init?.signal,
          telemetry,
          onView: renderQueueView,
          sleep,
          fetchStatus: ((p) => pollQueueStatus(user, p)) as QueueStatusFetch,
        });
      } catch (err: any) {
        // 排队失败不能 throw：pi-ai 会把 fetch 抛的异常包成 "Connection error."，
        // 而该文本正好命中 pi 的可重试正则，会叠加一层全局重试把等待拖到数分钟。
        // 返回不命中重试特征的 400 文本，让错误原样透出且节奏只由本插件控制。
        // HTTP 400 仍会被 pi 按正文匹配重试；原始 timeout/503 等只写诊断通道。
        notifyStatus(`排队停止: ${err?.message ?? String(err)}`);
        const msg = queueFailureReason(err);
        const maxWait = resolveMaxWaitMs();
        return upstreamBusyResponse(
          `Qoder 上游繁忙（10605）：排队未成功（${msg}）。` +
            `已等 ${Math.round((telemetry.waitMs ?? 0) / 1000)}s / 上限 ${Math.round(maxWait / 1000)}s，` +
            `轮询 ${telemetry.pollCount} 次（失败 ${telemetry.pollFailureCount} 次）。请稍后再试。`
        );
      }

      telemetry.recovered = true;
      telemetry.recoveryAttempt++;
      renderQueueView({
        status: "ready",
        progress: 100,
        elapsedMs: telemetry.waitMs ?? 0,
        maxWaitMs: resolveMaxWaitMs(),
      });

      // 放行后用同一 request_set_id、新 request_id 重发（对齐官方）
      ids = {
        requestId: crypto.randomUUID().replace(/-/g, ""),
        requestSetId: ids.requestSetId,
      };
      resp = await doChat(user, openAiBody, proxyUrl, init?.signal, ids);
    }
  };

  const resp = await send(authUser);

  if (!resp.ok) {
    return resp;
  }

  return transformQoderSseResponse(resp);
}

// ── OpenAI-completions API 兼容探测 ──────────────────────────────────────────

let completionsBase: { stream: any; streamSimple: any } | null = null;

async function resolveCompletionsBase(): Promise<{ stream: any; streamSimple: any }> {
  if (completionsBase) return completionsBase;
  const candidates = [
    "@earendil-works/pi-ai/compat",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-ai/api/openai-completions",
  ];
  for (const spec of candidates) {
    try {
      const m: any = await import(spec);
      if (typeof m.openAICompletionsApi === "function") {
        const api = m.openAICompletionsApi();
        if (typeof api?.stream === "function") {
          completionsBase = { stream: api.stream, streamSimple: api.streamSimple };
          return completionsBase;
        }
      }
      if (typeof m.stream === "function" && typeof m.streamSimple === "function") {
        completionsBase = { stream: m.stream, streamSimple: m.streamSimple };
        return completionsBase;
      }
    } catch {}
  }
  throw new Error("qoder: no usable OpenAI-completions stream found in installed pi-ai");
}

// ── 扩展主体 ─────────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  const base = await resolveCompletionsBase();

  // ExtensionAPI 没有 ui；headless 的 ctx.ui 又是 no-op，调用成功不代表显示成功。
  // 仅在确有 UI 时安装 sink，否则保留 notifyStatus 的 stderr 兜底。
  pi.on("session_start", async (_event, ctx) => {
    const sinks = createQueueStatusSinks(ctx);
    statusNotify = sinks.notify;
    queueStatusSink = sinks.status;
  });

  pi.on("session_shutdown", async () => {
    statusNotify = null;
    queueStatusSink = null;
  });

  // turn 结束（正常/报错/中止）都要归还排队租约，否则服务端要等 TTL 才释放槽位
  const flushQueueLeases = async (ctx: any) => {
    queueStatusSink?.(undefined);
    if (touchedRequestSets.size === 0) return;
    const entries = [...touchedRequestSets.entries()];
    touchedRequestSets.clear();
    await Promise.allSettled(
      entries.map(([requestSetId, startedAt]) =>
        releaseQueueLease({
          modelKey: "qfmodel",
          requestSetId,
          timeConsumedMs: Date.now() - startedAt,
        }).catch((err) => {
          notifyStatus(
            `排队租约归还失败（服务端 TTL 会兜底）: ${err?.message ?? String(err)}`
          );
        })
      )
    );
    void ctx;
  };

  pi.on("turn_end", async (_event, ctx) => {
    await flushQueueLeases(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    await flushQueueLeases(ctx);
  });

  const wrapOptions = (o: any) => ({
    ...(o ?? {}),
    fetch: fingerprintFetch,
  });

  const provider = createProvider({
    id: "qoder",
    name: "Qoder (fingerprint)",
    baseUrl: `${INFER_BASE}/v2`,
    headers: {
      "User-Agent": "Bun/1.4.2",
      "Cosy-Business-Product": "cli",
    },
    auth: {
      oauth: {
        name: "Qoder (Alibaba/Tongyi)",
        loginLabel: "Sign in with Qoder (Browser OAuth or CLI Import)",
        async login(interaction: any) {
          // 统一入口：选 OAuth 浏览器授权，或从官方 CLI 本地凭证导入（对齐 codebuddy 模式）
          let method = "oauth";
          if (interaction?.prompt) {
            method = await interaction.prompt({
              type: "select",
              message: "Qoder 登录方式",
              options: [
                { id: "oauth", label: "浏览器 OAuth 授权（淘宝/支付宝/阿里云账号）" },
                { id: "import", label: "从官方 Qoder CLI 导入凭证（需已在终端登录）" },
              ],
            });
          }

          if (method === "import") {
            const qoderDir = path.join(os.homedir(), ".qoder/.auth");
            const userFile = path.join(qoderDir, "user");
            const midFile = path.join(qoderDir, "machine_id");

            if (!fs.existsSync(userFile) || !fs.existsSync(midFile)) {
              throw new Error(
                `未找到官方 Qoder CLI 凭证（${qoderDir}）。\n请先在终端安装并登录官方 CLI：qoder login，或改选「浏览器 OAuth 授权」。`
              );
            }

            // 检查已存入或可用的凭据
            const existing = loadAuth();
            if (existing && existing.accessToken && existing.userId) {
              // 验证已有凭据有效性
              try {
                const refreshed = await refreshAuth(existing);
                interaction.notify?.({
                  message: `已导入官方 Qoder CLI 凭证：${refreshed.username || refreshed.userId}${refreshed.email ? ` (${refreshed.email})` : ""}`,
                });
                return {
                  type: "oauth" as const,
                  access: refreshed.accessToken,
                  refresh: refreshed.refreshToken,
                  expires: refreshed.expiresAt,
                  userId: refreshed.userId,
                  username: refreshed.username,
                  email: refreshed.email,
                };
              } catch {}
            }

            interaction.notify?.({
              message: `检测到本地 Qoder CLI 已安装，正在启动快速授权绑定...`,
            });
          }

          const proxyUrl =
            process.env.QODER_PROXY ??
            process.env.HTTPS_PROXY ??
            process.env.HTTP_PROXY ??
            undefined;

          // 生成 PKCE verifier 与 challenge
          const rawVerifier = crypto.randomBytes(64).toString("base64url");
          const challenge = crypto
            .createHash("sha256")
            .update(rawVerifier, "utf8")
            .digest("base64url");
          const nonce = crypto.randomUUID();

          const authUrl =
            `${DEVICE_FLOW_HOST}/device/selectAccounts?challenge=${encodeURIComponent(
              challenge
            )}&challenge_method=S256&nonce=${encodeURIComponent(
              nonce
            )}&machine_id=${encodeURIComponent(
              machineId
            )}&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

          interaction.notify?.({
            message: emitLoginUrl(authUrl),
          });

          // 轮询 deviceToken
          const pollUrl = `${OPENAPI_BASE}/api/v1/deviceToken/poll?nonce=${encodeURIComponent(
            nonce
          )}&verifier=${encodeURIComponent(rawVerifier)}&challenge_method=S256`;

          const deadline = Date.now() + 5 * 60 * 1000;
          let deviceToken = "";
          let userId = "";

          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const res = await rawRequest(
                pollUrl,
                "GET",
                [
                  ["Accept", "application/json"],
                  ["Host", new URL(OPENAPI_BASE).host],
                  ["Connection", "close"],
                ],
                Buffer.alloc(0),
                proxyUrl
              );
              if (res.ok) {
                const j = (await res.json()) as any;
                if (j?.token) {
                  deviceToken = j.token;
                  userId = j.user_id ?? "";
                  break;
                }
              }
            } catch {}
          }

          if (!deviceToken) {
            throw new Error("Qoder 授权超时（5 分钟未完成）");
          }

          // 用 deviceToken 换取 jobToken
          const jobRes = await rawRequest(
            `${OPENAPI_BASE}/api/v1/me/jobToken`,
            "POST",
            [
              ["Accept", "application/json"],
              ["Content-Type", "application/json"],
              ["Authorization", `Bearer ${deviceToken}`],
              ["Host", new URL(OPENAPI_BASE).host],
              ["Connection", "close"],
            ],
            Buffer.from(JSON.stringify({ clientId: CLIENT_ID })),
            proxyUrl
          );

          if (!jobRes.ok) {
            throw new Error(`换取 Qoder jobToken 失败: HTTP ${jobRes.status}`);
          }

          const jobData = (await jobRes.json()) as any;
          const accessToken = jobData.token;
          const refreshToken = jobData.refresh_token ?? "";
          const expiresAt = Date.now() + 24 * 3600 * 1000;

          const authState: AuthState = {
            accessToken,
            refreshToken,
            userId,
            expiresAt,
            deviceToken,
          };
          saveAuth(authState);
          authCache = authState;

          interaction.notify?.({
            message: `Qoder 登录成功！用户 ID: ${userId}，已保存至 ~/.pi/agent/auth.json`,
          });

          return {
            type: "oauth" as const,
            access: accessToken,
            refresh: refreshToken,
            expires: expiresAt,
            userId,
            deviceToken,
          };
        },

        async refresh(cred: any, _signal: AbortSignal) {
          const fresh = await refreshAuth({
            accessToken: cred.access,
            refreshToken: cred.refresh,
            userId: cred.userId ?? "",
            expiresAt: cred.expires ?? 0,
            email: cred.email,
            username: cred.username,
            deviceToken: cred.deviceToken,
          });
          return {
            ...cred,
            access: fresh.accessToken,
            refresh: fresh.refreshToken,
            expires: fresh.expiresAt,
          };
        },

        async toAuth(cred: any) {
          return { apiKey: cred.access };
        },
      },
    },
    models: [
      {
        provider: "qoder",
        api: "openai-completions" as const,
        baseUrl: `${INFER_BASE}/v2`,
        id: "qwen3.8-max",
        name: "Qwen 3.8 Max (Qoder)",
        upstreamId: "qfmodel",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 32_000,
        samplingParams: { temperature: 0.7 },
        thinkingLevelMap: {
          off: "none",
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          maxTokensField: "max_tokens",
          requiresReasoningContentOnAssistantMessages: true,
        },
      },
      {
        provider: "qoder",
        api: "openai-completions" as const,
        baseUrl: `${INFER_BASE}/v2`,
        id: "qwen3.8-flash",
        name: "Qwen 3.8 Flash (Qoder, Free 0x)",
        upstreamId: "qfmodel",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 32_000,
        samplingParams: { temperature: 0.7 },
        thinkingLevelMap: {
          off: "none",
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          maxTokensField: "max_tokens",
          requiresReasoningContentOnAssistantMessages: true,
        },
      },
    ] as any,
    api: {
      stream: (model: any, context: any, options: any) =>
        base.stream(model, context, wrapOptions(options)),
      streamSimple: (model: any, context: any, options: any) =>
        base.streamSimple(model, context, wrapOptions(options)),
    },
  });

  pi.registerProvider(provider as any);

  // ── /qoder-login：便捷登录命令 ─────────────────────────────────────────────
  pi.registerCommand("qoder-login", {
    description: "Login to Qoder via browser OAuth Device Flow",
    handler: async (_args: string, ctx: any) => {
      try {
        const interaction = {
          notify: (n: any) => ctx.ui.notify(typeof n === "string" ? n : n.message, "info"),
          prompt: async (opt: any) => {
            if (ctx.ui.select) {
              return ctx.ui.select(opt.message, opt.options.map((o: any) => o.label));
            }
            return opt.options[0]?.id;
          },
        };
        await (provider as any).auth!.oauth!.login(interaction);
        ctx.ui.notify(`Qoder 登录成功！可在 /models 中选择 qoder/qwen3.8-flash`, "success");
      } catch (err: any) {
        ctx.ui.notify(`Qoder 登录失败: ${err.message}`, "error");
      }
    },
  });

  // ── /qoder-import：从官方 CLI 凭据自动导入（无浏览器场景）───────────────
  pi.registerCommand("qoder-import", {
    description: "Import credentials from official Qoder CLI",
    handler: async (_args: string, ctx: any) => {
      const qoderDir = path.join(os.homedir(), ".qoder/.auth");
      const userFile = path.join(qoderDir, "user");
      const midFile = path.join(qoderDir, "machine_id");

      if (!fs.existsSync(userFile) || !fs.existsSync(midFile)) {
        ctx.ui.notify(
          `未找到官方 Qoder CLI 凭证（${qoderDir}）。\n请先在终端安装并登录官方 CLI：qoder login，或改选「浏览器 OAuth 授权」。`,
          "error"
        );
        return;
      }

      const existing = loadAuth();
      if (existing && existing.accessToken && existing.userId) {
        try {
          const refreshed = await refreshAuth(existing);
          ctx.ui.notify(
            `Qoder 凭证导入成功：${refreshed.username || refreshed.userId}${refreshed.email ? ` (${refreshed.email})` : ""}\n有效期至 ${new Date(refreshed.expiresAt).toLocaleString()}\n用 /models 选择 qoder/qwen3.8-flash`,
            "success"
          );
          return;
        } catch {}
      }

      ctx.ui.notify("已检测到官方 Qoder 安装，请通过 /qoder-login 完成快速绑定授权", "info");
    },
  });

  // ── /qoder-set-token：快速手动贴入已有 Token ───────────────────────────────
  pi.registerCommand("qoder-set-token", {
    description: "Manually configure Qoder jobToken and userId",
    handler: async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui.notify(
          "使用方法: /qoder-set-token <userId> <jobToken> [refreshToken]",
          "error"
        );
        return;
      }
      const [userId, accessToken, refreshToken] = parts;
      const authState: AuthState = {
        userId,
        accessToken,
        refreshToken: refreshToken ?? "",
        expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
      };
      saveAuth(authState);
      authCache = authState;
      ctx.ui.notify(`Qoder 凭证保存成功 (User: ${userId})！`, "success");
    },
  });
}
