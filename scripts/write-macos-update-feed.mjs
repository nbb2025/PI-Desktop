import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeMacManualFeed(releaseDir) {
  const { version } = JSON.parse(await readFile(join(releaseDir, "..", "package.json"), "utf8"));
  const url = `PI-Desktop-${version}-universal.dmg`;
  const artifact = join(releaseDir, url);
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  const sha512 = hash.digest("base64");
  const { size } = await stat(artifact);
  const feed = { version, files: [{ url, sha512, size }], path: url, sha512 };
  // JSON is valid YAML and is accepted by the updater's YAML reader.
  await writeFile(join(releaseDir, "manual-mac.yml"), JSON.stringify(feed, null, 2) + "\n");
}

if (import.meta.main) {
  await writeMacManualFeed(process.argv[2] ?? "apps/desktop/release");
}
