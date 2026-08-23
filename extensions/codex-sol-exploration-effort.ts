import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const INSTRUCTION = "For codebase exploration or research, call the Agent tool with `subagent_type` set to `Explore`, `model` set to `openai-codex/gpt-5.6-luna` (the full model name; `luna` is only a shorthand), and `thinking` set explicitly to either `low` or `medium`, choosing the lower level unless the task requires more reasoning. Do not omit these parameters.";
const MARKER = "[codex-sol-exploration-effort]";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const model = ctx.model;
    if (!model) return;

    // Only match the native OpenAI Codex model, not similarly named models
    // from other providers.
    if (model.provider !== "openai-codex" || model.id !== "gpt-5.6-sol") {
      return;
    }

    if (event.systemPrompt.includes(MARKER)) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${MARKER}\n${INSTRUCTION}`,
    };
  });
}
