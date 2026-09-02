/**
 * pi extension: tool-duration
 *
 * Measure execution duration for every tool call and optionally inject the timing
 * metadata into the tool result returned to the LLM.
 *
 * Behavior:
 * - Disabled by default in new sessions (no injection into LLM context).
 * - Controlled exclusively by user CLI command: `/toolduration` or `/tool-duration`.
 *   (e.g. `/toolduration on`, `/toolduration off`, `/toolduration status`, or bare `/toolduration` to toggle).
 * - No custom tool registered for the model.
 * - When enabled:
 *   - Automatically computes duration for each tool call.
 *   - Injects timing banner (e.g. `[Tool execution duration: 124.5ms]`) to the top of text content blocks.
 *   - Injects `durationMs` into `details`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Session-scoped state (defaults to false in new sessions)
  let enabled = false;

  // Map to store start timestamps by toolCallId
  const startTimes = new Map<string, number>();

  // Track start time on tool_call
  pi.on("tool_call", async (event) => {
    startTimes.set(event.toolCallId, performance.now());
  });

  // Calculate duration on tool_result and inject if enabled
  pi.on("tool_result", async (event) => {
    const startTime = startTimes.get(event.toolCallId);
    if (startTime !== undefined) {
      startTimes.delete(event.toolCallId);
    }
    const elapsedMs = startTime !== undefined ? performance.now() - startTime : 0;
    const formattedDuration =
      elapsedMs >= 1000
        ? `${(elapsedMs / 1000).toFixed(2)}s`
        : `${elapsedMs.toFixed(1)}ms`;

    // Always attach durationMs to details for programmatic inspection
    const updatedDetails = {
      ...(event.details || {}),
      durationMs: Number(elapsedMs.toFixed(1)),
      durationFormatted: formattedDuration,
    };

    // If not enabled, return without modifying text content for LLM
    if (!enabled) {
      return { details: updatedDetails };
    }

    // When enabled, inject execution duration into LLM-visible content
    const banner = `[Tool execution duration: ${formattedDuration}]`;
    const newContent = Array.isArray(event.content)
      ? event.content.map((item, idx) => {
          if (idx === 0 && item.type === "text" && typeof item.text === "string") {
            return {
              ...item,
              text: `${banner}\n${item.text}`,
            };
          }
          return item;
        })
      : event.content;

    return {
      content: newContent,
      details: updatedDetails,
    };
  });

  // Reset/clean up on session lifecycle
  pi.on("session_start", async () => {
    enabled = false;
    startTimes.clear();
  });

  pi.on("session_shutdown", async () => {
    startTimes.clear();
  });

  // Register user command: /toolduration & /tool-duration (no LLM tool registered)
  const commandHandler = async (args: string | undefined, ctx: any) => {
    const raw = (args || "").trim().toLowerCase();
    if (raw === "on" || raw === "enable" || raw === "true" || raw === "1") {
      enabled = true;
    } else if (raw === "off" || raw === "disable" || raw === "false" || raw === "0") {
      enabled = false;
    } else if (raw === "status") {
      // just report
    } else {
      // toggle
      enabled = !enabled;
    }

    const msg = `Tool duration injection: ${enabled ? "ON" : "OFF"}`;
    ctx.ui?.notify(msg, "info");
    ctx.ui?.setStatus?.("tool-duration", enabled ? "⏱️ tool duration: ON" : "");
  };

  pi.registerCommand("toolduration", {
    description: "Toggle injecting execution duration into tool call results for LLM (on/off/status)",
    handler: commandHandler,
  });

  pi.registerCommand("tool-duration", {
    description: "Alias for /toolduration",
    handler: commandHandler,
  });
}
