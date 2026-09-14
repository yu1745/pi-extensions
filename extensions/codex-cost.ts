import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";

const CODEX_AUTH_FILE = path.join(os.homedir(), ".codex", "auth.json");
const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "codex-cost-tracker.json");

const USD_PER_CREDIT = 0.04;
const DAY_MS = 86400000;

interface ModelBreakdownItem {
	model: string;
	speed?: string;
	credits: number;
	usd: number;
}

interface OfficialDayRow {
	date: string; // UTC date "YYYY-MM-DD"
	localRangeLabel: string; // 东八区窗口，如 "09/12 08:00 ~ 09/13 08:00"
	isCurrent: boolean;
	credits: number;
	usd: number;
	originalUsd?: number;
	calibrated?: boolean;
	models: ModelBreakdownItem[];
}

interface OfficialUsageData {
	windowStartUtc: string;
	windowEndUtc: string;
	windowStartLocal: string;
	resetAtLocal: string;
	usedPercent: number;
	totalUsd: number;
	ceilingUsd: number | null;
	remainingUsd: number | null;
	days: OfficialDayRow[];
	firstDayCalibrated?: boolean;
	firstDayOriginalUsd?: number;
	firstDayCalibratedUsd?: number;
}

interface PluginConfig {
	timeZone: string;
	// 用户手动指定的切分起始 UTC 日期 (如 "2026-09-12")
	// 若未设置，则默认跟随官方当前 7-Day 滚动周期的起点
	customStartUtcDate?: string;
	// 第一天（起始天）的校准实际消耗美元数
	// 当官方计费窗口起始时间不是整点 UTC 00:00 时，第一天会包含上一个周期的消耗，通过此项进行校准
	firstDayActualUsd?: number;
}

function getSystemTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
	} catch {
		return "Asia/Shanghai";
	}
}

function loadConfig(): PluginConfig {
	const tz = getSystemTimeZone();
	try {
		if (fs.existsSync(CONFIG_FILE)) {
			const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
			return {
				timeZone: data.timeZone || tz,
				customStartUtcDate: data.customStartUtcDate,
				firstDayActualUsd: typeof data.firstDayActualUsd === "number" ? data.firstDayActualUsd : undefined,
			};
		}
	} catch {}
	return { timeZone: tz };
}

function saveConfig(cfg: PluginConfig): void {
	try {
		const dir = path.dirname(CONFIG_FILE);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
	} catch (e) {
		console.error("[codex-cost] Failed to save config:", e);
	}
}

// 请求 ChatGPT 官方 backend-api
async function callOfficialApi(endpoint: string, token: string, accountId: string): Promise<any> {
	const proxy = process.env.https_proxy || process.env.http_proxy || process.env.ALL_PROXY;
	const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;

	return new Promise((resolve, reject) => {
		const req = https.request(
			`https://chatgpt.com${endpoint}`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					"chatgpt-account-id": accountId,
					"User-Agent": "CodexDesktop",
					Accept: "application/json",
				},
				agent,
				timeout: 8000,
			},
			(resp) => {
				let body = "";
				resp.on("data", (c) => (body += c));
				resp.on("end", () => {
					if (resp.statusCode && resp.statusCode >= 400) {
						reject(new Error(`API Error ${resp.statusCode}: ${body.slice(0, 200)}`));
						return;
					}
					try {
						resolve(JSON.parse(body));
					} catch (e) {
						reject(e);
					}
				});
			}
		);
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("请求超时"));
		});
		req.end();
	});
}

function formatUtcDayToLocalRange(utcDateStr: string, tz: string): { label: string; isCurrent: boolean } {
	try {
		const startMs = Date.parse(utcDateStr + "T00:00:00Z");
		const endMs = startMs + DAY_MS;

		const opt: Intl.DateTimeFormatOptions = {
			timeZone: tz,
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		};

		const startFmt = new Intl.DateTimeFormat("zh-CN", opt).format(new Date(startMs));
		const endFmt = new Intl.DateTimeFormat("zh-CN", opt).format(new Date(endMs));
		const now = Date.now();
		const isCurrent = now >= startMs && now < endMs;

		return {
			label: `${startFmt} ~ ${endFmt}`,
			isCurrent,
		};
	} catch {
		return { label: utcDateStr, isCurrent: false };
	}
}

