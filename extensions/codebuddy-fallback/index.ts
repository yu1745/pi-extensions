/**
 * codebuddy-fallback — CodeBuddy 不可用时自动切到 DeepSeek 官方，并在后台探测恢复。
 *
 * 行为
 * ----
 * 1. 主模型 = codebuddy 的 DeepSeek V4.1 Flash（id 带倍率后缀，按前缀归一化匹配）。
 * 2. 这一轮以 error 结束时（429 / 配额耗尽 / 5xx / 网络 / 鉴权 / 模型下架 …… 任何
 *    不可用都算；用户主动 Esc 中断和上下文溢出除外），在 turn_end 边界里
 *    ① 用 context_edit(null) 把失败的 assistant 消息从模型上下文里剔掉，
 *    ② pi.setModel() 切到 deepseek 官方的 deepseek-flash，
 *    ③ 追加一条说明消息并返回 continue: true，让 agent **在同一轮内**用新模型重发。
 *    因为 turn_end 早于 pi 自己的指数退避重试，这里不会白等 3 次重试。
 * 3. 进入备用后启动后台探测：每 5 分钟对 codebuddy 发一次 ping（maxTokens=16），
 *    成功就自动切回主模型并恢复原来的 thinking level；失败就继续等下一轮。
 * 4. 每轮 run 最多 fallback 一次，避免两个模型互相甩锅死循环。
 * 5. 用户在备用期间手动换模型 → 视为用户接管，取消探测，不再自动切回。
 *
 * 状态落在会话分支上（custom entry codebuddy-fallback-state），所以 /resume、
 * /fork 之后仍知道"当前处于备用状态"并继续探测。
 *
 * 开关：/codebuddy-fallback on|off|status|probe|restore，持久化在
 * <agent-dir>/settings.json 的 codebuddyFallback 键（默认开启）。
 */

import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  DEFAULT_TARGETS,
  isFallbackTrigger,
  isProbeHealthy,
  matchesPrimary,
  pickFallback,
  PROBE_MESSAGES,
  type FallbackTargets,
  type ModelLike,
} from "./decide.ts";
import {
  getCodebuddyFallbackEnabled,
  isFallbackEnvForced,
  setCodebuddyFallbackEnabled,
} from "./settings.ts";

/** 会话里记录 fallback 状态的自定义 entry 类型。 */
const STATE_ENTRY = "codebuddy-fallback-state";
/** 注入给模型的说明消息类型。 */
const NOTICE_TYPE = "codebuddy-fallback-notice";
/** footer 状态条 key。 */
const STATUS_KEY = "codebuddy-fallback";
/** 后台探测间隔：5 分钟。 */
const PROBE_INTERVAL_MS = 5 * 60 * 1000;
/** 单次探测超时。 */
const PROBE_TIMEOUT_MS = 45 * 1000;

interface FallbackStateData {
  /** 是否处于"主模型不可用、已切到备用"的状态。 */
  active: boolean;
  /** 切走时的主模型（provider/id），用于切回。 */
  primary?: { provider: string; id: string };
  /** 切走时的 thinking level，切回时恢复。 */
  thinkingLevel?: string;
  /** 切走的时间戳（ms）。 */
  since?: number;
  /** 最近一次探测失败的原因（仅用于状态展示）。 */
  lastProbeError?: string;
}

interface Runtime {
  targets: FallbackTargets;
  /** 当前是否在备用状态。 */
  active: boolean;
  /** 主模型 provider/id + thinking level，切回时用。 */
  primary?: { provider: string; id: string };
  thinkingLevel?: string;
  since?: number;
  lastProbeError?: string;
  /** 后台探测定时器。 */
  timer?: ReturnType<typeof setInterval>;
  /** 正在探测中（避免重入）。 */
  probing: boolean;
  /** 本轮 run 是否已经 fallback 过。 */
  fallbackDoneInRun: boolean;
  /** 我们自己调用 setModel 时置位，避免 model_select 把自动切换当成用户接管。 */
  selfSelecting: boolean;
}

/**
 * AssistantMessage 的字段是 `model`，Model 的字段是 `id`；两者都可能是"当前模型"，
 * 所以统一映射成 { provider, id } 再用，避免各处各写一遍。
 */
function modelLike(model: { provider?: string; id?: string } | undefined): ModelLike {
  return { provider: model?.provider ?? "", id: model?.id ?? "" };
}

function messageModelLike(message: { provider?: string; model?: string; id?: string }): ModelLike {
  return { provider: message.provider ?? "", id: message.model ?? message.id ?? "" };
}

function modelKey(model: ModelLike): string {
  return model.provider + "/" + model.id;
}

function fallbackKey(targets: FallbackTargets): string {
  return targets.fallbackProvider + "/" + targets.fallbackModelId;
}

