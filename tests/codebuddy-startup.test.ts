import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../extensions/codebuddy-fp/index.ts", import.meta.url), "utf8");
const authPathFunction = source.match(/function piAuthFile\(\): string \{[\s\S]*?\n\}/)?.[0];
assert.ok(authPathFunction, "credential path helper must exist");

function authPath(getAgentDir: () => string) {
	let requires = 0;
	const result = runInNewContext(
		`${authPathFunction!.replace("(): string", "()")}\npiAuthFile()`,
		{
			getAgentDir,
			path,
			os: { homedir: () => "/fallback-home" },
			require: () => {
				requires++;
				throw new Error("must not synchronously load the Pi SDK");
			},
		},
	);
	assert.equal(requires, 0, "credential lookup must reuse the statically imported host SDK");
	return result;
}

test("CodeBuddy imports getAgentDir once rather than requiring the SDK during startup", () => {
	assert.match(source, /import\s*\{\s*getAgentDir,\s*type ExtensionAPI\s*\}\s*from\s*"@earendil-works\/pi-coding-agent"/);
	assert.equal(authPath(() => "/custom-agent-dir"), path.join("/custom-agent-dir", "auth.json"));
});

test("CodeBuddy retains the home-directory fallback when the host directory is unavailable", () => {
	assert.equal(authPath(() => { throw new Error("unavailable"); }), path.join("/fallback-home", ".pi/agent/auth.json"));
});
