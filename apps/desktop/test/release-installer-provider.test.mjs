import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeDesktopReleaseNotes } from "../../../scripts/write-desktop-release-notes.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
register(new URL("./helpers/updater-module-stubs.mjs", import.meta.url));
const { ReleaseInstallerProvider } = await import("../electron/main/release-installer-provider.ts");

const repository = "nbb2025/PI-Desktop";
const tag = "v0.24.1";
const names = {
  win32: "PI-Desktop-Setup-0.24.1.exe",
  darwin: "PI-Desktop-0.24.1-universal.dmg",
};

function providerFor(platform, release, installedComparison = -1) {
  return new ReleaseInstallerProvider({}, {
    currentVersion: { compare: () => installedComparison },
  }, {
    platform,
    executor: {
      request: async (url, headers) => {
        assert.equal(url.href, `https://api.github.com/repos/${repository}/releases/latest`);
        assert.equal(headers.Accept, "application/vnd.github+json");
        return JSON.stringify(release);
      },
    },
  });
}

test("both clients discover their installer from a release with exactly two assets", async (context) => {
  const scratch = await mkdtemp(join(tmpdir(), "desktop-release-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const dist = join(scratch, "dist");
  const notes = join(scratch, "notes.md");
  await mkdir(dist);
  for (const name of Object.values(names)) await writeFile(join(dist, name), name);
  await writeDesktopReleaseNotes(dist, notes, tag.slice(1));
  const release = {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: "2026-11-24T00:00:00Z",
    body: await readFile(notes, "utf8"),
    assets: Object.values(names).map((name) => ({
      state: "uploaded",
      size: Buffer.byteLength(name),
      name,
      browser_download_url: "https://untrusted.example/installer",
    })),
  };
  for (const [platform, name] of Object.entries(names)) {
    const provider = providerFor(platform, release);
    const info = await provider.getLatestVersion();
    assert.equal(info.version, tag.slice(1));
    assert.equal(info.sha512, createHash("sha512").update(name).digest("base64"));
    assert.deepEqual(provider.resolveFiles(info).map(({ url }) => url.href), [
      `https://github.com/${repository}/releases/download/${tag}/${name}`,
    ]);
  }
  await assert.rejects(
    providerFor("win32", { ...release, body: "missing checksum" }).getLatestVersion(),
    /missing a valid installer checksum/,
  );
  await assert.rejects(
    providerFor("win32", { ...release, assets: [release.assets[1]] }).getLatestVersion(),
    /missing the installer/,
  );
  await assert.rejects(
    providerFor("win32", { ...release, tag_name: "v0.24.2/../../../" }).getLatestVersion(),
    /invalid stable desktop release/,
  );
  await writeFile(join(dist, "unexpected.zip"), "");
  await assert.rejects(writeDesktopReleaseNotes(dist, notes, tag.slice(1)), /exactly/);
});

test("an older release needs no installer metadata when the installed version is newer", async () => {
  const provider = providerFor("win32", {
    tag_name: "v0.24.0",
    draft: false,
    prerelease: false,
    published_at: "2026-11-23T00:00:00Z",
    assets: [],
  }, 1);
  const info = await provider.getLatestVersion();
  assert.equal(info.version, "0.24.0");
  assert.deepEqual(info.files, []);
});