function formatResetTime(ms: number, tz: string): string {
	try {
		return new Intl.DateTimeFormat("zh-CN", {
			timeZone: tz,
			weekday: "short",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).format(new Date(ms));
	} catch {
		return "—";
	}
}

// 统一按照官方逻辑拉取真实全端数据
async function fetchOfficialData(
	tz: string,
	customStartUtcDate?: string,
	firstDayActualUsd?: number
): Promise<OfficialUsageData> {
	if (!fs.existsSync(CODEX_AUTH_FILE)) {
		throw new Error(`找不到 ${CODEX_AUTH_FILE}，请先在本地登录 Codex Desktop 或 Codex CLI`);
	}

	const auth = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, "utf8"));
	const token = auth.tokens?.access_token;
	const accountId = auth.tokens?.account_id || "";

	if (!token) {
		throw new Error("~/.codex/auth.json 中未找到有效的 access_token");
	}

	// 1. 查询当前配额窗口
	const usage = await callOfficialApi("/backend-api/wham/usage", token, accountId);
	const pw = usage?.rate_limit?.primary_window;
	if (!pw) {
		throw new Error("未获取到当前账号的 7-Day 配额窗口信息");
	}

	const windowSec = Number(pw.limit_window_seconds || 604800);
	const resetAtMs = Number(pw.reset_at) > 1e12 ? Number(pw.reset_at) : Number(pw.reset_at) * 1000;
	const windowStartMs = resetAtMs - windowSec * 1000;
	const usedPercent = Math.min(100, Math.max(0, Number(pw.used_percent) || 0));

	const officialStartUtcDate = new Date(windowStartMs).toISOString().slice(0, 10);
	const queryStartUtcDate = customStartUtcDate || officialStartUtcDate;
	const queryEndUtcDate = new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);

	// 2. 并行拉取整天消费数 (counts) 与模型分项占比 (breakdown)
	const range = `start_date=${queryStartUtcDate}&end_date=${queryEndUtcDate}&group_by=day`;
	const countsPromise = callOfficialApi(
		`/backend-api/wham/analytics/daily-workspace-usage-counts?${range}&workspace_user=true`,
		token,
		accountId
	);
	const breakdownPromise = callOfficialApi(
		`/backend-api/wham/usage/daily-token-usage-breakdown?${range}`,
		token,
		accountId
	).catch(() => null);

	const [countsData, breakdownData] = await Promise.all([countsPromise, breakdownPromise]);

	const breakdownMap = new Map<string, any[]>();
	for (const row of breakdownData?.data || []) {
		breakdownMap.set(row.date, row.models || []);
	}

	const days: OfficialDayRow[] = [];
	let totalCredits = 0;

	for (const countRow of countsData?.data || []) {
		const dateStr: string = countRow.date;
		// 过滤小于切分起点的天
		if (dateStr < queryStartUtcDate) continue;

		const reportedCredits =
			Number(countRow.totals?.credits) || Number(countRow.totals?.on_demand_credits) || 0;
		const dayUsd = reportedCredits * USD_PER_CREDIT;
		totalCredits += reportedCredits;

		const rangeInfo = formatUtcDayToLocalRange(dateStr, tz);

		// 计算模型明细
		const rawModels = breakdownMap.get(dateStr) || [];
		const nonZeroModels = rawModels.filter((m: any) => Number(m.credits) > 0);
		const sumModelCredits = nonZeroModels.reduce((acc: number, m: any) => acc + Number(m.credits), 0);

		const modelItems: ModelBreakdownItem[] = [];
		if (sumModelCredits > 0) {
			for (const m of nonZeroModels) {
				const share = Number(m.credits) / sumModelCredits;
				const allocatedCredits = reportedCredits * share;
				const mUsd = allocatedCredits * USD_PER_CREDIT;
				modelItems.push({
					model: m.model,
					speed: m.speed,
					credits: allocatedCredits,
					usd: mUsd,
				});
			}
			modelItems.sort((a, b) => b.usd - a.usd);
		}

		days.push({
			date: dateStr,
			localRangeLabel: rangeInfo.label,
			isCurrent: rangeInfo.isCurrent,
			credits: reportedCredits,
			usd: dayUsd,
			models: modelItems,
		});
	}

	days.sort((a, b) => a.date.localeCompare(b.date));

	let firstDayCalibrated = false;
	let firstDayOriginalUsd: number | undefined;
	let firstDayCalibratedUsd: number | undefined;

	// 如果配置了第一天实际消耗校准值，对统计起点的第一天进行校准
	if (typeof firstDayActualUsd === "number" && days.length > 0) {
		const firstDay = days[0];
		firstDayOriginalUsd = firstDay.usd;
		firstDayCalibratedUsd = Math.max(0, firstDayActualUsd);
		firstDayCalibrated = true;

		firstDay.originalUsd = firstDayOriginalUsd;
		firstDay.calibrated = true;
		firstDay.usd = firstDayCalibratedUsd;
		firstDay.credits = firstDayCalibratedUsd / USD_PER_CREDIT;

		// 同步按比例调整第一天的模型明细
		if (firstDayOriginalUsd > 0) {
			const scale = firstDayCalibratedUsd / firstDayOriginalUsd;
			for (const m of firstDay.models) {
				m.usd = m.usd * scale;
				m.credits = m.credits * scale;
			}
		}
	}

	const totalUsd = days.reduce((sum, d) => sum + d.usd, 0);
	const ceilingUsd = usedPercent > 0 && totalUsd > 0 ? totalUsd / (usedPercent / 100) : null;
	const remainingUsd = ceilingUsd ? Math.max(0, ceilingUsd - totalUsd) : null;

	return {
		windowStartUtc: queryStartUtcDate,
		windowEndUtc: new Date().toISOString().slice(0, 10),
		windowStartLocal: formatUtcDayToLocalRange(queryStartUtcDate, tz).label.split(" ~ ")[0],
		resetAtLocal: formatResetTime(resetAtMs, tz),
		usedPercent,
		totalUsd,
		ceilingUsd,
		remainingUsd,
		days,
		firstDayCalibrated,
		firstDayOriginalUsd,
		firstDayCalibratedUsd,
	};
}

