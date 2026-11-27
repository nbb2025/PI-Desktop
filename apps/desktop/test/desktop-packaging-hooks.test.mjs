import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const desktopDir = fileURLToPath(new URL("../", import.meta.url));
const manifest = new URL("../package.json", import.meta.url);
const requireFromDesktop = createRequire(manifest);
const requireFromBuilder = createRequire(requireFromDesktop.resolve("electron-builder"));
const { resolveFunction } = requireFromBuilder("app-builder-lib/out/util/resolve.js");

test("the artifact hook loads when the builder detects either workspace root", async (t) => {
  const originalDir = process.cwd();
  process.chdir(desktopDir);
  t.after(() => process.chdir(originalDir));

  const { build } = JSON.parse(readFileSync(manifest, "utf8"));
  // Windows can fall back to the Desktop project as the workspace root.
  for (const workspaceRoot of [desktopDir, resolve(desktopDir, "../..")]) {
    const hook = await resolveFunction("electron", build.artifactBuildCompleted, "artifactBuildCompleted", workspaceRoot);
    assert.equal(typeof hook, "function");
    await hook({ target: { name: "nsis" }, file: "installer.exe" });
  }
});
