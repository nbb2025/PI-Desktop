import { spawn } from "node:child_process";
import process from "node:process";
import { prepareDesktopHost } from "./prepare-desktop-host.mjs";

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

const macArchitectureFlags = target === "mac"
  ? args.filter((arg) => /^--(?:arm64|x64|universal|ia32|arm|armv7l)(?:=|$)/.test(arg))
  : [];
const macArch = macArchitectureFlags[0]?.slice(2) ?? process.arch;
if (target === "mac" && (macArchitectureFlags.length > 1 || !["arm64", "x64"].includes(macArch))) {
  throw new Error("Build one macOS DMG at a time with --arm64 or --x64.");
}

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

prepareDesktopHost(target === "win", macArch);

const builderTargets = {
  win: ["--win", "nsis", "--x64", "--ia32"],
  mac: ["--mac", "dmg", `--${macArch}`],
  linux: ["--linux"],
};
await runBuilder([
  ...builderTargets[target],
  "--publish", "never",
  ...args.filter((arg) => !macArchitectureFlags.includes(arg)),
]);
