// quota-footer.ts — unified provider usage/balance monitor for the pi footer.
// Re-export from the modularized quota-footer directory for backward compatibility.

export { default } from "./quota-footer/index.ts";
export * from "./quota-footer/types.ts";
export * from "./quota-footer/utils.ts";
export * from "./quota-footer/providers/index.ts";
export * from "./quota-footer/history/store.ts";
export * from "./quota-footer/history/sixel.ts";
export * from "./quota-footer/history/chart-component.ts";

// Re-export CommandCode functions for existing tests/consumers
export {
	ccExpiry,
	commandCodeBaseUrl,
	commandCodeTtlFor,
	parseCommandCodeQuota,
	fetchCommandCodeQuota,
	renderCommandCode,
} from "./quota-footer/providers/commandcode.ts";

// Re-export CodeBuddy (积分) functions for tests/consumers
export {
	cbCycleMs,
	codeBuddyBaseUrl,
	codeBuddyTtlFor,
	parseCodeBuddyPackage,
	parseCodeBuddyQuota,
	parseCodeBuddyResetAt,
	fetchCodeBuddyQuota,
	renderCodeBuddy,
} from "./quota-footer/providers/codebuddy.ts";