function buildReportLines(data: OfficialUsageData, tz: string, theme: any): string[] {
	const lines: string[] = [];

	lines.push(
		theme.bold(`📊 ${theme.fg("accent", "OpenAI 官方 Codex 配额与全端流水 (实时多端同步)")}`)
	);
	lines.push(
		`${theme.fg("muted", "当前统计起点:")} ${theme.bold(
			theme.fg("accent", data.windowStartUtc)
		)} ${theme.fg("dim", `(东八区窗口起点: ${data.windowStartLocal})`)} | ${theme.fg(
			"muted",
			"重置时间:"
		)} ${theme.bold(data.resetAtLocal)}`
	);

	const ceilingStr = data.ceilingUsd ? `$${data.ceilingUsd.toFixed(2)}` : "计算中";
	const remainingStr = data.remainingUsd ? `$${data.remainingUsd.toFixed(2)}` : "—";

	lines.push(
		`${theme.fg("muted", "预计总额度:")} ${theme.bold(ceilingStr)} ${theme.fg(
			"dim",
			`(已消耗 ${data.usedPercent}%)`
		)} | ${theme.fg("muted", "累计已用:")} ${theme.bold(
			theme.fg("warning", `$${data.totalUsd.toFixed(2)}`)
		)} | ${theme.fg("muted", "剩余可用:")} ${theme.bold(remainingStr)}`
	);
	lines.push("");

	if (data.days.length === 0) {
		lines.push(theme.fg("muted", "  (当前切分周期内暂无使用流水记录)"));
		return lines;
	}

	for (const day of data.days) {
		const ongoingBadge = day.isCurrent ? ` ${theme.fg("accent", "[进行中]")}` : "";
		const calibBadge = day.calibrated
			? ` ${theme.fg("warning", `[校准: 原始 $${day.originalUsd?.toFixed(2) ?? ""}]`)}`
			: "";
		const dayHead = theme.bold(theme.fg("accent", `[${day.localRangeLabel}]`)) + ongoingBadge + calibBadge;
		const dayTotal = `${theme.bold(`$${day.usd.toFixed(2)}`)} ${theme.fg(
			"dim",
			`(${day.credits.toFixed(1)} credits)`
		)}`;

		lines.push(`  ${dayHead}  ${dayTotal}`);

		const modelParts: string[] = [];
		for (const m of day.models) {
			const share = day.usd > 0 ? ((m.usd / day.usd) * 100).toFixed(1) + "%" : "0%";
			const speedTag = m.speed && m.speed !== "standard" ? " (Fast)" : "";
			modelParts.push(
				`${theme.fg("accent", m.model + speedTag)}: ${theme.bold(
					`$${m.usd.toFixed(2)}`
				)} ${theme.fg("dim", `(${share})`)}`
			);
		}

		if (modelParts.length > 0) {
			lines.push(`     └─ ${modelParts.join("  |  ")}`);
		}
	}

	lines.push("");
	lines.push(theme.fg("dim", "  ──────────────────────────────────────────────────────────────────"));
	lines.push(
		`  ${theme.bold("周期汇总:")} ${theme.bold(
			theme.fg("warning", `$${data.totalUsd.toFixed(2)}`)
		)}`
	);

	return lines;
}

