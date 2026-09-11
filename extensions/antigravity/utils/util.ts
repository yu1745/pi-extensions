import crypto from "node:crypto";
import type { Context } from "@earendil-works/pi-ai";
import { ANTIGRAVITY_MODEL_ENUM } from "../models/models.js";

export function antigravityEnv(name: string): string | undefined {
  return process.env[`ANTIGRAVITY_${name}`] || process.env[`NOAGY_${name}`];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function sanitizeText(text: unknown): string {
  return String(text ?? "").replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function nowRequestId(): string {
  return antigravityRequestEnvelope("unknown", false).requestId;
}

export function deriveStableContextIds(context?: Context): {
  sessionId: string;
  trajectoryId: string;
} {
  const first = context?.messages?.[0];
  const anchor =
    (context?.systemPrompt || "") +
    (first
      ? typeof first.content === "string"
        ? first.content
        : JSON.stringify(first.content)
      : "");

  if (!anchor) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const sessionId = String(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true));
    return {
      sessionId,
      trajectoryId: crypto.randomUUID(),
    };
  }

  const hash = crypto.createHash("sha256").update(anchor).digest();
  const sessionId = String(hash.readBigInt64LE(0));
  const trajectoryId = [
    hash.subarray(8, 12).toString("hex"),
    hash.subarray(12, 14).toString("hex"),
    hash.subarray(14, 16).toString("hex"),
    hash.subarray(16, 18).toString("hex"),
    hash.subarray(18, 24).toString("hex"),
  ].join("-");

  return { sessionId, trajectoryId };
}

export function antigravityRequestEnvelope(
  wireModelId: string,
  isClaude: boolean,
  options?: {
    sessionId?: string;
    trajectoryId?: string;
    step?: number;
  },
): { requestId: string; sessionId: string; labels: Record<string, string> } {
  const agentId = crypto.randomUUID();
  const trajectoryId = options?.trajectoryId || crypto.randomUUID();
  const step = options?.step ?? 2;
  let sessionId = options?.sessionId;
  if (!sessionId) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    sessionId = String(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true));
  }
  const usageLabel = isClaude ? "true" : "false";
  const labels: Record<string, string> = {
    last_step_index: String(Math.max(1, step - 1)),
    trajectory_id: trajectoryId,
    used_claude: usageLabel,
    used_claude_conservative: usageLabel,
  };
  const modelEnum = ANTIGRAVITY_MODEL_ENUM[wireModelId];
  if (modelEnum) labels.model_enum = modelEnum;
  return {
    requestId: `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`,
    sessionId,
    labels,
  };
}
