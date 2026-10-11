import { readFile, readdir, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const outdir = resolve(root, "bundle");
const check = process.argv.includes("--check");
// Keep the existing OAuth implementation and its shared helpers in source form:
// generated files must not duplicate client credentials. Externalize the helper
// boundary for BOTH entries so login, provider and search use the same caches.
// Pi's loader resolves these TypeScript modules; npm packages remain external.
const result = await build({
  absWorkingDir: root,
  entryPoints: {
    antigravity: "extensions/antigravity/index.ts",
    "web-search": "extensions/web-search/index.ts",
  },
  outdir,
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  keepNames: true,
  plugins: [{
    name: "source-auth-boundary",
    setup(builder) {
      builder.onResolve({ filter: /^\./ }, (args) => {
        const source = resolve(args.resolveDir, args.path).replace(/\.js$/, ".ts");
        const local = relative(root, source).replaceAll("\\", "/");
        if (!/^extensions\/antigravity\/(auth|client|utils|models|diagnostics|types)\//.test(local)) return;
        return { path: `./${relative(outdir, source).replaceAll("\\", "/")}`, external: true };
      });
    },
  }],
  write: false,
});
const expected = new Set(result.outputFiles.map((file) => relative(outdir, file.path)));
const existing = await readdir(outdir).catch((error) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
for (const name of existing) {
  if (expected.has(name)) continue;
  if (check) throw new Error(`Stale bundle: ${name}`);
  await rm(resolve(outdir, name));
}
if (!check) await mkdir(outdir, { recursive: true });
for (const file of result.outputFiles) {
  if (check) {
    const actual = await readFile(file.path).catch(() => undefined);
    if (!actual?.equals(Buffer.from(file.contents))) {
      throw new Error(`Bundle is missing or outdated: ${relative(root, file.path)}. Run pnpm build:extensions.`);
    }
  } else {
    await writeFile(file.path, file.contents);
  }
}
console.log(check ? "Extension bundles are current." : "Extension bundles built.");