/**
 * 顶部居中浮窗
 */
class CodexCostModalOverlay implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: any;
	private readonly reportLines: string[];
	private readonly onDismiss: () => void;
	private scrollOffset = 0;

	focused = true;

	constructor(tui: TUI, theme: any, reportLines: string[], onDismiss: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.reportLines = reportLines;
		this.onDismiss = onDismiss;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const t = this.theme;
		const innerWidth = Math.max(50, width - 2);
		const leftPad = 0;
		const padStr = "";

		const topBorder = `${padStr}${t.fg("border", `┌${"─".repeat(innerWidth)}┐`)}`;
		const bottomBorder = `${padStr}${t.fg("border", `└${"─".repeat(innerWidth)}┘`)}`;

		const viewportHeight = Math.min(22, Math.max(8, this.reportLines.length + 2));
		const visibleLines = this.reportLines.slice(
			this.scrollOffset,
			this.scrollOffset + viewportHeight
		);

		const renderedRows: string[] = [];
		renderedRows.push(topBorder);

		for (const rawLine of visibleLines) {
			const truncated = truncateToWidth(rawLine, innerWidth - 2, "");
			const fillLen = Math.max(0, innerWidth - 2 - visibleWidth(truncated));
			const content = ` ${truncated}${" ".repeat(fillLen)} `;
			renderedRows.push(
				`${padStr}${t.fg("border", "│")}${content}${t.fg("border", "│")}`
			);
		}

		while (renderedRows.length < viewportHeight + 1) {
			renderedRows.push(
				`${padStr}${t.fg("border", "│")}${" ".repeat(innerWidth)}${t.fg("border", "│")}`
			);
		}

		const hint = ` [↑/↓]: 滚动  |  [Esc / q / Enter]: 关闭窗口 `;
		const hintTruncated = truncateToWidth(t.fg("dim", hint), innerWidth - 2, "");
		const hintFill = Math.max(0, innerWidth - 2 - visibleWidth(hintTruncated));
		renderedRows.push(
			`${padStr}${t.fg("border", "│")} ${hintTruncated}${" ".repeat(hintFill)} ${t.fg("border", "│")}`
		);

		renderedRows.push(bottomBorder);

		return renderedRows;
	}

	handleInput(keyData: string): void {
		if (
			matchesKey(keyData, "escape") ||
			matchesKey(keyData, "enter") ||
			matchesKey(keyData, "q") ||
			matchesKey(keyData, "ctrl+c")
		) {
			this.onDismiss();
		} else if (matchesKey(keyData, "up") || matchesKey(keyData, "k")) {
			if (this.scrollOffset > 0) {
				this.scrollOffset--;
				this.tui.requestRender();
			}
		} else if (matchesKey(keyData, "down") || matchesKey(keyData, "j")) {
			if (this.scrollOffset + 22 < this.reportLines.length) {
				this.scrollOffset++;
				this.tui.requestRender();
			}
		} else if (matchesKey(keyData, "pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 10);
			this.tui.requestRender();
		} else if (matchesKey(keyData, "pageDown")) {
			this.scrollOffset = Math.min(
				Math.max(0, this.reportLines.length - 22),
				this.scrollOffset + 10
			);
			this.tui.requestRender();
		}
	}
}

