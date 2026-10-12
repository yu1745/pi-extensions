/**
 * Qoder 官方 CLI「模型请求排队」算法复刻
 *
 * 来源：对 ~/.qoder/bin/qodercli/qodercli-1.1.69 的静态还原 + 真实运行日志交叉验证。
 * 完整报告见 reverse-skill 案例 20261012-180807-qoder-cli/report/model-queue-algorithm.md。
 *
 * 结论：慢的根因不是本地串行队列，而是**服务端容量队列**。免费池紧张时上游用
 * `10605 / model_queued`（外层常伪装成 403）拒绝请求，客户端只能按服务端给的
 * `retryAfterSeconds` 轮询 `/api/v2/service/ask/queue/status`，直到 `isQueued === false`，
 * 期间不换实例、不降级模型、本地不做指数退避。
 *
 * 本文件忠实复刻其常量、轮询顺序、UI 节流与进度条公式；网络 I/O 由调用方注入，
 * 以便离线单测。
 */

// ── 官方常量（qodercli 1.1.69，偏移 140322702 的常量表）─────────────────────

/** 单次排队等待硬上限，官方 1h；可用 QODER_MODEL_QUEUE_MAX_WAIT_MS 覆盖。 */
export const MAX_QUEUE_WAIT_DEFAULT_MS = 3_600_000;
/** 一个 turn 内最多恢复多少次（官方 bve）。 */
export const MAX_QUEUE_RECOVERIES = 10;
/** 连续轮询的最小间隔（官方 f9e）。 */
export const MIN_POLL_INTERVAL_MS = 500;
/** 连续轮询的最大间隔（官方 g9e）。 */
export const MAX_POLL_INTERVAL_MS = 30_000;
/** 服务端没给 retryAfterSeconds 时的默认等待秒数（官方 h9e）。 */
export const SERVER_DEFAULT_WAIT_S = 30;
/** 连续轮询失败多少次后放弃（官方 fre）。 */
export const POLL_FAILURE_LIMIT = 3;
/** UI 心跳推送间隔（官方 vve）。 */
export const WAIT_EMIT_HEARTBEAT_MS = 30_000;
/** UI 刷新的绝对阈值（官方 _ve）。 */
export const WAIT_EMIT_ABS_MS = 5_000;
/** UI 刷新的相对阈值（官方 xve）。 */
export const WAIT_EMIT_RATIO = 0.25;
/** 单次轮询超时（官方 yve）。 */
export const POLL_TIMEOUT_MS = 30_000;
/** 轮询响应体大小上限（官方 y9e）。 */
export const STATUS_BODY_LIMIT = 64 * 1024;

/** 进度条上限 / 下限 / 兜底步长（官方 Oc / Ff / IH）。 */
export const PROGRESS_MAX = 95;
export const PROGRESS_MIN = 3;
export const PROGRESS_STEP = 4;

/**
 * 队列状态轮询出网地址。
 *
 * 官方常量 `ES` 写的是 `/api/v2/service/ask/queue/status`（不带头缀），但那是交给传输层
 * `prepareRequest` 做签名的**剥壳路径**；真实出网 URL 会补上 `/algo` 前缀。
 * 注意官方日志同样只记剥壳后的 `path=/api/v2/...`，所以照日志构造 URL 会错。
 * 实测：不带 `/algo` 直接 404，带上才 200。
 * `buildCosyHeaders` 会为签名去掉 `/algo`，两边保持一致。
 */
export const QUEUE_STATUS_PATH = "/algo/api/v2/service/ask/queue/status";
/** 租约归还出网地址（官方常量 `kve`），同样必须带 `/algo`；实测不带前缀 404。 */
export const QUEUE_FINISH_PATH = "/algo/api/v2/service/ask/finish?Encode=1";

// ── 类型 ─────────────────────────────────────────────────────────────────────

