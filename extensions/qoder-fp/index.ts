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
import { createProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { encodeRequestBody } from "./codec.ts";
import { buildCosyHeaders, type QoderUser } from "./cosy.ts";

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

async function doChat(
  authUser: QoderUser,
  openAiBody: any,
  proxyUrl?: string,
  signal?: AbortSignal
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
    request_id: crypto.randomUUID().replace(/-/g, ""),
    request_set_id: crypto.randomUUID().replace(/-/g, ""),
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
  let resp = await doChat(authUser, openAiBody, proxyUrl, init?.signal);

  // 401 自动刷新兜底
  if (resp.status === 401) {
    try {
      const fresh = await getValidAuth(true);
      const freshUser: QoderUser = {
        uid: fresh.userId,
        token: fresh.accessToken,
        email: fresh.email,
        name: fresh.username,
      };
      resp = await doChat(freshUser, openAiBody, proxyUrl, init?.signal);
    } catch {}
  }

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
            message: `请在浏览器中打开以下链接授权 Qoder 登录：\n${authUrl}`,
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