/**
 * 官方时间桶轮盘选择组件（直接按年月日切分官方 UTC 统计桶）
 */
class OfficialDateWheelPickerModal implements Component, Focusable {
	private year: number;
	private month: number;
	private day: number;
	private selectedCol: number = 2; // 0: 年, 1: 月, 2: 日
	private theme: any;
	private defaultDate: string;
	private onConfirm: (dateStr: string) => void;
	private onCancel: () => void;

	focused = true;

	constructor(
		initialDateStr: string,
		defaultDate: string,
		theme: any,
		onConfirm: (dateStr: string) => void,
		onCancel: () => void
	) {
		this.theme = theme;
		this.defaultDate = defaultDate;
		this.onConfirm = onConfirm;
		this.onCancel = onCancel;

		const [y, m, d] = initialDateStr.split("-").map(Number);
		const now = new Date();
		this.year = y || now.getUTCFullYear();
		this.month = m || now.getUTCMonth() + 1;
		this.day = d || now.getUTCDate();
		this.clampDay();
	}

	private maxDaysInMonth(year: number, month: number): number {
		return new Date(Date.UTC(year, month, 0)).getUTCDate();
	}

	private clampDay(): void {
		const max = this.maxDaysInMonth(this.year, this.month);
		if (this.day > max) this.day = max;
		if (this.day < 1) this.day = 1;
	}

	private adjust(delta: number): void {
		if (this.selectedCol === 0) {
			this.year += delta;
			if (this.year < 2020) this.year = 2020;
			if (this.year > 2035) this.year = 2035;
			this.clampDay();
		} else if (this.selectedCol === 1) {
			this.month += delta;
			if (this.month < 1) {
				this.month = 12;
				this.year -= 1;
			} else if (this.month > 12) {
				this.month = 1;
				this.year += 1;
			}
			this.clampDay();
		} else if (this.selectedCol === 2) {
			const max = this.maxDaysInMonth(this.year, this.month);
			this.day += delta;
			if (this.day < 1) this.day = max;
			else if (this.day > max) this.day = 1;
		}
	}

	private pad2(n: number): string {
		return String(n).padStart(2, "0");
	}

