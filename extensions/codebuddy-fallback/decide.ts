/**
 * codebuddy-fallback 的纯逻辑部分（无 pi 运行时依赖，方便测试）。
 *
 * 这里只回答三个问题：
 * 1. 这次失败该不该切走？（{@link isFallbackTrigger}）
 * 2. 失败的（或正在探测的）模型和备用模型分别是哪个？（{@link matchesPrimary} / {@link pickFallback}）
 * 3. 探测结果算不算"恢复了"？（{@link isProbeHealthy}）
 */

/** 可注入以便测试的最小 model 形状。 */
export interface ModelLike {
  provider: string;
  id: string;
  api?: string;
}

/** 触发 fallback 的依据，来自 turn_end 的 outcome 与失败消息。 */
export interface FailureLike {
  stopReason?: string;
  errorMessage?: string;
}

export interface FallbackTargets {
  /** 主动力模型（codebuddy 的 deepseek v4.1 flash）。 */
  provider: string;
  modelId: string;
  /** 备用模型（DeepSeek 官方的 deepseek-flash）。 */
  fallbackProvider: string;
  fallbackModelId: string;
}

export const DEFAULT_TARGETS: FallbackTargets = {
  provider: "codebuddy",
  modelId: "deepseek-v4.1-flash (x0.11)",
  fallbackProvider: "deepseek",
  fallbackModelId: "deepseek-flash",
};

/**
 * 是否是本扩展负责的主动力模型。
 *
 * codebuddy 的模型 id 由官方 /v3/config 动态生成，带着倍率后缀
 * （`deepseek-v4.1-flash (x0.11)` / `deepseek-v4.1-flash (x0.03)` …），倍率会变，
 * 所以按"去掉括号后归一化"的前缀匹配，而不是死盯完整 id。
 */
export function matchesPrimary(model: ModelLike | undefined, targets: FallbackTargets): boolean {
  if (!model) return false;
  if (model.provider !== targets.provider) return false;
  const bare = normalizeModelId(model.id);
  const want = normalizeModelId(targets.modelId);
  if (bare === want) return true;
  // 上游 id 形式（deepseek-v4.1-flash）与带版本号的变体都算同一个模型。
  return bare.startsWith("deepseek-v4.1-flash") && want.startsWith("deepseek-v4.1-flash");
}

/** 去掉倍率括号、小写、去首尾空白。 */
export function normalizeModelId(id: string): string {
  return id.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
}

/**
 * 上下文溢出不在这里处理：pi 自带的 compaction 恢复路径更合适，
 * 换模型只会掩盖问题并浪费一次压缩机会。
 */
const OVERFLOW_PATTERNS = [
  /exceeds the context window/i,
  /maximum context length/i,
  /prompt is too long/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /context window exceeds limit/i,
];

export function isContextOverflowText(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  if (/rate limit|too many requests/i.test(errorMessage)) return false;
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * 判断这次 turn 失败是否应触发 fallback。
 *
 * 用户主动中断（aborted）永远不触发；上下文溢出交给 compaction；其余任何
 * error（429 / 配额耗尽 / 5xx / 网络 / 鉴权 / 模型下架 ……）都算"不可用"。
 */
export function isFallbackTrigger(message: FailureLike): boolean {
  if (message.stopReason !== "error") return false;
  if (!message.errorMessage) return true;
  return !isContextOverflowText(message.errorMessage);
}

/** 从候选模型列表里挑备用模型：优先精确 id，其次任意该 provider 的可用 chat 模型。 */
export function pickFallback(models: readonly ModelLike[], targets: FallbackTargets): ModelLike | undefined {
  const sameProvider = models.filter((model) => model.provider === targets.fallbackProvider);
  const exact = sameProvider.find((model) => model.id === targets.fallbackModelId);
  return exact ?? sameProvider[0];
}

/** 探测成功的判定：无 error / aborted，且有实际输出。 */
export function isProbeHealthy(message: FailureLike & { content?: readonly { type: string }[] }): boolean {
  if (message.stopReason === "error" || message.stopReason === "aborted") return false;
  if (isContextOverflowText(message.errorMessage)) return false;
  return true;
}

/** 探测用的最小对话：只要求模型回一个字，避免拉长延迟和花费。 */
export const PROBE_MESSAGES = [
  { role: "user" as const, content: [{ type: "text" as const, text: "ping" }] },
];
