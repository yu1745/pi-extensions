import { test, describe } from "node:test";
import assert from "node:assert";
import {
  MAX_QUEUE_RECOVERIES,
  MAX_QUEUE_WAIT_DEFAULT_MS,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  POLL_FAILURE_LIMIT,
  PROGRESS_MAX,
  PROGRESS_MIN,
  SERVER_DEFAULT_WAIT_S,
  clampPollInterval,
  computeQueueProgress,
  createQueueTelemetry,
  decodeQueueError,
  formatQueueView,
  hasQueueSignal,
  markQueueViewEmitted,
  parseQueueStatus,
  resolveMaxWaitMs,
  serverWaitMs,
  shouldEmitQueueView,
  waitInQueue,
  waitLabel,
  type QueueSignal,
} from "../extensions/qoder-fp/queue.ts";

/** 官方真实报错的逐字节复刻（外层 403、中层 10605、内层才是可用信号）。 */
const REAL_QUEUE_BODY = JSON.stringify({
  code: "403",
  message: JSON.stringify({
    code: "10605",
    message: JSON.stringify({
      isQueued: true,
      modelKey: "qfmodel",
      queueCount: 0,
      queueType: "p3",
      retryAfterSeconds: 30,
      serviceAvailable: false,
      waitTime: 30,
    }),
  }),
});

describe("qoder-fp queue: 常量与官方一致", () => {
  test("关键常量与 qodercli 1.1.69 对齐", () => {
    assert.strictEqual(MAX_QUEUE_WAIT_DEFAULT_MS, 3_600_000);
    assert.strictEqual(MAX_QUEUE_RECOVERIES, 10);
    assert.strictEqual(MIN_POLL_INTERVAL_MS, 500);
    assert.strictEqual(MAX_POLL_INTERVAL_MS, 30_000);
    assert.strictEqual(SERVER_DEFAULT_WAIT_S, 30);
    assert.strictEqual(POLL_FAILURE_LIMIT, 3);
    assert.strictEqual(PROGRESS_MAX, 95);
    assert.strictEqual(PROGRESS_MIN, 3);
  });

  test("QODER_MODEL_QUEUE_MAX_WAIT_MS 覆盖，非法值回落 1h", () => {
    assert.strictEqual(resolveMaxWaitMs({} as any), MAX_QUEUE_WAIT_DEFAULT_MS);
    assert.strictEqual(
      resolveMaxWaitMs({ QODER_MODEL_QUEUE_MAX_WAIT_MS: "5000" } as any),
      5000
    );
    // 官方：非有限值或 <= 0 视为未设置
    assert.strictEqual(
      resolveMaxWaitMs({ QODER_MODEL_QUEUE_MAX_WAIT_MS: "abc" } as any),
      MAX_QUEUE_WAIT_DEFAULT_MS
    );
    assert.strictEqual(
      resolveMaxWaitMs({ QODER_MODEL_QUEUE_MAX_WAIT_MS: "0" } as any),
      MAX_QUEUE_WAIT_DEFAULT_MS
    );
  });

  test("等待时长夹到 [500ms, 30s]，缺省 30s", () => {
    assert.strictEqual(clampPollInterval(1), 500);
    assert.strictEqual(clampPollInterval(99_999), 30_000);
    assert.strictEqual(serverWaitMs(30), 30_000);
    assert.strictEqual(serverWaitMs(undefined), 30_000); // h9e 默认
    assert.strictEqual(serverWaitMs(0.1), 500);
  });
});

