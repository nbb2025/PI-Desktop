import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function installerChecksum(directory, name) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(join(directory, name))) hash.update(chunk);
  return [name, hash.digest("base64")];
}

export async function writeDesktopReleaseNotes(directory, output, version, { macosSigned = false } = {}) {
  const installers = [
    `PI-Desktop-Setup-${version}.exe`,
    `PI-Desktop-${version}-arm64.dmg`,
    `PI-Desktop-${version}-x64.dmg`,
  ];
  const files = await readdir(directory, { withFileTypes: true });
  if (files.length !== installers.length ||
      files.some((file) => !file.isFile() || !installers.includes(file.name))) {
    throw new Error("A desktop release must contain exactly one Windows EXE and both macOS DMGs");
  }
  const checksums = Object.fromEntries(
    await Promise.all(installers.map((name) => installerChecksum(directory, name))),
  );
  const manualMacInstall = macosSigned ? [] : [
    "### macOS manual installation",
    "",
    "After dragging `PI-Desktop.app` to Applications, open Terminal and run this command before opening the app.",
    "",
    "```sh",
    "xattr -cr /Applications/PI-Desktop.app",
    "```",
    "",
  ];
  // The updater checks the asset names and checksums in the raw release description.
  await writeFile(output, [
    "- **Windows** uses one setup executable for x86 and x64.",
    "- **macOS** uses the arm64 DMG on Apple Silicon and the x64 DMG on Intel.",
    "",
    "If you currently have the macOS Universal build, download the DMG for your Mac to upgrade.",
    "Install the Windows setup executable manually when upgrading from v0.24.0.",
    "",
    ...manualMacInstall,
    `<!-- pi-desktop-installers: ${JSON.stringify(checksums)} -->`,
    "",
  ].join("\n"));
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
    throw new Error("Expected the desktop version as the first argument");
  }
  await writeDesktopReleaseNotes("dist", "desktop-release-notes.md", version, {
    macosSigned: process.env.MACOS_SIGN_RELEASE === "true",
  });
}