/** 排队/容量信号，字段与官方 `T9e` 解析出的结构一致。 */
export interface QueueSignal {
  isQueued?: boolean;
  modelKey?: string;
  queueCount?: number;
  queueType?: string;
  serviceAvailable?: boolean;
  retryAfterSeconds?: number;
  waitTime?: number;
}

/** 交给 UI 渲染的一帧排队状态。 */
export interface QueueView {
  status: "queued" | "ready";
  progress: number;
  elapsedMs: number;
  maxWaitMs: number;
  waitTimeMs?: number;
  queueCount?: number;
  initialQueueCount?: number;
  modelKey?: string;
  queueType?: string;
  serviceAvailable?: boolean;
  label?: string;
}

/** 跨多次 recovery 累计的排队遥测。 */
export interface QueueTelemetry {
  waitMs?: number;
  pollCount: number;
  pollFailureCount: number;
  serviceUnavailableCount: number;
  recovered: boolean;
  recoveryAttempt: number;
  endpointUnavailable: boolean;
  serverRetryAfterMs?: number;
  serverWaitTimeMs?: number;
}

export function createQueueTelemetry(): QueueTelemetry {
  return {
    pollCount: 0,
    pollFailureCount: 0,
    serviceUnavailableCount: 0,
    recovered: false,
    recoveryAttempt: 0,
    endpointUnavailable: false,
  };
}

/** 带官方语义标记的排队错误。 */
export interface QueueError extends Error {
  queue_fatal?: boolean;
  queue_endpoint_unavailable?: boolean;
  queue_poll_failure_count?: number;
}

function queueError(message: string, flags: Partial<QueueError> = {}): QueueError {
  return Object.assign(new Error(message), flags) as QueueError;
}

/** 供调用方注入的轮询实现。 */
export type QueueStatusFetch = (params: {
  requestSetId: string;
  modelKey: string;
  queueType?: string;
  signal?: AbortSignal;
  timeoutMs: number;
}) => Promise<QueueSignal>;

// ── 信号判定与解包 ───────────────────────────────────────────────────────────

/**
 * 判断一个对象是否含排队/容量信号。
 *
 * 官方 `ND`：`isQueued === true` 或 `serviceAvailable === false`，
 * 或出现了 `retryAfterSeconds` / `waitTime` 数值。
 */
export function hasQueueSignal(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;
  if (n.isQueued === true || n.serviceAvailable === false) return true;
  return Number.isFinite(Number(n.retryAfterSeconds)) || Number.isFinite(Number(n.waitTime));
}

/**
 * 解开 Qoder 上游错误。
 *
 * 上游会把同一个错误反复包进 message 字符串，实测三层：
 *   {"code":"403","message":"{\"code\":\"10605\",\"message\":\"{\"isQueued\":true,...}\"}"}
 * 外层 code 是 403，真正指示排队的 10605 在第二层，可用信号在第三层。
 * 官方在 `sl()` 里只剥一层就拿 `ND` 判定，靠的是 `Nv()` 的递归归一化；
 * 这里显式剥到出现信号为止，深度上限 5，等价且更好测。
 */
export function decodeQueueError(body: string): {
  codes: string[];
  detail?: QueueSignal;
  raw: string;
} {
  let node: unknown;
  try {
    node = JSON.parse(body);
  } catch {
    return { codes: [], raw: body };
  }

  const codes: string[] = [];
  let detail: QueueSignal | undefined;
  for (let depth = 0; depth < 5; depth++) {
    if (!node || typeof node !== "object") break;
    const n = node as Record<string, unknown>;
    if (n.code != null) codes.push(String(n.code));
    if (hasQueueSignal(n)) {
      detail = n as QueueSignal;
      break;
    }
    const msg = typeof n.message === "string" ? n.message : undefined;
    if (!msg) break;
    try {
      node = JSON.parse(msg);
    } catch {
      break;
    }
  }

  return { codes, detail, raw: body };
}

