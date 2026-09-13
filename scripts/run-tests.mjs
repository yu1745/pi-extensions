import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const testsDir = join(__dirname, "../tests");

// Resolve jiti through pi-coding-agent's own directory
const piAgentRequire = createRequire(
	"/home/wangyu/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/index.js",
);
const { createJiti } = piAgentRequire("jiti");

const jiti = createJiti(import.meta.url);

const testFiles = readdirSync(testsDir).filter((f) => f.endsWith(".test.ts"));

for (const file of testFiles) {
	jiti(join(testsDir, file));
}