describe("qoder-fp queue: 信号判定与三层解包", () => {
  test("hasQueueSignal 识别 isQueued / serviceAvailable / 重试字段", () => {
    assert.strictEqual(hasQueueSignal({ isQueued: true }), true);
    assert.strictEqual(hasQueueSignal({ serviceAvailable: false }), true);
    assert.strictEqual(hasQueueSignal({ retryAfterSeconds: 30 }), true);
    assert.strictEqual(hasQueueSignal({ waitTime: 0 }), true);
    assert.strictEqual(hasQueueSignal({ isQueued: false, serviceAvailable: true }), false);
    assert.strictEqual(hasQueueSignal(null), false);
    assert.strictEqual(hasQueueSignal("nope"), false);
  });

  test("三层嵌套解包：外层 403，中层 10605，信号在第三层", () => {
    const { codes, detail } = decodeQueueError(REAL_QUEUE_BODY);
    assert.deepStrictEqual(codes, ["403", "10605"]);
    assert.ok(detail, "必须剥到第三层才拿得到信号");
    assert.strictEqual(detail!.isQueued, true);
    assert.strictEqual(detail!.modelKey, "qfmodel");
    assert.strictEqual(detail!.queueType, "p3");
    assert.strictEqual(detail!.retryAfterSeconds, 30);
    assert.strictEqual(detail!.serviceAvailable, false);
  });

  test("只剥两层会误判，故必须剥到信号出现", () => {
    const two = JSON.stringify({
      code: "403",
      message: JSON.stringify({ code: "10605", message: "busy" }),
    });
    const { codes, detail } = decodeQueueError(two);
    assert.deepStrictEqual(codes, ["403", "10605"]);
    assert.strictEqual(detail, undefined, "无信号时不应伪造 detail");
  });

  test("非 JSON 体不解包、不抛错", () => {
    const r = decodeQueueError("<html>gateway</html>");
    assert.deepStrictEqual(r.codes, []);
    assert.strictEqual(r.detail, undefined);
  });
});

describe("qoder-fp queue: queue/status 响应解析", () => {
  test("解析平铺响应", () => {
    const s = parseQueueStatus(
      JSON.stringify({ isQueued: true, serviceAvailable: false, waitTime: 42, queueCount: 3 })
    );
    assert.ok(s);
    assert.strictEqual(s!.isQueued, true);
    assert.strictEqual(s!.waitTime, 42);
    assert.strictEqual(s!.queueCount, 3);
  });

  test("BFS 穿透 data / body 嵌套（对齐官方 x9e）", () => {
    const nested = JSON.stringify({
      data: { body: JSON.stringify({ isQueued: false, serviceAvailable: true, modelKey: "qfmodel" }) },
    });
    const s = parseQueueStatus(nested);
    assert.ok(s);
    assert.strictEqual(s!.isQueued, false);
    assert.strictEqual(s!.modelKey, "qfmodel");
  });

  test("字段容错：字符串数字与 \"true\"", () => {
    const s = parseQueueStatus(
      JSON.stringify({ isQueued: "true", retryAfterSeconds: "30", queueCount: "7" })
    );
    assert.ok(s);
    assert.strictEqual(s!.isQueued, true);
    assert.strictEqual(s!.retryAfterSeconds, 30);
    assert.strictEqual(s!.queueCount, 7);
  });

  test("无任何信号字段则视为无效载荷", () => {
    assert.strictEqual(parseQueueStatus(JSON.stringify({ foo: 1 })), null);
    assert.strictEqual(parseQueueStatus("not json"), null);
  });
});

describe("qoder-fp queue: 进度条与文案", () => {
  test("优先按队列长度缩短计算", () => {
    // 100 → 0 全部放行
    const half = computeQueueProgress(undefined, 50, 100, undefined, undefined);
    assert.strictEqual(half, Math.round(((100 - 50) / 100) * 95));
    assert.strictEqual(computeQueueProgress(undefined, 0, 100, undefined, undefined), 95);
  });

  test("其次按 已等待/最大等待", () => {
    const p = computeQueueProgress(undefined, undefined, undefined, 5_000, 10_000);
    assert.strictEqual(p, Math.round(0.5 * 95));
  });

  test("兜底每轮 +4，且只增不减、封顶 95、下限 3", () => {
    assert.strictEqual(computeQueueProgress({ progress: 0 }, undefined, undefined, undefined, undefined), 4);
    assert.strictEqual(computeQueueProgress({ progress: 94 }, undefined, undefined, undefined, undefined), 95);
    let p = 0;
    for (let i = 0; i < 100; i++) p = computeQueueProgress({ progress: p }, undefined, undefined, undefined, undefined);
    assert.strictEqual(p, PROGRESS_MAX);
  });

  test("四档等待文案（对齐官方 aF）", () => {
    assert.strictEqual(waitLabel(1_000), "estimated wait less than 1min");
    assert.strictEqual(waitLabel(60_000), "estimated wait 1min");
    assert.strictEqual(waitLabel(300_000), "estimated wait 5min");
    assert.strictEqual(waitLabel(600_000), "estimated wait over 10min");
    assert.strictEqual(waitLabel(undefined), undefined);
    assert.strictEqual(waitLabel(-1), undefined);
  });
});

