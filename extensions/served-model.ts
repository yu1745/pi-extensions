/**
 * pi extension: served-model
 *
 * Surface the model an OpenAI-family backend actually served, and show a warning
 * line ONLY when it genuinely differs from the requested one.
 *
 * Why: like Antigravity's `modelVersion` (where `gemini-3.1-pro` silently serves
 * `gemini-3.8-flash-n`), the Responses-API backends report the real model in the
 * raw stream — `response.model` on the `response.created` / `response.completed` /
 * `response.incomplete` / `response.done` events — but pi's built-in
 * implementations drop it (only `openai-completions` copies `chunk.model` onto
 * `AssistantMessage.responseModel`). Verified against CLIProxyAPI: the Codex
 * upstream populates `response.model` per event, and CLIProxyAPI itself parses it
 * (helps/response_model.go) with an `IsModelSubstituted` check for silent swaps.
 *
 * How (no monkey patching — `registerApiProvider` is a public extension point and
 * its Map-set semantics officially support overriding builtin api ids):
 * 1. Wrap the built-in `openai-responses` / `openai-codex-responses` /
 *    `azure-openai-responses` streams. Capture `response.model` from raw provider
 *    events via an injected `onProviderStreamEvent` (invoked before normalization,
 *    shared by the HTTP and Codex-WebSocket paths), then stamp the final
 *    `done` message with `responseModel` — mirroring core's completions behavior.
 *    `agent/proxy.ts` returns the `done` message object un-cloned, so the stamp
 *    propagates to session persistence (`responseModel` is already serialized)
 *    and to `message_end`.
 * 2. Render a transcript line under the reply when `responseModel` is a
 *    meaningful mismatch. Benign aliasing is not shown: dated snapshots
 *    (`gpt-5.2` → `gpt-5.2-2026-03-01`), 3-digit numeric versions, provider path
 *    prefixes and thinking-effort suffixes are normalized away (same policy as
 *    CLIProxyAPI's `IsModelSubstituted`).
 *
 * Antigravity replies are excluded: that extension renders its own always-on
 * `modelVersion` line.
 */

import {
  createAssistantMessageEventStream,
  getApiProvider,
  registerApiProvider,
  type Api,
  type ApiStreamFunction,
  type AssistantMessageEvent,
  type Model,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const WRAPPED_APIS = ["openai-responses", "openai-codex-responses", "azure-openai-responses"] as const;
const SOURCE_ID = "yu1745-served-model";
const ENTRY_NAME = "served-model";

interface ServedModelEntryData {
  /** Public model id that was requested. */
  requested: string;
  /** `response.model` the backend reported serving. */
  served: string;
}

// ─── mismatch judgment ────────────────────────────────────────────────────────

/** Routing-label suffixes (pi thinking-effort tags) that never reach the upstream body. */
const EFFORT_SUFFIXES = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "none", "off"]);

function normalizeModelId(id: string): string {
  let s = id.trim().toLowerCase();
  const slash = s.lastIndexOf("/");
  if (slash >= 0 && slash < s.length - 1) s = s.slice(slash + 1);
  const dash = s.lastIndexOf("-");
  if (dash > 0 && EFFORT_SUFFIXES.has(s.slice(dash + 1))) s = s.slice(0, dash);
  return s;
}

function isDateSuffix(suffix: string): boolean {
  return (suffix.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(suffix))
    || (suffix.length === 8 && /^\d{8}$/.test(suffix));
}

function isNumericVersionSuffix(suffix: string): boolean {
  return suffix.length === 3 && /^\d{3}$/.test(suffix);
}

/** `base` → `base-YYYY-MM-DD` / `base-YYYYMMDD` / `base-123` are snapshot pins, not substitutions. */
function isBenignSnapshot(base: string, variant: string): boolean {
  if (!variant.startsWith(`${base}-`)) return false;
  const suffix = variant.slice(base.length + 1);
  return isDateSuffix(suffix) || isNumericVersionSuffix(suffix);
}

