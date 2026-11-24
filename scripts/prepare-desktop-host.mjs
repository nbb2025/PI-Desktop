import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const targetDir = join(root, "target");
const hostName = "pi-desktop-host-core";
const windowsTargets = [
  ["x64", "x86_64-pc-windows-msvc"],
  ["ia32", "i686-pc-windows-msvc"],
];
const macTargets = ["aarch64-apple-darwin", "x86_64-apple-darwin"];

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

function buildHost(targets = []) {
  run("cargo", [
    "build", "--release", "--locked", "-p", "host-core", "--target-dir", targetDir,
    ...targets.flatMap((target) => ["--target", target]),
  ]);
}

function stageWindowsHost(arch, source) {
  const folder = join(targetDir, "desktop-release", arch);
  mkdirSync(folder, { recursive: true });
  copyFileSync(source, join(folder, `${hostName}.exe`));
}

export function prepareDesktopHost(universal = false) {
  if (universal && process.platform === "win32") {
    buildHost(windowsTargets.map(([, target]) => target));
    for (const [arch, target] of windowsTargets) {
      stageWindowsHost(arch, join(targetDir, target, "release", `${hostName}.exe`));
    }
    return;
  }

  if (universal && process.platform === "darwin") {
    buildHost(macTargets);
    const folder = join(targetDir, "release");
    mkdirSync(folder, { recursive: true });
    const binary = join(folder, hostName);
    const staging = `${binary}.${process.pid}.universal`;
    run("lipo", [
      "-create",
      ...macTargets.map((target) => join(targetDir, target, "release", hostName)),
      "-output", staging,
    ]);
    renameSync(staging, binary);
    return;
  }

  buildHost();
  if (process.platform === "win32") {
    stageWindowsHost(process.arch, join(targetDir, "release", `${hostName}.exe`));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareDesktopHost();
}
