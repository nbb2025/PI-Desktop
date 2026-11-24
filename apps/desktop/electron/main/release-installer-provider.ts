import electronUpdater from "electron-updater";
import type { AppUpdater, UpdateInfo } from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import type { ResolvedUpdateFileInfo } from "electron-updater/out/types";
import { GITHUB_REPO } from "@pi-desktop/shared";

const { Provider } = electronUpdater;
const LATEST_RELEASE = new URL(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
type InstallerPlatform = "win32" | "darwin";

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function installerUpdate(
  payload: unknown,
  platform: InstallerPlatform,
  currentVersion: AppUpdater["currentVersion"],
): UpdateInfo {
  const release = object(payload);
  const tag = release?.tag_name;
  if (typeof tag !== "string" || !STABLE_TAG.test(tag) ||
      release?.draft !== false || release.prerelease !== false ||
      typeof release.published_at !== "string") {
    throw new Error("GitHub returned an invalid stable desktop release");
  }

  const version = tag.slice(1);
  const releaseDate = release.published_at;
  if (currentVersion.compare(version) >= 0) {
    return { version, releaseDate, files: [], path: "", sha512: "" };
  }

  const filename = platform === "win32"
    ? `PI-Desktop-Setup-${version}.exe`
    : `PI-Desktop-${version}-universal.dmg`;
  const assets: unknown[] = Array.isArray(release.assets) ? release.assets : [];
  const installer = assets.map(object).find((asset) =>
    asset?.name === filename && asset.state === "uploaded",
  );
  const size = installer?.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error("The latest desktop release is missing the installer for this platform");
  }

  const metadata = typeof release.body === "string"
    ? /^<!-- pi-desktop-installers: (\{[^\r\n]*\}) -->$/m.exec(release.body)?.[1]
    : undefined;
  const hashes = metadata ? object(JSON.parse(metadata)) : undefined;
  const sha512 = hashes?.[filename];
  if (typeof sha512 !== "string" || !SHA512_BASE64.test(sha512)) {
    throw new Error("The latest desktop release is missing a valid installer checksum");
  }

  return { version, releaseDate, files: [{ url: filename, size, sha512 }], path: filename, sha512 };
}

/** Discover the two public installers without separate updater assets. */
export class ReleaseInstallerProvider extends Provider<UpdateInfo> {
  private readonly platform: InstallerPlatform;
  private readonly updater: AppUpdater;

  constructor(_options: unknown, updater: AppUpdater, options: ProviderRuntimeOptions) {
    super(options);
    if (options.platform !== "win32" && options.platform !== "darwin") {
      throw new Error("The desktop installer provider requires Windows or macOS");
    }
    this.platform = options.platform;
    this.updater = updater;
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    const response = await this.httpRequest(LATEST_RELEASE, { Accept: "application/vnd.github+json" });
    const payload: unknown = JSON.parse(response ?? "null");
    return installerUpdate(payload, this.platform, this.updater.currentVersion);
  }

  resolveFiles(update: UpdateInfo): ResolvedUpdateFileInfo[] {
    const base = new URL(`https://github.com/${GITHUB_REPO}/releases/download/v${update.version}/`);
    return update.files.map((info) => ({ url: new URL(info.url, base), info }));
  }
}
