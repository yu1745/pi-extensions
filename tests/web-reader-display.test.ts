import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { displayWorks } from "../extensions/web-reader/display.ts";

test("X display validation checks connectivity, not socket existence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "web-reader-display-test-"));
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = dir;
    await assert.rejects(displayWorks(":1"), /requires xdpyinfo/);
    const probe = path.join(dir, "xdpyinfo");
    await writeFile(probe, `#!${process.execPath}\nprocess.exit(process.argv[2] === '-display' && process.argv[3] === ':91' ? 0 : 1);\n`, { mode: 0o755 });
    assert.equal(await displayWorks(":91"), true);
    assert.equal(await displayWorks("127.0.0.1:1"), false);
    assert.equal(await displayWorks(":1"), false);
    assert.equal(await displayWorks(""), false);
    await writeFile(probe, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
    const start = Date.now();
    assert.equal(await displayWorks(":91"), false);
    assert.ok(Date.now() - start < 4000, "probe must time out");
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
});