	getDateString(): string {
		return `${this.year}-${this.pad2(this.month)}-${this.pad2(this.day)}`;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const t = this.theme;
		const innerWidth = Math.max(50, Math.min(width - 4, 82));
		const leftPad = Math.max(0, Math.floor((width - innerWidth - 2) / 2));
		const padStr = " ".repeat(leftPad);

		const topBorder = `${padStr}${t.fg("border", `┌${"─".repeat(innerWidth)}┐`)}`;
		const bottomBorder = `${padStr}${t.fg("border", `└${"─".repeat(innerWidth)}┘`)}`;

		const yPrev = String(this.year - 1);
		const yCurr = String(this.year);
		const yNext = String(this.year + 1);

		const maxD = this.maxDaysInMonth(this.year, this.month);
		const mPrev = this.pad2(this.month === 1 ? 12 : this.month - 1);
		const mCurr = this.pad2(this.month);
		const mNext = this.pad2(this.month === 12 ? 1 : this.month + 1);

		const dPrev = this.pad2(this.day === 1 ? maxD : this.day - 1);
		const dCurr = this.pad2(this.day);
		const dNext = this.pad2(this.day === maxD ? 1 : this.day + 1);

		const innerLines: string[] = [];
		innerLines.push(t.bold("  ⚙️ 设置切分周期起始桶 (按官方天级桶切分)"));
		innerLines.push(
			`     当前选定起点桶: ${t.bold(t.fg("accent", this.getDateString()))} (对应东八区 ${
				formatUtcDayToLocalRange(this.getDateString(), "Asia/Shanghai").label
			})`
		);
		innerLines.push(
			`     ${t.fg("warning", "[快捷功能]")} 按 'r' 键恢复为官方当前 7-Day 滚动起点 (${this.defaultDate})`
		);
		innerLines.push("");

		const c0Arr = this.selectedCol === 0 ? t.fg("dim", ` ▲    `) : "      ";
		const c1Arr = this.selectedCol === 1 ? t.fg("dim", ` ▲   `) : "     ";
		const c2Arr = this.selectedCol === 2 ? t.fg("dim", ` ▲   `) : "     ";
		innerLines.push(`            ${c0Arr}  ${c1Arr}  ${c2Arr}`);

		innerLines.push(
			`            ${t.fg("dim", yPrev)}年  ${t.fg("dim", mPrev)}月  ${t.fg("dim", dPrev)}日`
		);

		const yBox =
			this.selectedCol === 0
				? t.bold(t.bg("selectedBg", t.fg("accent", ` ${yCurr}年 `)))
				: t.bold(` ${yCurr}年 `);
		const mBox =
			this.selectedCol === 1
				? t.bold(t.bg("selectedBg", t.fg("accent", ` ${mCurr}月 `)))
				: t.bold(` ${mCurr}月 `);
		const dBox =
			this.selectedCol === 2
				? t.bold(t.bg("selectedBg", t.fg("accent", ` ${dCurr}日 `)))
				: t.bold(` ${dCurr}日 `);

		innerLines.push(`          ► ${yBox}─${mBox}─${dBox} ◄`);

		innerLines.push(
			`            ${t.fg("dim", yNext)}年  ${t.fg("dim", mNext)}月  ${t.fg("dim", dNext)}日`
		);

		const c0ArrD = this.selectedCol === 0 ? t.fg("dim", ` ▼    `) : "      ";
		const c1ArrD = this.selectedCol === 1 ? t.fg("dim", ` ▼   `) : "     ";
		const c2ArrD = this.selectedCol === 2 ? t.fg("dim", ` ▼   `) : "     ";
		innerLines.push(`            ${c0ArrD}  ${c1ArrD}  ${c2ArrD}`);
		innerLines.push("");
		innerLines.push(
			t.fg(
				"dim",
				"  [← / →]: 切换 年/月/日  |  [↑ / ↓]: 增减 (下增上减)  |  [r]: 恢复官方起点  |  [Enter]: 确认"
			)
		);

		const renderedRows: string[] = [];
		renderedRows.push(topBorder);
		for (const line of innerLines) {
			const truncated = truncateToWidth(line, innerWidth - 2, "");
			const fillLen = Math.max(0, innerWidth - 2 - visibleWidth(truncated));
			renderedRows.push(
				`${padStr}${t.fg("border", "│")} ${truncated}${" ".repeat(fillLen)} ${t.fg("border", "│")}`
			);
		}
		renderedRows.push(bottomBorder);

		return renderedRows;
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "left") || matchesKey(keyData, "h")) {
			this.selectedCol = Math.max(0, this.selectedCol - 1);
		} else if (matchesKey(keyData, "right") || matchesKey(keyData, "l")) {
			this.selectedCol = Math.min(2, this.selectedCol + 1);
		} else if (matchesKey(keyData, "up") || matchesKey(keyData, "k")) {
			this.adjust(-1);
		} else if (matchesKey(keyData, "down") || matchesKey(keyData, "j")) {
			this.adjust(1);
		} else if (keyData === "r") {
			const [y, m, d] = this.defaultDate.split("-").map(Number);
			this.year = y;
			this.month = m;
			this.day = d;
			this.clampDay();
		} else if (matchesKey(keyData, "enter")) {
			this.onConfirm(this.getDateString());
		} else if (matchesKey(keyData, "escape") || matchesKey(keyData, "ctrl+c")) {
			this.onCancel();
		}
	}
}

