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
	parseCodeBuddyExpiring,
	fetchCodeBuddyQuota,
	renderCodeBuddy,
} from "./quota-footer/providers/codebuddy.ts";

// Re-export River (Console balance) functions for tests/consumers
export {
	RIVER_KEEPALIVE_CHECK_MS,
	RIVER_KEEPALIVE_MS,
	RIVER_STORE_VERSION,
	fetchRiver,
	fetchRiverBalance,
	jwtExpiryMs,
	keepRiverSessionWarm,
	mintRiverAccessToken,
	parseRiverAccount,
	persistRiverStore,
	readRiverStore,
	readRiverStoreFile,
	readSetCookie,
	renderRiver,
	resolveRiverAuthConfig,
	riverConsoleBase,
	riverCredentialId,
	riverKeepAliveDue,
	riverKeepAliveEnabled,
	riverKeepAliveMs,
	riverLowThresholds,
	riverStoreFile,
	riverTtlFor,
	seedRiverSession,
} from "./quota-footer/providers/river.ts";