/** 在模型目录里找主模型：codebuddy 的 id 带倍率后缀，所以按归一化前缀找。 */
function findPrimary(ctx: ExtensionContext, targets: FallbackTargets): Model<any> | undefined {
  const all = ctx.modelRegistry.getAll() as Model<any>[];
  const codebuddy = all.filter((model) => model.provider === targets.provider);
  return codebuddy.find((model) => matchesPrimary(modelLike(model), targets));
}

/** 备用模型：优先 deepseek 官方的 deepseek-flash，且必须已配置凭证。 */
function findFallback(ctx: ExtensionContext, targets: FallbackTargets): Model<any> | undefined {
  const registry = ctx.modelRegistry as any;
  const pools: ModelLike[][] = [];
  try {
    pools.push(registry.getAvailable() as ModelLike[]);
  } catch {
    // 可用快照暂时不可读时退回全量目录
  }
  try {
    pools.push(registry.getAll() as ModelLike[]);
  } catch {
    return undefined;
  }
  for (const pool of pools) {
    const picked = pickFallback(pool, targets) as Model<any> | undefined;
    if (!picked) continue;
    if (!ctx.modelRegistry.hasConfiguredAuth(picked)) continue;
    return picked;
  }
  return undefined;
}

/** 从会话分支重建状态（/resume、/fork 之后）。 */
function readStateFromBranch(ctx: ExtensionContext): FallbackStateData | undefined {
  let latest: FallbackStateData | undefined;
  for (const entry of ctx.sessionManager.getBranch() as SessionEntry[]) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
    const data = entry.data as FallbackStateData | undefined;
    if (data && typeof data.active === "boolean") latest = data;
  }
  return latest;
}

