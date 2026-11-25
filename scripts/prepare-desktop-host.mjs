import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const targetDir = join(root, "target");
const hostName = "pi-desktop-host-core";
const windowsTargets = [
  ["x64", "x86_64-pc-windows-msvc"],
  ["ia32", "i686-pc-windows-msvc"],
];
const macTargets = new Map([
  ["arm64", "aarch64-apple-darwin"],
  ["x64", "x86_64-apple-darwin"],
]);

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

function buildHost(targets = []) {
  run("cargo", [
    "build", "--release", "--locked", "-p", "host-core", "--target-dir", targetDir,
    ...targets.flatMap((target) => ["--target", target]),
  ]);
}

function stageHost(arch, source, name) {
  const folder = join(targetDir, "desktop-release", arch);
  mkdirSync(folder, { recursive: true });
  copyFileSync(source, join(folder, name));
}

export function prepareDesktopHost(universalWindows = false, macArch = process.arch) {
  if (universalWindows && process.platform === "win32") {
    buildHost(windowsTargets.map(([, target]) => target));
    for (const [arch, target] of windowsTargets) {
      const filename = `${hostName}.exe`;
      stageHost(arch, join(targetDir, target, "release", filename), filename);
    }
    return;
  }

  if (process.platform === "darwin") {
    const target = macTargets.get(macArch);
    if (!target) throw new Error(`Unsupported macOS architecture: ${macArch}`);
    buildHost([target]);
    stageHost(macArch, join(targetDir, target, "release", hostName), hostName);
    return;
  }

  buildHost();
  if (process.platform === "win32") {
    const filename = `${hostName}.exe`;
    stageHost(process.arch, join(targetDir, "release", filename), filename);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareDesktopHost();
}