export default function codexCostPlugin(pi: ExtensionAPI) {
	let config = loadConfig();

	pi.registerCommand("codex-cost", {
		description: "实时同步 OpenAI 官方配额与每日全端多设备消费流水报表",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "calibrate", label: "calibrate <amount> - 设置第一天实际消耗的美元校准值（如 /codex-cost calibrate 15.5）" },
				{ value: "cycle", label: "cycle - 打开官方时间桶轮盘设置统计切分起点" },
				{ value: "reset", label: "reset - 重置为跟随官方 7-Day 周期起点并清除校准" },
			];
			const filtered = options.filter((o) => o.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx: ExtensionContext) => {
			const rawArgs = args.trim();
			const parts = rawArgs.split(/\s+/);
			const subcmd = parts[0]?.toLowerCase() || "";

			if (subcmd === "reset") {
				config.customStartUtcDate = undefined;
				config.firstDayActualUsd = undefined;
				saveConfig(config);
				ctx.ui.notify("已重置切分周期：完全跟随官方 7-Day 滚动窗口起点，并清除第一天校准值", "info");
				return;
			}

			if (subcmd === "calibrate" || subcmd === "calib") {
				const valStr = parts[1];
				if (!valStr) {
					if (typeof config.firstDayActualUsd === "number") {
						ctx.ui.notify(
							`当前第一天实际校准值: $${config.firstDayActualUsd.toFixed(2)}。重置请执行 /codex-cost calibrate off`,
							"info"
						);
					} else {
						ctx.ui.notify("未设置校准值。用法: /codex-cost calibrate <美元数> (例如 /codex-cost calibrate 25.8)", "info");
					}
					return;
				}

				if (valStr.toLowerCase() === "off" || valStr.toLowerCase() === "clear" || valStr.toLowerCase() === "reset") {
					config.firstDayActualUsd = undefined;
					saveConfig(config);
					ctx.ui.notify("已清除第一天校准值", "info");
					return;
				}

				const num = Number(valStr.replace(/^\$/, ""));
				if (Number.isNaN(num) || num < 0) {
					ctx.ui.notify(`无效的金额数值: ${valStr}，请输入有效非负数（如 12.34）`, "error");
					return;
				}

				config.firstDayActualUsd = num;
				saveConfig(config);
				ctx.ui.notify(`已设置第一天实际消耗校准值为: $${num.toFixed(2)}`, "info");
				return;
			}

			if (subcmd === "cycle") {
				let officialStart = "2026-09-12";
				try {
					const data = await fetchOfficialData(config.timeZone);
					officialStart = data.windowStartUtc;
				} catch {}

				const currentStart = config.customStartUtcDate || officialStart;

				const selectedDate = await ctx.ui.custom<string | null>(
					(_tui, theme, _kb, done) => {
						return new OfficialDateWheelPickerModal(
							currentStart,
							officialStart,
							theme,
							(newD) => done(newD),
							() => done(null)
						);
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "top-center",
							margin: { top: 1, left: 2, right: 2 },
						},
					} as any
				);

				if (selectedDate) {
					config.customStartUtcDate = selectedDate;
					saveConfig(config);
					ctx.ui.notify(`切分起点已设置为: ${selectedDate} 至今`, "info");
				}
				return;
			}

			// 直接调官方接口拉取实时数据并展示
			try {
				const data = await fetchOfficialData(
					config.timeZone,
					config.customStartUtcDate,
					config.firstDayActualUsd
				);
				const reportLines = buildReportLines(data, config.timeZone, ctx.ui.theme);

				await ctx.ui.custom<void>(
					(tui, theme, _kb, done) => {
						return new CodexCostModalOverlay(tui, theme, reportLines, () => done());
					},
					{
						overlay: true,
						overlayOptions: () => {
							let maxContentWidth = 0;
							for (const line of reportLines) {
								const w = visibleWidth(line);
								if (w > maxContentWidth) maxContentWidth = w;
							}
							return {
								anchor: "top-center",
								width: Math.max(80, maxContentWidth + 4),
								margin: { top: 1, left: 2, right: 2 },
							};
						},
					} as any
				);
			} catch (err: any) {
				ctx.ui.notify(`获取官方数据失败: ${err.message}`, "error");
			}
		},
	});
}
