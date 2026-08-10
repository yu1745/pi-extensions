import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { CHILD_ENV, USAGE_GUIDANCE } from "./src/constants.js";
import { readGuidanceEnabled } from "./src/config.js";
import { cleanupSubagents } from "./src/subagent.js";
import { registerSubagentTool } from "./src/subagent-tool.js";
import { disposeSubagentPanel, registerSubagentPanel } from "./src/view.js";

export default function (pi: ExtensionAPI) {
	if (process.env[CHILD_ENV] === "1") return;

	registerSubagentTool(pi);
	registerSubagentPanel(pi);

	// Append subagent usage guidance to the system prompt every turn so the
	// model actually delegates. Tool descriptions alone are easy to ignore;
	// a system-prompt policy drives behavior. Child subagent processes skip
	// this whole module via the CHILD_ENV guard above, so they are unaffected.
	pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
		if (!readGuidanceEnabled()) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${USAGE_GUIDANCE}` };
	});

	// Kill background subagents when the session ends (or pi exits). Logs in
	// ~/.pi/agent/subagent-runs/ are kept for later inspection.
	pi.on("session_shutdown", async () => {
		disposeSubagentPanel();
		await cleanupSubagents();
	});
}