export function isMeaningfulMismatch(requested: string, served: string): boolean {
  const req = normalizeModelId(requested);
  const srv = normalizeModelId(served);
  if (!req || !srv || req === srv) return false;
  return !isBenignSnapshot(req, srv) && !isBenignSnapshot(srv, req);
}

// ─── api stream wrapper ───────────────────────────────────────────────────────

/** Extract `response.model` from a raw Responses-API stream event, if present. */
function servedModelOf(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const response = (data as { response?: unknown }).response;
  if (!response || typeof response !== "object") return undefined;
  const model = (response as { model?: unknown }).model;
  return typeof model === "string" && model ? model : undefined;
}

function interceptOptions(
  options: StreamOptions | undefined,
  onServed: (data: unknown) => void,
): StreamOptions {
  const upstream = options?.onProviderStreamEvent?.bind(options);
  return {
    ...options,
    onProviderStreamEvent: async (data: unknown, model: Model<Api>) => {
      onServed(data);
      await upstream?.(data, model);
    },
  };
}

function wrapStreamFn(upstreamFn: ApiStreamFunction): ApiStreamFunction {
  return (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) => {
    let served: string | undefined;
    const upstream = upstreamFn(model, context, interceptOptions(options, (data) => {
      const reported = servedModelOf(data);
      // Last event wins: `response.created` is the first report, terminal
      // events re-confirm it. Raw events flow before normalization on both the
      // HTTP and Codex-WebSocket paths.
      if (reported) served = reported;
    }));
    const out = createAssistantMessageEventStream();
    void (async () => {
      let terminalForwarded = false;
      try {
        for await (const event of upstream as AsyncIterable<AssistantMessageEvent>) {
          if (event.type === "done") {
            terminalForwarded = true;
            if (served && !event.message.responseModel && event.message.model !== served) {
              event.message.responseModel = served;
            }
          } else if (event.type === "error") {
            terminalForwarded = true;
          }
          out.push(event);
        }
      } catch (err) {
        // Upstream streams push `error` events instead of throwing; this path is
        // only a guard against a producer that dies mid-iteration with no
        // terminal event forwarded, which would hang consumers.
        if (!terminalForwarded) {
          out.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "error",
              errorMessage: err instanceof Error ? err.message : String(err),
              timestamp: Date.now(),
            },
          });
        }
      } finally {
        out.end();
      }
    })();
    return out;
  };
}

function wrapServedModelApis(): void {
  for (const api of WRAPPED_APIS) {
    // Resolve the builtin BEFORE overriding; compat registers builtins at import.
    const builtin = getApiProvider(api);
    if (!builtin) continue;
    registerApiProvider(
      {
        api,
        stream: wrapStreamFn(builtin.stream),
        streamSimple: wrapStreamFn(builtin.streamSimple),
      },
      SOURCE_ID,
    );
  }
}

// ─── extension entry ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  wrapServedModelApis();

  pi.registerEntryRenderer<ServedModelEntryData>(ENTRY_NAME, (entry, _opts, theme) => {
    const { requested, served } = entry.data ?? {};
    if (!requested || !served || !isMeaningfulMismatch(requested, served)) return undefined;
    const servedText = theme.fg("warning", served);
    const asked = theme.fg("muted", `   asked for ${requested}`);
    return new Text(`${theme.fg("dim", "served")}  ${servedText}${asked}`, 2, 0);
  });

  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    // Only the apis this extension wraps; antigravity renders its own always-on line.
    if (!(WRAPPED_APIS as readonly string[]).includes(message.api)) return;
    const served = message.responseModel;
    if (!served || !isMeaningfulMismatch(message.model, served)) return;
    const data: ServedModelEntryData = { requested: message.model, served };
    // Defer by one macrotask so the entry lands BELOW the message, not above it.
    // (Pi dispatches extension events before TUI listeners; see the antigravity
    // extension's modelVersion renderer for the full analysis. Do not "simplify"
    // this back into a direct appendEntry — the line silently jumps above.)
    setTimeout(() => pi.appendEntry<ServedModelEntryData>(ENTRY_NAME, data), 0);
  });
}