describe("qoder-fp queue: UI 节流", () => {
  test("首帧必发；心跳 30s；waitTime 变化 ≥5s 或 ≥25% 时提前发", () => {
    const st = { emitted: false, lastEmittedAt: 0 } as any;
    assert.strictEqual(shouldEmitQueueView(st, { waitTime: 30 }, 1_000), true);
    markQueueViewEmitted(st, { waitTime: 30 }, 1_000);

    // 无变化 → 只有心跳才发
    assert.strictEqual(shouldEmitQueueView(st, { waitTime: 30 }, 5_000), false);
    assert.strictEqual(shouldEmitQueueView(st, { waitTime: 30 }, 31_000), true);

    // 绝对变化 ≥5s
    assert.strictEqual(shouldEmitQueueView(st, { waitTime: 36 }, 2_000), true);
    // 相对变化 ≥25%（30→38 为 26.7%）
    assert.strictEqual(shouldEmitQueueView(st, { waitTime: 38 }, 2_000), true);
  });

  test("queueCount 变化立即推送", () => {
    const st = { emitted: true, lastEmittedAt: 10_000, lastQueueCount: 5, lastWaitTimeMs: 30_000 } as any;
    assert.strictEqual(shouldEmitQueueView(st, { queueCount: 3, waitTime: 30 }, 10_100), true);
    assert.strictEqual(shouldEmitQueueView(st, { queueCount: 5, waitTime: 30 }, 10_100), false);
  });
});