/**
 * 解析 `queue/status` 的响应体。
 *
 * 官方 `x9e` 会对嵌套体做 BFS（data / result / message / body），
 * 任一节点同时具备 `isQueued` 或 `serviceAvailable` 即视为有效载荷。
 */
export function parseQueueStatus(body: string): QueueSignal | null {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return null;
  }

  const queue: unknown[] = [root];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    const n = cur as Record<string, unknown>;
    const isQueued = toBool(n.isQueued);
    const serviceAvailable = toBool(n.serviceAvailable);
    if (isQueued !== undefined || serviceAvailable !== undefined) {
      const modelKey = toStringOrUndefined(n.modelKey);
      const queueType = toStringOrUndefined(n.queueType);
      const queueCount = toNumberOrUndefined(n.queueCount);
      const retryAfterSeconds = toNumberOrUndefined(n.retryAfterSeconds);
      const waitTime = toNumberOrUndefined(n.waitTime);
      return {
        ...(isQueued !== undefined ? { isQueued } : {}),
        ...(modelKey !== undefined ? { modelKey } : {}),
        ...(queueCount !== undefined ? { queueCount } : {}),
        ...(queueType !== undefined ? { queueType } : {}),
        ...(serviceAvailable !== undefined ? { serviceAvailable } : {}),
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        ...(waitTime !== undefined ? { waitTime } : {}),
      };
    }
    for (const key of ["data", "result", "message", "body"]) {
      const child = n[key];
      if (child && typeof child === "object") queue.push(child);
      else if (typeof child === "string") {
        try {
          queue.push(JSON.parse(child));
        } catch {
          // 非 JSON 子串直接忽略
        }
      }
    }
  }
  return null;
}

function toBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return undefined;
}

function toStringOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function toNumberOrUndefined(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

// ── 等待时长与进度 ───────────────────────────────────────────────────────────

/** 官方 `S9e`：把等待时长夹到 [500ms, 30s]。 */
export function clampPollInterval(ms: number): number {
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, ms));
}

/**
 * 官方 `gre`：服务端给的 retryAfterSeconds → 本地等待毫秒。
 * 非有限值或缺失时退回 30s（`h9e`），再夹到 [500ms, 30s]。
 */
export function serverWaitMs(retryAfterSeconds: number | undefined): number {
  const secs =
    retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds
      : SERVER_DEFAULT_WAIT_S;
  return clampPollInterval(secs * 1000);
}

/**
 * 官方 `kH`：进度条百分比。优先级 —— 队列长度缩短 > 已等/最大等待 > 每轮 +4。只增不减。
 */
export function computeQueueProgress(
  prev: { progress?: number } | undefined,
  queueCount: number | undefined,
  initialQueueCount: number | undefined,
  waitElapsedMs: number | undefined,
  maxWaitMs: number | undefined
): number {
  if (queueCount !== undefined && initialQueueCount !== undefined && initialQueueCount > 0) {
    const cur = Math.min(Math.max(queueCount, 0), initialQueueCount);
    const ratio = (initialQueueCount - cur) / initialQueueCount;
    return clampProgress(Math.round(ratio * PROGRESS_MAX));
  }
  if (waitElapsedMs !== undefined && maxWaitMs !== undefined && maxWaitMs > 0) {
    const ratio = Math.min(Math.max(waitElapsedMs / maxWaitMs, 0), 1);
    return clampProgress(Math.round(ratio * PROGRESS_MAX));
  }
  return clampProgress((prev?.progress ?? 0) + PROGRESS_STEP);
}

function clampProgress(v: number): number {
  return Math.min(PROGRESS_MAX, Math.max(PROGRESS_MIN, v));
}

/** 官方 `aF`：把服务端 waitTime(ms) 变成四档文案。 */
export function waitLabel(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 60_000) return "estimated wait less than 1min";
  if (ms < 120_000) return "estimated wait 1min";
  if (ms < 600_000) return `estimated wait ${Math.round(ms / 60_000)}min`;
  return "estimated wait over 10min";
}

