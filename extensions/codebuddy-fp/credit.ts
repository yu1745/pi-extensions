import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const CREDIT_ENTRY_TYPE = "codebuddy-credit-usage";

interface CreditUsageEntry {
  credit: number;
  model: string;
}

/** 从 OpenAI-completions 原始 SSE chunk 提取腾讯特有的本次积分消耗。 */
export function creditFromProviderData(data: unknown): number | undefined {
  if (!data || typeof data !== "object") return undefined;
  const credit = (data as { usage?: { credit?: unknown } }).usage?.credit;
  if (typeof credit !== "number" && typeof credit !== "string") return undefined;
  const value = typeof credit === "number" ? credit : Number(credit);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 小积分不转成科学计数法，也不把小数四舍五入成 0。 */
export function formatCredit(credit: number): string {
  if (Number.isInteger(credit)) return credit.toLocaleString("en-US");
  if (credit !== 0 && Math.abs(credit) < 1e-6) return credit.toFixed(20).replace(/0+$/, "");
  return String(credit);
}

/** 将积分作为不进入模型上下文的持久化条目，放在对应 assistant turn 之后。 */
export function registerCreditUsage(pi: ExtensionAPI): void {
  let current: CreditUsageEntry | undefined;
  let completed: CreditUsageEntry | undefined;

  pi.registerEntryRenderer<CreditUsageEntry>(CREDIT_ENTRY_TYPE, (entry, _options, theme) => {
    if (!entry.data || !Number.isFinite(entry.data.credit)) return undefined;
    return new Text(
      theme.fg("dim", `CodeBuddy · 本次消耗 ${formatCredit(entry.data.credit)} 积分`),
      0,
      0,
    );
  });

  pi.on("turn_start", () => {
    current = undefined;
    completed = undefined;
  });

  pi.on("provider_stream_event", (event) => {
    if (event.provider !== "codebuddy") return;
    const credit = creditFromProviderData(event.data);
    if (credit !== undefined) current = { credit, model: event.model };
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || event.message.provider !== "codebuddy") {
      current = undefined;
      return;
    }
    completed = current;
    current = undefined;
  });

  // 必须等工具结果落盘后再插入，不能把条目夹在 tool call 与 tool result 之间。
  pi.on("turn_end", () => {
    if (completed) pi.appendEntry<CreditUsageEntry>(CREDIT_ENTRY_TYPE, completed);
    completed = undefined;
  });
}
