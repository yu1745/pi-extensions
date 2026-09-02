import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 过滤/拦截 image-reader 扩展：
 * 1. 当主模型自身具有视觉能力（model.input 包含 "image"）时：
 *    - 在系统提示词中将 image-reader 从 Agent 工具的可用子代理列表中剔除，避免视觉模型误认为自己不能看图而主动分流给读图员。
 *    - 如果模型依然尝试通过 Agent 调用 image-reader，在 tool_call 中进行拦截并提示模型直接使用自带的 read 工具查看图片。
 * 2. 当主模型不具备视觉能力（纯文本模型）时：
 *    - 保留原样，允许正常使用 image-reader 子代理读图。
 */
export default function filterImageReaderExtension(pi: ExtensionAPI) {
  function modelHasVision(model: any): boolean {
    if (!model) return false;
    if (Array.isArray(model.input) && model.input.includes("image")) {
      return true;
    }
    return false;
  }

  // 1. 动态改写系统提示词中的子代理说明
  pi.on("before_agent_start", async (event, ctx) => {
    if (!modelHasVision(ctx.model)) {
      return;
    }

    let systemPrompt = event.systemPrompt;

    // 过滤系统提示词中 Agent 工具列表里的 image-reader 描述行
    // 匹配例如：- image-reader: Reads image files ... (Tools: read)
    const filteredPrompt = systemPrompt
      .replace(/^[ \t]*- image-reader:.*(?:\r?\n|$)/gm, "")
      // 清理可能遗留的连续多余空行
      .replace(/\n{3,}/g, "\n\n");

    if (filteredPrompt !== systemPrompt) {
      return {
        systemPrompt: filteredPrompt,
      };
    }
  });

  // 2. 拦截可能残留的对 image-reader 的 tool_call
  pi.on("tool_call", async (event, ctx) => {
    if (!modelHasVision(ctx.model)) {
      return;
    }

    if (event.toolName === "Agent" && event.input?.subagent_type === "image-reader") {
      return {
        block: true,
        reason:
          "当前模型本身已具备视觉(多模态)能力，无需且不应调用 image-reader 读图子代理。请直接使用 `read` 工具读取图片文件路径进行查看与分析。",
      };
    }
  });
}
