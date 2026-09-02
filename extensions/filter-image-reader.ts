import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 过滤/拦截 image-reader 子代理：
 *
 * 背景坑：`- image-reader: ...` 列表位于 pi-subagents 注册的 Agent 工具
 * description（工具 schema）里，而 before_agent_start 拿到的 systemPrompt
 * 并不包含它（实测 hasImageReaderLine=false），pi 也没有修改已注册工具
 * description 的 API——所以"从提示词里删掉这一行"的旧方案是空转。
 *
 * 现行方案（两层）：
 * 1. 当主模型自身具有视觉能力（model.input 包含 "image"）时，向系统提示词
 *    末尾注入一条明确指令：读图直接用 read，不要调用 image-reader。这能
 *    真正到达模型，从源头减少误调用。
 * 2. tool_call 硬拦截：若模型仍然调用 Agent(image-reader)，直接 block 并
 *    提示改用 read。已实测有效（子代理不会真正启动）。
 *
 * 纯文本模型不受影响，正常走 image-reader 子代理。
 */

const VISION_DIRECTIVE =
	"\n\n# 读图规则（重要）\n\n当前主模型已具备视觉（多模态）能力。识别、查看、分析图片时，直接使用 `read` 工具读取图片路径即可，禁止调用 image-reader 子代理——那是为纯文本模型准备的降级方案。";

export default function filterImageReaderExtension(pi: ExtensionAPI) {
	function modelHasVision(model: { input?: string[] } | undefined | null): boolean {
		return Array.isArray(model?.input) && model.input.includes("image");
	}

	// 1. 注入正向指令（替代无效的"删行"方案）
	pi.on("before_agent_start", async (event, ctx) => {
		if (!modelHasVision(ctx.model)) return;
		if (event.systemPrompt.includes("# 读图规则")) return; // 幂等
		return {
			systemPrompt: event.systemPrompt + VISION_DIRECTIVE,
		};
	});

	// 2. 硬拦截兜底：模型仍调用时直接 block
	pi.on("tool_call", async (event, ctx) => {
		if (!modelHasVision(ctx.model)) return;

		const input = event.input as Record<string, unknown> | undefined;
		if (event.toolName === "Agent" && input?.subagent_type === "image-reader") {
			return {
				block: true,
				reason:
					"当前模型本身已具备视觉(多模态)能力，无需且不应调用 image-reader 读图子代理。请直接使用 `read` 工具读取图片文件路径进行查看与分析。",
			};
		}
	});
}