/** `waitTime` 秒 → 毫秒（官方 `NG`）。 */
export function waitTimeMs(signal: QueueSignal | undefined): number | undefined {
  return signal?.waitTime === undefined ? undefined : signal.waitTime * 1000;
}

/** QODER_MODEL_QUEUE_MAX_WAIT_MS 覆盖值；非法或未设置时用官方 1h。 */
export function resolveMaxWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.QODER_MODEL_QUEUE_MAX_WAIT_MS;
  if (raw === undefined) return MAX_QUEUE_WAIT_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : MAX_QUEUE_WAIT_DEFAULT_MS;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ── UI 节流（官方 uXe / x_e）─────────────────────────────────────────────────

interface EmitState {
  emitted: boolean;
  lastEmittedAt: number;
  lastQueueCount?: number;
  lastWaitTimeMs?: number;
}

export function shouldEmitQueueView(
  state: EmitState,
  next: QueueSignal,
  now: number
): boolean {
  if (!state.emitted) return true;
  if (next.queueCount !== undefined && next.queueCount !== state.lastQueueCount) return true;
  const w = waitTimeMs(next);
  if (w !== undefined && state.lastWaitTimeMs !== undefined) {
    const abs = Math.abs(w - state.lastWaitTimeMs);
    const rel = abs / Math.max(state.lastWaitTimeMs, 1);
    if (abs >= WAIT_EMIT_ABS_MS || rel >= WAIT_EMIT_RATIO) return true;
  }
  return now - state.lastEmittedAt >= WAIT_EMIT_HEARTBEAT_MS;
}

export function markQueueViewEmitted(state: EmitState, next: QueueSignal, now: number): void {
  state.emitted = true;
  state.lastEmittedAt = now;
  state.lastQueueCount = next.queueCount;
  state.lastWaitTimeMs = waitTimeMs(next);
}

// ── 等待循环（官方 pXe）──────────────────────────────────────────────────────

export interface WaitInQueueOptions {
  /** 首次从 10605 错误里抽出的排队信号。 */
  initialQueue?: QueueSignal;
  requestSetId: string;
  modelKey: string;
  signal?: AbortSignal;
  telemetry?: QueueTelemetry;
  /** 每帧状态回调（已按官方规则节流）。 */
  onView?: (view: QueueView) => void;
  fetchStatus: QueueStatusFetch;
  maxWaitMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface QueueWaitResult extends QueueSignal {
  queueWaitElapsedMs: number;
  queueMaxWaitMs: number;
}

/**
 * 排队等待主体：按官方顺序「先推状态 →（非首轮）等待 retryAfter → 轮询 queue/status」，
 * 直到 `isQueued === false`；超时、轮询连续失败、端点不可用即抛错。
 */
export async function waitInQueue(opts: WaitInQueueOptions): Promise<QueueWaitResult> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const telemetry = opts.telemetry;

  const start = now();
  const already = telemetry?.waitMs ?? 0;
  const maxWaitMs = opts.maxWaitMs ?? resolveMaxWaitMs();
  const budget = maxWaitMs - already;
  if (budget <= 0) {
    throw queueError("model queue wait timeout", {
      queue_poll_failure_count: telemetry?.pollFailureCount,
    });
  }
  const deadline = start + budget;

  const elapsed = (at: number = now()) => already + Math.max(0, at - start);
  const sync = (at: number = now()) => {
    if (telemetry) telemetry.waitMs = elapsed(at);
  };

  const emitState: EmitState = { emitted: false, lastEmittedAt: 0 };
  let queue: QueueSignal = opts.initialQueue ?? {};
  recordServerTimings(telemetry, queue);

  let initialQueueCount: number | undefined;
  let progress = 0;