describe("qoder-fp queue: 等待循环（对齐官方 pXe）", () => {
  /** 可控时钟 + 立即返回的 sleep，让循环可确定性断言。 */
  function harness(responses: QueueSignal[], opts: { maxWaitMs?: number } = {}) {
    let clock = 1_000_000;
    const views: any[] = [];
    const statuses: any[] = [];
    let idx = 0;
    const telemetry = createQueueTelemetry();

    const run = () =>
      waitInQueue({
        initialQueue: { isQueued: true, modelKey: "qfmodel", queueType: "p3", retryAfterSeconds: 30, serviceAvailable: false, waitTime: 30 },
        requestSetId: "rs-1",
        modelKey: "qfmodel",
        telemetry,
        onView: (v) => views.push(v),
        now: () => clock,
        // sleep 推进虚拟时钟但不真的等待
        sleep: async (ms: number) => {
          clock += ms;
        },
        maxWaitMs: opts.maxWaitMs ?? 3_600_000,
        fetchStatus: async (p) => {
          statuses.push(p);
          const next = responses[idx++];
          if (!next) throw new Error("no more scripted responses");
          return next;
        },
      });

    return { run, views, statuses, telemetry, advance: (ms: number) => (clock += ms), getClock: () => clock };
  }

  test("首次探测就放行：只轮询一次并返回 elapsed/maxWait", async () => {
    const h = harness([{ isQueued: false, serviceAvailable: true }]);
    const res = await h.run();
    assert.strictEqual(res.isQueued, false);
    assert.strictEqual(h.statuses.length, 1);
    assert.strictEqual(h.telemetry.pollCount, 1);
    assert.strictEqual(res.queueMaxWaitMs, 3_600_000);
    // 末帧应为 ready/100
    assert.strictEqual(h.views.at(-1).status, "ready");
    assert.strictEqual(h.views.at(-1).progress, 100);
  });

  test("排队中则持续轮询，并在放行后返回", async () => {
    const h = harness([
      { isQueued: true, serviceAvailable: true, retryAfterSeconds: 30, waitTime: 30 },
      { isQueued: true, serviceAvailable: true, retryAfterSeconds: 30, waitTime: 30 },
      { isQueued: false, serviceAvailable: true },
    ]);
    const res = await h.run();
    assert.strictEqual(res.isQueued, false);
    assert.strictEqual(h.statuses.length, 3);
    assert.strictEqual(h.telemetry.pollCount, 3);
  });

  test("serviceAvailable=false 时继续轮询（对齐官方 continue）", async () => {
    const h = harness([
      { isQueued: true, serviceAvailable: false, retryAfterSeconds: 30, waitTime: 30 },
      { isQueued: false, serviceAvailable: true },
    ]);
    await h.run();
    assert.strictEqual(h.telemetry.serviceUnavailableCount, 1);
  });

  test("超时抛 model queue wait timeout，并带上已等待时长", async () => {
    let clock = 1_000_000;
    const telemetry = createQueueTelemetry();
    await assert.rejects(
      () =>
        waitInQueue({
          initialQueue: { isQueued: true, retryAfterSeconds: 30 },
          requestSetId: "rs-1",
          modelKey: "qfmodel",
          telemetry,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
          maxWaitMs: 60_000,
          fetchStatus: async () => ({ isQueued: true, serviceAvailable: true, retryAfterSeconds: 30 }),
        }),
      /model queue wait timeout/
    );
    assert.ok((telemetry.waitMs ?? 0) >= 60_000, `已等待应达到上限，实际 ${telemetry.waitMs}`);
  });

  test("轮询连续失败 3 次即放弃（对齐官方 fre）", async () => {
    let clock = 1_000_000;
    const telemetry = createQueueTelemetry();
    await assert.rejects(
      () =>
        waitInQueue({
          initialQueue: { isQueued: true, retryAfterSeconds: 1 },
          requestSetId: "rs-1",
          modelKey: "qfmodel",
          telemetry,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
          maxWaitMs: 3_600_000,
          fetchStatus: async () => {
            throw new Error("boom");
          },
        }),
      /model queue status polling failed/
    );
    assert.strictEqual(telemetry.pollFailureCount, POLL_FAILURE_LIMIT);
  });

  test("端点不可用立即失败，不重试（对齐官方 queue_endpoint_unavailable）", async () => {
    let clock = 1_000_000;
    const telemetry = createQueueTelemetry();
    await assert.rejects(
      () =>
        waitInQueue({
          initialQueue: { isQueued: true, retryAfterSeconds: 1 },
          requestSetId: "rs-1",
          modelKey: "qfmodel",
          telemetry,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
          fetchStatus: async () => {
            throw Object.assign(new Error("endpoint gone"), { queue_endpoint_unavailable: true });
          },
        }),
      /endpoint gone/
    );
    assert.strictEqual(telemetry.endpointUnavailable, true);
    assert.strictEqual(telemetry.pollCount, 1);
  });

  test("中止信号即时打断", async () => {
    const ac = new AbortController();
    ac.abort(new Error("user aborted"));
    await assert.rejects(
      () =>
        waitInQueue({
          initialQueue: { isQueued: true, retryAfterSeconds: 30 },
          requestSetId: "rs-1",
          modelKey: "qfmodel",
          signal: ac.signal,
          fetchStatus: async () => ({ isQueued: true }),
        }),
      /user aborted/
    );
  });

  test("状态帧经节流后仍随 queueCount 变化推送", async () => {
    const h = harness([
      { isQueued: true, serviceAvailable: true, queueCount: 10, retryAfterSeconds: 30 },
      { isQueued: true, serviceAvailable: true, queueCount: 2, retryAfterSeconds: 30 },
      { isQueued: false, serviceAvailable: true },
    ]);
    await h.run();
    const queued = h.views.filter((v) => v.status === "queued");
    assert.ok(queued.length >= 2, `queueCount 变化应各自推帧，实际 ${queued.length}`);
    assert.ok(queued.some((v) => v.queueCount === 2));
  });
});

describe("qoder-fp queue: 状态栏渲染", () => {
  test("formatQueueView 输出进度条、文案与已等时长", () => {
    const text = formatQueueView({
      status: "queued",
      progress: 50,
      elapsedMs: 6_000,
      maxWaitMs: 3_600_000,
      label: "estimated wait less than 1min",
      queueCount: 3,
    });
    assert.ok(text.includes("50%"));
    assert.ok(text.includes("estimated wait less than 1min"));
    assert.ok(text.includes("已等 6s"));
    assert.ok(text.includes("前方 3"));
  });
});
