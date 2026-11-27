import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Electron Builder does not expose ULMO in its DMG configuration. Recompress
// the finished image before checksums or the separate notarization step.
export default async function compressMacDmg({ file, target, packager, isWriteUpdateInfo }) {
  if (target?.name !== "dmg" || !file || isWriteUpdateInfo) return;
  const { dmg } = packager.config;
  if (dmg?.sign === true || dmg?.format != null) return;

  const originalSize = (await stat(file)).size;
  const temp = await mkdtemp(join(dirname(file), ".pi-dmg-"));
  try {
    const compressed = join(temp, "compressed.dmg");
    await execFileAsync("/usr/bin/hdiutil", [
      "convert", file, "-format", "ULMO", "-o", compressed, "-quiet",
    ]);
    const compressedSize = (await stat(compressed)).size;
    if (compressedSize >= originalSize) return;

    await execFileAsync("/usr/bin/hdiutil", ["verify", compressed, "-quiet"]);
    await rename(compressed, file);
    console.log(`Compressed ${basename(file)} with LZMA (${originalSize} to ${compressedSize} bytes)`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
