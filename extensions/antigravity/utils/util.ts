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

export type AntigravityRequestIdentity = {
  sessionId: string;
  trajectoryId: string;
  /** 1-based index of this model call inside the trajectory (agy's `request_id` suffix is callIndex - 1). */
  callIndex: number;
  /** True only for the first model call of a freshly created trajectory. */
  isNewTrajectory: boolean;
};

type TrajectoryState = {
  sessionId: string;
  trajectoryId: string;
  lastCallIndex: number;
};

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
      lastCallIndex: 0,
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
        lastCallIndex: 0,
      };
      states.set(key, state);
    }
  }

  state.lastCallIndex += 1;
  return {
    sessionId: state.sessionId,
    trajectoryId: state.trajectoryId,
    callIndex: state.lastCallIndex,
    isNewTrajectory: state.lastCallIndex === 1,
  };
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
    state = { sessionId: randomSessionId(), trajectoryId: crypto.randomUUID(), lastCallIndex: 0 };
    states.set("default", state);
  }
  return { sessionId: state.sessionId, trajectoryId: state.trajectoryId };
}

/**
 * Build the per-request envelope exactly as agy 1.2.x does.
 *
 * Measured against agy 1.2.4 (`streamGenerateContent`, requestType=agent):
 * ```
 * requestId: agent/<conversationId>/<epoch_ms>/<trajectoryId>/<step>
 * labels:    last_step_index = step - 1, request_id = <trajectoryId>-<callIndex-1>,
 *            model_enum, trajectory_id, used_claude, used_claude_conservative,
 *            used_non_gemini_model
 * ```
 * `step` is the number of `contents` entries the request carries (1 on the first turn,
 * 3 after one tool round-trip, ...); callers pass that in.
 */
export function antigravityRequestEnvelope(
  runtimeModel: string,
  options: {
    isClaude: boolean;
    /** Claude *and* GPT-OSS requests are reported as non-Gemini in labels. */
    isNonGeminiModel?: boolean;
    sessionId: string;
    trajectoryId: string;
    callIndex: number;
    /** Number of content entries carried by the request; the CLI's `step`. */
    step: number;
    /** Conversation id used in the requestId path; defaults to the session id. */
    conversationId?: string;
  },
): { requestId: string; sessionId: string; labels: Record<string, string> } {
  const step = Math.max(1, Math.trunc(options.step) || 1);
  const callIndex = Math.max(1, Math.trunc(options.callIndex) || 1);
  const usedClaude = options.isClaude ? "true" : "false";
  // Verified for every model advertised by `agy models` 1.2.4 (see ANTIGRAVITY_MODEL_ENUM).
  // A runtime id we have no enum for omits the label instead of guessing a routing value.
  const modelEnum = ANTIGRAVITY_MODEL_ENUM[runtimeModel];
  const labels: Record<string, string> = {
    last_step_index: String(step - 1),
    ...(modelEnum ? { model_enum: modelEnum } : {}),
    request_id: `${options.trajectoryId}-${callIndex - 1}`,
    trajectory_id: options.trajectoryId,
    used_claude: usedClaude,
    used_claude_conservative: usedClaude,
    used_non_gemini_model:
      options.isClaude || options.isNonGeminiModel === true ? "true" : "false",
  };
  return {
    requestId: `agent/${options.conversationId || options.sessionId}/${Date.now()}/${options.trajectoryId}/${step}`,
    sessionId: options.sessionId,
    labels,
  };
}