  const buildView = (signal: QueueSignal, status: "queued" | "ready", at: number): QueueView => {
    const count = signal.queueCount;
    if (initialQueueCount === undefined && count !== undefined && count > 0) {
      initialQueueCount = count;
    }
    const next =
      status === "ready"
        ? 100
        : Math.max(
            progress,
            computeQueueProgress({ progress }, count, initialQueueCount, elapsed(at), maxWaitMs)
          );
    progress = next;
    return {
      status,
      progress: next,
      elapsedMs: elapsed(at),
      maxWaitMs,
      waitTimeMs: waitTimeMs(signal),
      queueCount: count,
      initialQueueCount,
      modelKey: signal.modelKey ?? opts.modelKey,
      queueType: signal.queueType,
      serviceAvailable: signal.serviceAvailable,
      label: waitLabel(waitTimeMs(signal)),
    };
  };

  const emit = (signal: QueueSignal, status: "queued" | "ready", at: number) => {
    opts.onView?.(buildView(signal, status, at));
  };

  const throwIfAborted = () => {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
  };

  let polledOnce = false;
  let consecutiveFailures = 0;

  try {
    for (;;) {
      throwIfAborted();
      const at = now();
      if (at >= deadline) {
        throw queueError("model queue wait timeout", {
          queue_poll_failure_count: telemetry?.pollFailureCount,
        });
      }

      // 1) 按官方节流规则推送状态
      if (shouldEmitQueueView(emitState, queue, at)) {
        markQueueViewEmitted(emitState, queue, at);
        emit(queue, "queued", at);
      }

      // 2) 服务端要求先等一会儿（首轮不等待，立即探测一次）
      if (polledOnce) {
        const delay = Math.min(
          serverWaitMs(queue.retryAfterSeconds),
          Math.max(0, deadline - now())
        );
        await sleep(delay, opts.signal);
        sync();
      }

      // 3) 轮询 queue/status
      try {
        const remaining = deadline - now();
        if (remaining <= 0) {
          throw queueError("model queue wait timeout", {
            queue_poll_failure_count: telemetry?.pollFailureCount,
            queue_fatal: true,
          });
        }
        if (telemetry) telemetry.pollCount++;
        polledOnce = true;

        const status = await opts.fetchStatus({
          requestSetId: opts.requestSetId,
          modelKey: queue.modelKey ?? opts.modelKey,
          queueType: queue.queueType,
          signal: opts.signal,
          timeoutMs: remaining,
        });

        consecutiveFailures = 0;
        queue = status;
        recordServerTimings(telemetry, status);

        if (status.isQueued === false) {
          const d =
            status.retryAfterSeconds !== undefined &&
            Number.isFinite(status.retryAfterSeconds) &&
            status.retryAfterSeconds > 0
              ? Math.min(serverWaitMs(status.retryAfterSeconds), Math.max(0, deadline - now()))
              : 0;
          await sleep(d, opts.signal);
          const doneAt = now();
          const waited = elapsed(doneAt);
          sync(doneAt);
          if (doneAt >= deadline) {
            throw queueError("model queue wait timeout", {
              queue_poll_failure_count: telemetry?.pollFailureCount,
              queue_fatal: true,
            });
          }
          opts.onView?.(buildView(status, "ready", doneAt));
          return { ...status, queueWaitElapsedMs: waited, queueMaxWaitMs: maxWaitMs };
        }

        if (status.serviceAvailable === false) {
          if (telemetry) telemetry.serviceUnavailableCount++;
          const at2 = now();
          sync(at2);
          markQueueViewEmitted(emitState, status, at2);
          emit(status, "queued", at2);
          continue;
        }

        if (status.isQueued === true) continue;

        throw queueError("model queue status is not recoverable", {
          queue_poll_failure_count: telemetry?.pollFailureCount,
          queue_fatal: true,
        });
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason ?? err;
        const q = err as QueueError;
        if (q?.queue_fatal === true) throw err;
        if (q?.queue_endpoint_unavailable === true) {
          if (telemetry) telemetry.endpointUnavailable = true;
          throw err;
        }
        consecutiveFailures++;
        if (telemetry) telemetry.pollFailureCount++;
        if (consecutiveFailures >= POLL_FAILURE_LIMIT) {
          throw queueError("model queue status polling failed", {
            queue_poll_failure_count: telemetry?.pollFailureCount,
          });
        }
        // 清掉服务端建议，退回默认 30s 间隔
        queue = { ...queue, retryAfterSeconds: undefined };
      }
    }
  } finally {
    sync();
  }
}

