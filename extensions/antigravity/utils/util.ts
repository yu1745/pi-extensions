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

export type AntigravityRequestIdentity = {
  sessionId: string;
  trajectoryId: string;
  step: number;
};

type TrajectoryState = Omit<AntigravityRequestIdentity, "step"> & { lastStep: number };

const contextStates = new WeakMap<Context, Map<string, TrajectoryState>>();
const explicitStates = new Map<string, TrajectoryState>();

function randomSessionId(): string {
  return String(crypto.randomBytes(8).readBigInt64LE());
}

/** Create an RFC 4122 variant/version-5 UUID from collision-safe framed input. */
function derivedUuid(namespace: string, value: string): string {
  const dnsNamespace = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
  const framed = `${Buffer.byteLength(namespace)}:${namespace}${Buffer.byteLength(value)}:${value}`;
  const hash = crypto.createHash("sha1").update(dnsNamespace).update(framed).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getExplicitState(key: string, create: () => TrajectoryState): TrajectoryState {
  const existing = explicitStates.get(key);
  if (existing) return existing;
  const state = create();
  explicitStates.set(key, state);
  return state;
}

/**
 * Allocate identity for one logical provider call. Call this once, then reuse the
 * result for endpoint/model/empty-response retries. Context identity is kept by
 * object reference, so equal prompts in concurrent contexts never collide.
 */
export function prepareAntigravityRequestIdentity(
  context: Context,
  options?: { sessionId?: string; trajectoryId?: string },
): AntigravityRequestIdentity {
  const explicitSessionId = asString(options?.sessionId)?.trim();
  const explicitTrajectoryId = asString(options?.trajectoryId)?.trim();
  let state: TrajectoryState;

  if (explicitSessionId) {
    const trajectoryId =
      explicitTrajectoryId || derivedUuid("antigravity-explicit-session", explicitSessionId);
    const key = `${Buffer.byteLength(explicitSessionId)}:${explicitSessionId}${Buffer.byteLength(trajectoryId)}:${trajectoryId}`;
    state = getExplicitState(key, () => ({
      sessionId: explicitSessionId,
      trajectoryId,
      lastStep: 1,
    }));
  } else {
    let states = contextStates.get(context);
    if (!states) {
      states = new Map();
      contextStates.set(context, states);
    }
    const key = explicitTrajectoryId ? `trajectory:${explicitTrajectoryId}` : "default";
    const existing = states.get(key);
    if (existing) {
      state = existing;
    } else {
      state = {
        sessionId: randomSessionId(),
        trajectoryId: explicitTrajectoryId || crypto.randomUUID(),
        lastStep: 1,
      };
      states.set(key, state);
    }
  }

  state.lastStep += 1;
  return { sessionId: state.sessionId, trajectoryId: state.trajectoryId, step: state.lastStep };
}

/** Backward-compatible identity lookup; does not advance the trajectory step. */
export function deriveStableContextIds(context: Context): {
  sessionId: string;
  trajectoryId: string;
} {
  let states = contextStates.get(context);
  if (!states) {
    states = new Map();
    contextStates.set(context, states);
  }
  let state = states.get("default");
  if (!state) {
    state = { sessionId: randomSessionId(), trajectoryId: crypto.randomUUID(), lastStep: 1 };
    states.set("default", state);
  }
  return { sessionId: state.sessionId, trajectoryId: state.trajectoryId };
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
