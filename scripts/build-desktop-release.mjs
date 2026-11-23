import { spawn } from "node:child_process";
import { rename } from "node:fs/promises";
import process from "node:process";

const forwardedArgs = process.argv.slice(2);

const hostTarget =
  process.platform === "win32"
    ? "win"
    : process.platform === "darwin"
      ? "mac"
      : "linux";
const requestedTarget = ["linux", "mac", "win"].includes(forwardedArgs[0])
  ? forwardedArgs.shift()
  : undefined;
const target = requestedTarget ?? hostTarget;

if (!["linux", "mac", "win"].includes(target)) {
  throw new Error(`Unsupported desktop release target: ${target}`);
}

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function runBuilder(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpmCommand, ["exec", "electron-builder", ...args], {
      // Windows exposes pnpm as a .cmd shim. Launch it through the shell so
      // Node can start the shim consistently on the hosted Windows runner.
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

if (target === "win") {
  const ia32 = forwardedArgs.includes("--ia32");
  await runBuilder([
    "--win",
    "nsis",
    "--publish",
    "never",
    ...forwardedArgs,
    "-c.extraMetadata.piDistribution=installed",
    ...(ia32 ? ["-c.nsis.artifactName=PI-Desktop-Setup-${version}-ia32.${ext}"] : []),
  ]);
  if (ia32) {
    await rename("release/latest.yml", "release/latest-ia32.yml");
  } else {
    await runBuilder([
      "--win",
      "zip",
      "--publish",
      "never",
      ...forwardedArgs,
      "-c.extraMetadata.piDistribution=zip",
    ]);
    await runBuilder([
      "--win",
      "portable",
      "--publish",
      "never",
      ...forwardedArgs,
      "-c.extraMetadata.piDistribution=portable",
    ]);
  }
} else {
  await runBuilder([
    `--${target}`,
    "--publish",
    "never",
    ...forwardedArgs,
  ]);
}