function recordServerTimings(telemetry: QueueTelemetry | undefined, signal: QueueSignal): void {
  if (!telemetry) return;
  if (
    signal.retryAfterSeconds !== undefined &&
    Number.isFinite(signal.retryAfterSeconds) &&
    signal.retryAfterSeconds > 0
  ) {
    telemetry.serverRetryAfterMs = Math.round(signal.retryAfterSeconds * 1000);
  }
  if (signal.waitTime !== undefined && Number.isFinite(signal.waitTime) && signal.waitTime >= 0) {
    telemetry.serverWaitTimeMs = Math.round(signal.waitTime * 1000);
  }
}

/**
 * 构造 `POST /algo/api/v2/service/ask/finish?Encode=1` 的请求体。
 *
 * 两个易错点，都是实测踩出来的：
 * 1. 端点必须带 `/algo` 前缀，否则 404；
 * 2. 该端点带 `Encode=1`，体必须过自定义 Base64（与 chat 同一套）——
 *    明文 JSON 实测返回 `500 Internal Server Error`，而非 400，
 *    很容易被当成服务端偶发故障忽略掉。
 *
 * `encodeRequestBody` 由调用方注入，避免 queue.ts 依赖 codec。
 */
export function buildQueueFinishBody(params: {
  encodeRequestBody: (plain: string) => string;
  modelKey: string;
  requestSetId: string;
  userId: string;
  timeConsumedMs: number;
}): string {
  const plain = JSON.stringify({
    payload: JSON.stringify({
      model_key: params.modelKey,
      request_set_id: params.requestSetId,
      user_id: params.userId,
      time_consumed: Math.max(0, Math.round(params.timeConsumedMs)),
    }),
    encodeVersion: "1",
  });
  return params.encodeRequestBody(plain);
}

/** 终态正文不能回显原始传输错误：pi 按文本匹配 timeout/503 等并自动重试。 */
export function queueFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout|timed? out/i.test(message)) return "已达到排队等待上限";
  if (/endpoint unavailable/i.test(message)) return "排队状态端点不可用";
  if (/abort/i.test(message)) return "排队已取消";
  return "排队状态查询失败";
}

/** print/json 模式的 UI 方法是 no-op，不能用“调用未抛错”判定 UI 可用。 */
export function createQueueStatusSinks(ctx: {
  hasUI: boolean;
  ui: {
    notify: (message: string, type: "info") => void;
    setStatus: (key: string, text: string | undefined) => void;
  };
}): {
  notify: ((message: string) => void) | null;
  status: ((text: string | undefined) => void) | null;
} {
  if (!ctx.hasUI) return { notify: null, status: null };
  return {
    notify: (message) => ctx.ui.notify(message, "info"),
    status: (text) => ctx.ui.setStatus("qoder-queue", text),
  };
}

/** 把一帧排队状态渲染成一行状态栏文本。 */
export function formatQueueView(view: QueueView): string {
  const filled = Math.max(0, Math.round((view.progress / 100) * 10));
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const parts = [`排队中 ${bar} ${view.progress}%`];
  if (view.label) parts.push(view.label);
  parts.push(`已等 ${Math.round(view.elapsedMs / 1000)}s`);
  if (view.queueCount !== undefined) parts.push(`前方 ${view.queueCount}`);
  return parts.join(" · ");
}
