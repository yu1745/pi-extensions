// quota-footer.ts — unified provider usage/balance monitor for the pi footer.
// Re-export from the modularized quota-footer directory for backward compatibility.

export { default } from "./quota-footer/index.js";
export * from "./quota-footer/types.js";
export * from "./quota-footer/utils.js";
export * from "./quota-footer/providers/index.js";
export * from "./quota-footer/history/store.js";
export * from "./quota-footer/history/sixel.js";
export * from "./quota-footer/history/chart-component.js";

// Re-export CommandCode functions for existing tests/consumers
export {
	commandCodeBaseUrl,
	commandCodeTtlFor,
	parseCommandCodeQuota,
	fetchCommandCodeQuota,
	renderCommandCode,
} from "./quota-footer/providers/commandcode.js";
