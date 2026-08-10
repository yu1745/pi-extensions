import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_ENV } from "./src/constants.js";
import { cleanupSubagents } from "./src/subagent.js";
import { registerSubagentTool } from "./src/subagent-tool.js";
import { disposeSubagentPanel, registerSubagentPanel } from "./src/view.js";

export default function (pi: ExtensionAPI) {
	if (process.env[CHILD_ENV] === "1") return;

	registerSubagentTool(pi);
	registerSubagentPanel(pi);

	// Kill background subagents when the session ends (or pi exits). Logs in
	// ~/.pi/agent/subagent-runs/ are kept for later inspection.
	pi.on("session_shutdown", async () => {
		disposeSubagentPanel();
		await cleanupSubagents();
	});
}
