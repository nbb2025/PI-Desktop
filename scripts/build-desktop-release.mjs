import { spawn } from "node:child_process";
import { copyFile } from "node:fs/promises";
import process from "node:process";
import { prepareDesktopHost } from "./prepare-desktop-host.mjs";
import { writeMacManualFeed } from "./write-macos-update-feed.mjs";

const targets = { win32: "win", darwin: "mac", linux: "linux" };
const nativeTarget = targets[process.platform];
if (!nativeTarget) throw new Error(`Unsupported desktop release platform: ${process.platform}`);

const args = process.argv.slice(2);
const target = Object.values(targets).includes(args[0])
  ? args.shift()
  : nativeTarget;
if (target !== nativeTarget) {
  throw new Error(`The ${target} release requires a native runner for that platform.`);
}

const signedMac = target === "mac" && args.includes("--signed-macos");
const forwardedArgs = args.filter((arg) => arg !== "--signed-macos");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function runBuilder(builderArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpmCommand, ["exec", "electron-builder", ...builderArgs], {
      // Launch the pnpm.cmd shim through the shell on Windows.
      shell: process.platform === "win32",
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `electron-builder ${target} target failed with ${
            code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`
          }`,
        ),
      );
    });
  });
}

prepareDesktopHost(target !== "linux");

const builderTargets = {
  win: ["--win", "nsis", "--x64", "--ia32"],
  mac: ["--mac", "dmg", ...(signedMac ? ["zip"] : []), "--universal"],
  linux: ["--linux"],
};
await runBuilder([
  ...builderTargets[target],
  "--publish", "never",
  ...forwardedArgs,
]);

if (target === "win") {
  // Older 32-bit installs still request their dedicated channel.
  await copyFile("release/latest.yml", "release/latest-ia32.yml");
}
// The signed lane writes the feed after notarization staples the final DMG.
if (target === "mac" && !signedMac) await writeMacManualFeed("release");