export default function (pi: ExtensionAPI) {
  const state: Runtime = {
    targets: { ...DEFAULT_TARGETS },
    active: false,
    probing: false,
    fallbackDoneInRun: false,
    selfSelecting: false,
  };

  function enabled(): boolean {
    return getCodebuddyFallbackEnabled();
  }

  function renderStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (!state.active) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const hint = state.probing ? "探测中" : "每 5 分钟探测";
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "CB→" + fallbackKey(state.targets) + " " + hint));
  }

  function stopWatchdog(): void {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = undefined;
    }
  }

  function persist(ctx: ExtensionContext, data: FallbackStateData): void {
    try {
      pi.appendEntry<FallbackStateData>(STATE_ENTRY, data);
    } catch {
      // 状态持久化失败不影响本次切换
    }
  }

  /** 探测一次 codebuddy 是否已恢复。 */
  async function probePrimary(ctx: ExtensionContext): Promise<{ ok: boolean; reason?: string }> {
    const primary = findPrimary(ctx, state.targets);
    if (!primary) return { ok: false, reason: "codebuddy 目录里找不到 deepseek-v4.1-flash" };
    let signal: AbortSignal | undefined;
    try {
      const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
      signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    } catch {
      signal = undefined;
    }
    try {
      const stream = ctx.modelRegistry.streamSimple(
        primary,
        { messages: PROBE_MESSAGES as any },
        { maxTokens: 16, signal },
      );
      const message = (await stream.result()) as AssistantMessage;
      if (isProbeHealthy(message)) return { ok: true };
      return { ok: false, reason: message.errorMessage || "探测返回 " + message.stopReason };
    } catch (error: any) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  /** 切回主模型（默认先在后台探测，成功才切）。 */
  async function restore(ctx: ExtensionContext, options: { force?: boolean; silent?: boolean } = {}): Promise<boolean> {
    if (!state.active) return false;
    const primary = findPrimary(ctx, state.targets);
    if (!primary) {
      state.lastProbeError = "codebuddy 目录里找不到 deepseek-v4.1-flash";
      renderStatus(ctx);
      return false;
    }
    state.probing = true;
    renderStatus(ctx);
    try {
      const probe = options.force ? { ok: true } : await probePrimary(ctx);
      if (!probe.ok) {
        state.lastProbeError = probe.reason;
        return false;
      }
      state.selfSelecting = true;
      let switched = false;
      try {
        switched = await pi.setModel(primary);
      } finally {
        state.selfSelecting = false;
      }
      if (!switched) {
        state.lastProbeError = modelKey(modelLike(primary)) + " 没有可用凭证";
        return false;
      }
      if (state.thinkingLevel) {
        try {
          pi.setThinkingLevel(state.thinkingLevel as any);
        } catch {
          // thinking level 不被新模型支持时忽略
        }
      }
      const from = fallbackKey(state.targets);
      state.active = false;
      state.lastProbeError = undefined;
      stopWatchdog();
      persist(ctx, { active: false });
      if (!options.silent && ctx.hasUI) {
        ctx.ui.notify("CodeBuddy 已恢复：" + from + " → " + modelKey(modelLike(primary)), "info");
      }
      renderStatus(ctx);
      return true;
    } finally {
      state.probing = false;
      renderStatus(ctx);
    }
  }

  function startWatchdog(ctx: ExtensionContext): void {
    stopWatchdog();
    const timer = setInterval(() => {
      void (async () => {
        if (!state.active || state.probing) return;
        if (!enabled()) return;
        try {
          await restore(ctx);
          renderStatus(ctx);
        } catch {
          // 探测异常不打断主流程
        }
      })();
    }, PROBE_INTERVAL_MS);
    // 不要因为后台探测把 pi 进程钉住
    (timer as any).unref?.();
    state.timer = timer;
  }

  /** 进入备用状态：切模型 + 落状态 + 起探测。 */
  async function enterFallback(
    ctx: ExtensionContext,
    failedModel: ModelLike,
  ): Promise<{ ok: boolean; message: string }> {
    const fallback = findFallback(ctx, state.targets);
    if (!fallback) {
      return {
        ok: false,
        message: "CodeBuddy 不可用，但 " + fallbackKey(state.targets) + " 没有可用凭证",
      };
    }
    const previousThinking = pi.getThinkingLevel();
    state.selfSelecting = true;
    let switched = false;
    try {
      switched = await pi.setModel(fallback);
    } finally {
      state.selfSelecting = false;
    }
    if (!switched) {
      return { ok: false, message: "切到 " + modelKey(modelLike(fallback)) + " 失败：provider 没有可用凭证" };
    }
    state.active = true;
    state.primary = { provider: failedModel.provider, id: failedModel.id };
    state.thinkingLevel = previousThinking;
    state.since = Date.now();
    state.lastProbeError = undefined;
    persist(ctx, {
      active: true,
      primary: state.primary,
      thinkingLevel: previousThinking,
      since: state.since,
    });
    startWatchdog(ctx);
    renderStatus(ctx);
    return {
      ok: true,
      message: "CodeBuddy 不可用（" + modelKey(failedModel) + "），已切到 " + modelKey(modelLike(fallback)) + " 重发",
    };
  }

  // ── turn_end：主模型这一轮失败 → 切备用并原地重发 ────────────────────────
  pi.on("turn_end", async (event, ctx) => {
    if (!enabled()) return;
    const message = event.message;
    if (!message || message.role !== "assistant") return;
    const failed = messageModelLike(message);
    // 只处理主动力模型的失败
    if (!matchesPrimary(failed, state.targets)) return;
    if (!isFallbackTrigger(message as AssistantMessage)) return;
    if (state.fallbackDoneInRun) return;
    state.fallbackDoneInRun = true;

    const result = await enterFallback(ctx, failed);
    if (!result.ok) {
      if (ctx.hasUI) ctx.ui.notify(result.message, "error");
      return;
    }
    if (ctx.hasUI) ctx.ui.notify(result.message, "warning");

    const entries: any[] = [];
    // 失败的 assistant 消息从模型上下文里剔掉（原始历史保留，可 /tree 查看）
    if (event.messageEntryId) {
      entries.push({ type: "context_edit", targetId: event.messageEntryId, replacement: null });
    }
    // 一条说明消息，同时让 canContinue 成立（末条不再是 assistant）
    entries.push({
      type: "custom_message",
      customType: NOTICE_TYPE,
      content:
        "[codebuddy-fallback] " +
        result.message +
        "。请基于上面的对话继续完成任务，不要提及这次模型切换。",
      display: true,
      details: { from: modelKey(failed), to: fallbackKey(state.targets) },
    });
    return { continue: true, entries };
  });

  // ── run 边界：每轮 run 只 fallback 一次 ─────────────────────────────────
  pi.on("agent_start", async () => {
    state.fallbackDoneInRun = false;
  });

  // ── 用户手动换模型 → 视为用户接管，停止自动切回 ─────────────────────────
  pi.on("model_select", async (event, ctx) => {
    if (state.selfSelecting) return;
    if (!state.active) return;
    if (modelKey(modelLike(event.model)) === fallbackKey(state.targets)) return;
    state.active = false;
    state.lastProbeError = undefined;
    stopWatchdog();
    persist(ctx, { active: false });
    renderStatus(ctx);
    if (ctx.hasUI) ctx.ui.notify("已手动切换模型，codebuddy-fallback 停止自动切回", "info");
  });

  // ── 会话生命周期 ────────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    state.fallbackDoneInRun = false;
    stopWatchdog();
    const saved = readStateFromBranch(ctx);
    if (saved?.active) {
      state.active = true;
      state.primary = saved.primary;
      state.thinkingLevel = saved.thinkingLevel;
      state.since = saved.since;
      // 恢复后当前模型应当就是备用模型；用户若已改过就不接管
      if (modelKey(modelLike(ctx.model)) !== fallbackKey(state.targets)) {
        state.active = false;
        persist(ctx, { active: false });
      } else {
        startWatchdog(ctx);
      }
    } else {
      state.active = false;
    }
    renderStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopWatchdog();
    state.probing = false;
  });

  // ── 说明消息的渲染 ──────────────────────────────────────────────────────
  pi.registerMessageRenderer(NOTICE_TYPE, (message, _options, theme) => {
    const details = message.details as { from?: string; to?: string } | undefined;
    const head = theme.fg("warning", "fallback");
    const from = details?.from ? theme.fg("muted", details.from) : "";
    const to = details?.to ? theme.fg("success", details.to) : "";
    const arrow = from && to ? "  " + from + " → " + to : "";
    return new Text(head + arrow, 2, 0);
  });

  // ── /codebuddy-fallback ─────────────────────────────────────────────────
  pi.registerCommand("codebuddy-fallback", {
    description: "CodeBuddy 不可用时自动切到 DeepSeek 官方；无参数查看状态，on|off|probe|restore 控制",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "on", label: "on —— 开启自动 fallback（默认）" },
        { value: "off", label: "off —— 关闭，行为与未安装本扩展一致" },
        { value: "status", label: "status —— 查看当前状态" },
        { value: "probe", label: "probe —— 立刻探测一次 CodeBuddy" },
        { value: "restore", label: "restore —— 立刻切回 CodeBuddy（不探测）" },
      ].filter((item) => item.value.startsWith(prefix));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = args.trim().toLowerCase();

      const statusText = (): string => {
        const flag = enabled() ? "on" : "off";
        const forced = isFallbackEnvForced() ? "（环境变量 CODEBUDDY_FALLBACK 优先）" : "";
        const lines = ["自动 fallback：" + flag + forced];
        if (state.active) {
          const since = state.since ? new Date(state.since).toLocaleString() : "?";
          lines.push("当前处于备用状态：" + fallbackKey(state.targets) + "（自 " + since + "）");
          lines.push("后台每 " + PROBE_INTERVAL_MS / 60000 + " 分钟探测一次 CodeBuddy，恢复后自动切回");
          if (state.lastProbeError) lines.push("上次探测失败：" + state.lastProbeError);
        } else {
          lines.push("当前没有处于备用状态（主模型：" + state.targets.provider + "/" + state.targets.modelId + "）");
        }
        return lines.join("\n");
      };

      if (!arg || arg === "status") {
        ctx.ui.notify(statusText(), "info");
        return;
      }

      if (arg === "on" || arg === "off") {
        const want = arg === "on";
        if (want === enabled()) {
          ctx.ui.notify("自动 fallback 已经是 " + arg + "，未改动", "info");
          return;
        }
        try {
          setCodebuddyFallbackEnabled(want);
        } catch (error: any) {
          ctx.ui.notify("写入 settings.json 失败：" + (error?.message ?? error), "error");
          return;
        }
        if (!want) {
          stopWatchdog();
          if (state.active) {
            state.active = false;
            persist(ctx, { active: false });
          }
          renderStatus(ctx);
        } else if (state.active) {
          startWatchdog(ctx);
        }
        ctx.ui.notify("自动 fallback 已" + (want ? "开启" : "关闭") + "（已持久化，立即生效）", want ? "info" : "warning");
        return;
      }

      if (arg === "probe") {
        if (!state.active) {
          ctx.ui.notify("当前不在备用状态，无需探测", "info");
          return;
        }
        const probe = await probePrimary(ctx);
        if (probe.ok) {
          const restored = await restore(ctx);
          ctx.ui.notify(restored ? "CodeBuddy 已恢复，已切回" : "探测成功但切回失败，详见状态", restored ? "info" : "error");
        } else {
          state.lastProbeError = probe.reason;
          renderStatus(ctx);
          ctx.ui.notify("CodeBuddy 仍不可用：" + (probe.reason ?? "未知原因"), "warning");
        }
        return;
      }

      if (arg === "restore") {
        if (!state.active) {
          ctx.ui.notify("当前不在备用状态", "info");
          return;
        }
        const restored = await restore(ctx, { force: true });
        ctx.ui.notify(restored ? "已切回 CodeBuddy" : "切回失败：" + (state.lastProbeError ?? "未知原因"), restored ? "info" : "error");
        return;
      }

      ctx.ui.notify("用法：/codebuddy-fallback [on|off|status|probe|restore]", "error");
    },
  });
}
