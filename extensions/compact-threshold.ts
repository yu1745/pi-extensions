/**
 * Session-local Compact Threshold Extension
 *
 * 功能：手动把"当前会话"的自动压缩阈值从内置默认（≈90%，即 contextWindow - 16384
 * reserveTokens）降低到你指定的百分比。上下文用量达到该百分比时，在安全时点
 * （agent_settled，agent 完全停下且无自动续跑）自动触发一次 /compact。
 *
 * 会话级设计（这是本扩展的核心要求）：
 *  - 阈值只存在扩展实例的闭包变量里，不写任何 settings.json
 *  - 扩展随会话加载后默认"未启用"，必须在每个新会话里手动跑一次命令才会生效
 *  - pi 退出 → 内存消失；/new、/resume、/fork 会重建扩展实例 → 自动回到未启用
 *
 * 用法：
 *  /compact-threshold 70   启用：上下文 ≥70% 时自动压缩（仅本会话）
 *  /compact-threshold off  关闭（恢复内置默认行为）
 *  /compact-threshold      查看当前状态
 *
 * 实现说明：
 *  pi 的内置自动压缩条件是 contextTokens > contextWindow - reserveTokens(默认16384)，
 *  对 200k 窗口约等于 92%。Extension API 不暴露 settingsManager，无法直接改这个值，
 *  所以本扩展的做法是：在 agent_settled 时用 ctx.getContextUsage() 检查百分比，
 *  达到自定义阈值就调用 ctx.compact()（与手动 /compact 完全同一条路径）。
 *  单次 run 内部冲得过高的情况仍由内置 overflow 保护兜底，这里只提供"更早、且在
 *  安全时点"的额外触发。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "compact-threshold";
const DEFAULT_RESERVE_TOKENS = 16384;

/** 触发压缩时给摘要器的额外提示（可选，这里保持默认行为） */
const CUSTOM_INSTRUCTIONS: string | undefined = undefined;

export default function (pi: ExtensionAPI) {
	// ---- 仅存于内存的会话级状态（退出即消失）----
	let threshold: number | null = null; // 已启用的阈值（%），null = 未启用
	let compacting = false; // 防重入：一次压缩进行中不重复触发

	function usageText(ctx: ExtensionContext): string {
		const u = ctx.getContextUsage();
		if (!u || u.percent === null || u.tokens === null) {
			return "未知（刚压缩完或尚无用量数据）";
		}
		return `${u.percent.toFixed(1)}% (${u.tokens.toLocaleString()}/${u.contextWindow.toLocaleString()} tokens)`;
	}

	/** 内置默认阈值的等效百分比（按默认 reserveTokens=16384 估算） */
	function builtinPercent(ctx: ExtensionContext): string {
		const w = ctx.model?.contextWindow;
		if (!w || w <= 0) return "未知";
		return `≈${(((w - DEFAULT_RESERVE_TOKENS) / w) * 100).toFixed(1)}%`;
	}

	function triggerCompaction(ctx: ExtensionContext, why: string): void {
		if (compacting) return;
		compacting = true;
		const pct = threshold;
		ctx.ui.notify(
			`compact-threshold: 上下文 ≥${pct}%（${why}），开始压缩…`,
			"info",
		);
		ctx.compact({
			customInstructions: CUSTOM_INSTRUCTIONS,
			onComplete: (result) => {
				compacting = false;
				const before = result.tokensBefore?.toLocaleString?.() ?? "?";
				const after = result.estimatedTokensAfter?.toLocaleString?.() ?? "?";
				ctx.ui.notify(
					`compact-threshold: 压缩完成 ${before} → ${after} tokens`,
					"info",
				);
			},
			onError: (err) => {
				compacting = false;
				// "Already compacted" / "Nothing to compact" 属于正常空转，静默即可
				const msg = err.message ?? String(err);
				if (msg.includes("Already compacted") || msg.includes("Nothing to compact")) {
					return;
				}
				ctx.ui.notify(`compact-threshold: 压缩失败 — ${msg}`, "error");
			},
		});
	}

	function maybeCompact(ctx: ExtensionContext, why: string): void {
		if (threshold === null || compacting) return;
		const u = ctx.getContextUsage();
		if (!u || u.percent === null) return; // 无用量数据时不动作
		if (u.percent >= threshold) triggerCompaction(ctx, why);
	}

	// agent 完全停稳（无自动重试/续跑）时检查——与内置 threshold 压缩相同的
	// 安全时点，不会打断进行中的多轮工具调用。
	pi.on("agent_settled", async (_event, ctx) => {
		maybeCompact(ctx, "agent 已停稳");
	});

	// 会话结束/切换：清掉 footer 状态（状态本身随实例销毁）
	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("compact-threshold", {
		description: "降低本会话的自动压缩阈值（如 /compact-threshold 70；off 关闭；无参数查看状态）",
		getArgumentCompletions: (prefix: string) => {
			const items = ["50", "60", "70", "80", "off"].map((v) => ({ value: v, label: v }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();

			// ---- 查看状态 ----
			if (!arg || arg === "status") {
				const t = threshold === null ? `未启用（内置默认 ${builtinPercent(ctx)}）` : `${threshold}%（仅本会话）`;
				ctx.ui.notify(
					`compact-threshold: 阈值 ${t} · 当前上下文 ${usageText(ctx)} · 模型 ${ctx.model?.id ?? "未选择"}`,
					"info",
				);
				return;
			}

			// ---- 关闭 ----
			if (arg === "off") {
				threshold = null;
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify(
					`compact-threshold: 已关闭，恢复内置默认（${builtinPercent(ctx)}），仅影响本会话`,
					"info",
				);
				return;
			}

			// ---- 启用 ----
			const n = Number(arg);
			if (!Number.isFinite(n) || n < 5 || n > 95) {
				ctx.ui.notify(
					"compact-threshold: 请输入 5–95 之间的百分比整数，例如 /compact-threshold 70",
					"error",
				);
				return;
			}
			threshold = n;
			ctx.ui.setStatus(STATUS_KEY, `cth ${n}%`);
			ctx.ui.notify(
				`compact-threshold: 已启用 — 上下文达到 ${n}% 时自动压缩（仅本会话生效，退出/换会话即失效）`,
				"info",
			);
			// 启用时若已超阈值，立即压缩一次
			if (ctx.isIdle()) maybeCompact(ctx, "启用时已超阈值");
		},
	});
}
