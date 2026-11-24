import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  ciWorkflowSource,
  releaseWorkflowSource,
  desktopPackageSource,
  linuxPackageWorkflowSource,
  agentRuntimePackageSource,
  i18nPackageSource,
  pluginSdkPackageSource,
  sharedPackageSource,
  releaseMacScriptSource,
] = await Promise.all([
  read("../../../.github/workflows/ci.yml"),
  read("../../../.github/workflows/release.yml"),
  read("../package.json"),
  read("../../../.github/workflows/linux-package.yml"),
  read("../../../packages/agent-runtime/package.json"),
  read("../../../packages/i18n/package.json"),
  read("../../../packages/plugin-sdk/package.json"),
  read("../../../packages/shared/package.json"),
  read("../../../scripts/release-macos.sh"),
]);

test("CI skips documentation-only pushes and pull requests", () => {
  assert.equal(
    (ciWorkflowSource.match(/- 'docs\/\*\*'/g) ?? []).length,
    2,
    "docs path is ignored by push and pull_request triggers",
  );
  assert.equal(
    (ciWorkflowSource.match(/- '\*\*\/\*\.md'/g) ?? []).length,
    2,
    "Markdown files are ignored by push and pull_request triggers",
  );
  assert.match(ciWorkflowSource, /^  workflow_dispatch:/m);
});

test("CI does not typecheck workspace dependencies twice", () => {
  for (const source of [
    agentRuntimePackageSource,
    i18nPackageSource,
    pluginSdkPackageSource,
    sharedPackageSource,
  ]) {
    assert.match(JSON.parse(source).scripts.build, /^tsc\b/);
  }

  assert.match(
    ciWorkflowSource,
    /run: pnpm --filter @pi-desktop\/desktop typecheck/,
  );
  assert.doesNotMatch(ciWorkflowSource, /run: pnpm typecheck/);
});

test("release runners validate tags without a separate job barrier", () => {
  assert.doesNotMatch(releaseWorkflowSource, /^  validate:/m);
  assert.doesNotMatch(releaseWorkflowSource, /^    needs: validate$/m);
  assert.match(
    releaseWorkflowSource,
    /TAG_VERSION="\$\{GITHUB_REF_NAME#v\}"/,
  );
  assert.match(
    releaseWorkflowSource,
    /Tag v\$TAG_VERSION does not match apps\/desktop\/package\.json version \$APP_VERSION/,
  );
});

test("release packaging delegates each installer to its platform command", () => {
  const buildJob = releaseWorkflowSource.match(/^  build:\n[\s\S]*?(?=^  pi-host-bundle:)/m)?.[0];
  assert.ok(buildJob, "release build job is missing");
  assert.match(buildJob, /pnpm --filter @pi-desktop\/desktop run dist:win/);
  assert.match(buildJob, /pnpm --filter @pi-desktop\/desktop run dist:mac/);
  assert.doesNotMatch(buildJob, /cargo build|pnpm build:js|electron-builder --/);
});

test("release builds are gated on the CI checks and least-privilege permissions", () => {
  assert.match(releaseWorkflowSource, /^permissions:\n  contents: read$/m);
  assert.match(releaseWorkflowSource, /^  verify:/m);
  assert.match(releaseWorkflowSource, /^  build:\n[\s\S]*?^    needs: \[configuration, verify\]$/m);
  const verifyJob = releaseWorkflowSource.match(/^  verify:\n[\s\S]*?(?=^  build:)/m)?.[0];
  assert.ok(verifyJob, "release verify job is missing");
  for (const step of [
    /run: pnpm build:js/,
    /run: pnpm --filter @pi-desktop\/desktop typecheck/,
    /run: pnpm lint/,
    /run: pnpm -r --if-present test/,
    /run: cargo test -p host-core --locked/,
  ]) {
    assert.match(verifyJob, step);
  }
  const publishJob = releaseWorkflowSource.match(/^  publish:\n[\s\S]*$/m)?.[0];
  assert.ok(publishJob, "release publish job is missing");
  assert.match(publishJob, /^    permissions:\n      contents: write$/m);
});

test("release artifacts bypass redundant Actions compression", () => {
  assert.match(
    releaseWorkflowSource,
    /uses: actions\/upload-artifact@v7[\s\S]*?compression-level: 0/,
  );
});

test("manual Linux package validation covers the RPM desktop identity", () => {
  assert.match(linuxPackageWorkflowSource, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.match(linuxPackageWorkflowSource, /runs-on: ubuntu-22\.04/);
  assert.match(
    linuxPackageWorkflowSource,
    /run: pnpm --filter @pi-desktop\/desktop run dist:linux -- --x64/,
  );
  assert.match(
    linuxPackageWorkflowSource,
    /name: Install RPM inspection tools[\s\S]*apt-get install[\s\S]*cpio rpm/,
  );
  assert.match(
    linuxPackageWorkflowSource,
    /find apps\/desktop\/release[\s\S]*-name '\*\.rpm'/,
  );
  assert.match(linuxPackageWorkflowSource, /rpm -qpl "\$rpm_package"/);
  assert.match(linuxPackageWorkflowSource, /build-id/);
  assert.match(
    linuxPackageWorkflowSource,
    /usr\/share\/applications\/pi-desktop\.desktop/,
  );
  assert.match(linuxPackageWorkflowSource, /Icon=pi-desktop/);
  assert.match(linuxPackageWorkflowSource, /StartupWMClass=pi-desktop/);
  assert.match(
    linuxPackageWorkflowSource,
    /uses: actions\/upload-artifact@v7[\s\S]*path: apps\/desktop\/release\/\*\.rpm/,
  );
});

test("tag releases only publish desktop installers for Windows and macOS", () => {
  const buildJob = releaseWorkflowSource.match(/^  build:\n[\s\S]*?(?=^  pi-host-bundle:)/m)?.[0];
  assert.ok(buildJob, "release build job is missing");
  assert.deepEqual(
    [...buildJob.matchAll(/- name: (.* Universal)\n/g)].map(([, name]) => name),
    ["macOS Universal", "Windows Universal"],
  );
  assert.doesNotMatch(buildJob, /dist:linux|AppImage|\.asar|\.rpm|\.deb|latest-linux|Portable/);
  // Windows and macOS use both pi-host architectures for SSH workspaces.
  assert.match(
    releaseWorkflowSource,
    /pi-host-bundle:[\s\S]*?- arch: x64[\s\S]*?os: ubuntu-22\.04[\s\S]*?- arch: arm64[\s\S]*?os: ubuntu-22\.04-arm/,
  );
  assert.match(releaseWorkflowSource, /pi-host-\*-linux-.*\.tar\.gz\.sha256/);
});

test("the Linux package config lets the workflow choose the architecture", () => {
  const build = JSON.parse(desktopPackageSource).build;
  // electron-builder prefers a target's configured arch list over the CLI
  // `--x64`/`--arm64` flag, so pinning both here would make each Linux lane
  // build the other architecture around its own native host-core.
  for (const entry of build.linux.target) {
    assert.equal(
      entry.arch,
      undefined,
      `linux target ${entry.target} must not pin an arch`,
    );
  }
  assert.match(
    build.linux.artifactName,
    /-linux-\$\{arch\}\.\$\{ext\}$/,
    "the AppImage name carries its architecture",
  );
  assert.equal(build.deb.artifactName, "pi-desktop_${version}_${arch}.${ext}");
  assert.equal(build.rpm.artifactName, "pi-desktop-${version}-${arch}.${ext}");
});

test("release jobs verify both architectures inside their universal installers", () => {
  assert.match(
    releaseWorkflowSource,
    /name: macOS Universal[\s\S]*?rust_targets: x86_64-apple-darwin,aarch64-apple-darwin/,
  );
  assert.match(
    releaseWorkflowSource,
    /name: Windows Universal[\s\S]*?rust_targets: x86_64-pc-windows-msvc,i686-pc-windows-msvc/,
  );
  assert.match(releaseWorkflowSource, /\['win-unpacked', 0x8664\], \['win-ia32-unpacked', 0x14c\]/);
  assert.match(
    releaseWorkflowSource,
    /for arch in arm64 x86_64; do\n.*lipo .*Contents\/MacOS\/PI-Desktop" -verify_arch "\$arch"\n.*lipo .*Contents\/Resources\/bin\/pi-desktop-host-core" -verify_arch "\$arch"/,
  );
  assert.match(releaseWorkflowSource, /PI-Desktop-\*-universal\.dmg/);
  assert.match(releaseWorkflowSource, /PI-Desktop-Setup-\*\.exe/);
  assert.doesNotMatch(releaseWorkflowSource, /-c\.(?:dmg|zip)\.artifactName/);
});

test("macOS automatic updates require the signed release lane", () => {
  assert.match(
    releaseWorkflowSource,
    /workflow_dispatch:\s+inputs:\s+sign_macos:[\s\S]*?default:\s*true[\s\S]*?type:\s*boolean/,
  );
  assert.ok(
    releaseWorkflowSource.includes(
      "MACOS_SIGN_RELEASE: ${{ needs.configuration.outputs.macos_signed }}",
    ),
  );

  const manualBlock = releaseWorkflowSource.match(
    /- name: Package macOS manual-install bundle[\s\S]*?(?=\n      - name:)/,
  )?.[0];
  assert.ok(manualBlock, "macOS manual-install package step is missing");
  assert.match(manualBlock, /env\.MACOS_SIGN_RELEASE != 'true'/);
  assert.match(manualBlock, /CSC_IDENTITY_AUTO_DISCOVERY:\s*'false'/);
  assert.match(manualBlock, /-c\.mac\.identity=-/);
  assert.match(releaseWorkflowSource, /codesign --verify --deep --strict/);
  assert.doesNotMatch(manualBlock, /CSC_LINK:|CSC_KEY_PASSWORD:|APPLE_/);
  assert.doesNotMatch(manualBlock, /forceCodeSigning|notarize/);

  assert.match(releaseWorkflowSource, /Incomplete macOS signing configuration/);
  assert.match(releaseWorkflowSource, /node scripts\/write-macos-update-feed\.mjs/);

  const signedBlock = releaseWorkflowSource.match(
    /- name: Package signed and notarized macOS installer[\s\S]*?(?=\n      - name:)/,
  )?.[0];
  assert.ok(signedBlock, "signed macOS package step is missing");
  assert.match(signedBlock, /env\.MACOS_SIGN_RELEASE == 'true'/);
  for (const secret of [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    assert.match(signedBlock, new RegExp(`${secret}:\\s*\\$\\{\\{\\s*secrets\\.${secret}\\s*\\}\\}`));
  }
  assert.match(signedBlock, /-c\.extraMetadata\.piMacUpdates=true/);
  assert.doesNotMatch(signedBlock, /-c\.mac\.identity=/);
  assert.doesNotMatch(signedBlock, /CSC_NAME: "Developer ID Application:/);
  assert.match(signedBlock, /-c\.mac\.notarize=true/);
  // The single "signing PI-Desktop.app" line electron-builder prints does not
  // tell walking, per-file codesign, silent retries, and the Apple
  // notarization wait apart; the signing trace and the watchdog carry the rest.
  assert.match(
    signedBlock,
    /DEBUG: "electron-osx-sign\*,electron-notarize\*"/,
  );
  // builder-util's `executing` debug line prints every spawned command with a
  // stem list that does not cover `security set-key-partition-list -k <p12
  // password>`, so electron-builder's namespace is deliberately excluded.
  assert.doesNotMatch(signedBlock, /DEBUG: ".*electron-builder.*"/);
  assert.match(signedBlock, /PI_SIGNING_TIMEOUT_SECONDS: "1800"/);
  assert.match(signedBlock, /PI_SIGNING_STALL_SECONDS: "300"/);
  assert.match(signedBlock, /PI_STAPLER_MAX_ATTEMPTS: "6"/);
  assert.match(signedBlock, /PI_STAPLER_RETRY_DELAY_SECONDS: "10"/);
  assert.match(
    signedBlock,
    /node scripts\/macos-signing-watchdog\.mjs \\\n\s+--label "dist:mac-universal" \\\n\s+-- pnpm --filter @pi-desktop\/desktop run dist:mac/,
    "the signed macOS packaging phase runs under the signing watchdog",
  );
  // electron-builder notarizes only the .app; the DMG needs its own
  // submission before the ticket can be stapled (error 65 otherwise).
  const dmgBlock = releaseWorkflowSource.match(
    /- name: Notarize and staple the macOS DMG[\s\S]*?(?=\n      - name:)/,
  )?.[0];
  assert.ok(dmgBlock, "DMG notarization step is missing");
  assert.match(dmgBlock, /env\.MACOS_SIGN_RELEASE == 'true'/);
  for (const secret of [
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    assert.match(
      dmgBlock,
      new RegExp(`${secret}:\\s*\\$\\{\\{\\s*secrets\\.${secret}\\s*\\}\\}`),
    );
  }
  assert.match(
    dmgBlock,
    /node scripts\/macos-signing-watchdog\.mjs[\s\S]*?-- scripts\/notarize-and-staple-macos-release-dmg\.sh apps\/desktop\/release/,
    "the DMG notarization wait runs under the signing watchdog",
  );
  assert.match(dmgBlock, /PI_SIGNING_TIMEOUT_SECONDS: "1200"/);
  assert.match(
    releaseWorkflowSource,
    /- name: Analyze the packaged macOS app bundle[\s\S]*?if: matrix\.platform == 'macos'[\s\S]*?continue-on-error: true[\s\S]*?run: node scripts\/macos-bundle-inventory\.mjs apps\/desktop\/release/,
    "the packaged macOS bundle is measured, without failing a release",
  );
  assert.match(
    releaseWorkflowSource,
    /Notarize and staple the macOS DMG[\s\S]*?if: matrix\.platform == 'macos' && env\.MACOS_SIGN_RELEASE == 'true'[\s\S]*?Verify signed and notarized macOS installer/,
  );
  assert.doesNotMatch(releaseWorkflowSource, /scripts\/staple-macos-release-dmg\.sh/);
});

test("the signed local macOS lane uses the universal packaging command", () => {
  assert.match(releaseMacScriptSource, /run dist:mac --signed-macos/);
  assert.match(releaseMacScriptSource, /-c\.extraMetadata\.piMacUpdates=true/);
  assert.match(
    releaseMacScriptSource,
    /MAC_SIGNING_IDENTITY="\$\{MAC_SIGNING_IDENTITY#Developer ID Application: \}"/,
    "the local lane strips the prefix electron-builder rejects",
  );
  assert.doesNotMatch(
    releaseMacScriptSource,
    /-c\.(?:dmg|zip)\.artifactName/,
    "the signed local macOS lane uses the shared artifact naming config",
  );
  // The local lane documents itself as Developer ID + mandatory
  // notarization, so it must pass both flags and must not publish.
  assert.match(releaseMacScriptSource, /-c\.mac\.notarize=true/);
  assert.match(releaseMacScriptSource, /-c\.mac\.forceCodeSigning=true/);
  assert.doesNotMatch(
    releaseMacScriptSource,
    /DEBUG="\$\{DEBUG:-[^}]*electron-builder/,
    "the local lane must not enable builder-util's executing debug line",
  );
  assert.match(
    releaseMacScriptSource,
    /node scripts\/macos-signing-watchdog\.mjs --label "release-macos-universal" --/,
    "the local signed macOS lane runs under the signing watchdog",
  );
  assert.match(
    releaseMacScriptSource,
    /node scripts\/macos-bundle-inventory\.mjs apps\/desktop\/release/,
  );
  // The DMG is submitted, stapled, and validated once, and the release is
  // verified exactly once.
  assert.match(
    releaseMacScriptSource,
    /scripts\/notarize-and-staple-macos-release-dmg\.sh apps\/desktop\/release/,
  );
  assert.equal(
    (releaseMacScriptSource.match(/scripts\/verify-macos-release\.sh/g) ?? []).length,
    1,
    "the local signed macOS lane verifies the release exactly once",
  );
  assert.doesNotMatch(releaseMacScriptSource, /scripts\/staple-macos-release-dmg\.sh/);
});

/**
 * The regression that broke the local signed lane: a rewrite replaced the
 * electron-builder flags with two commands but kept the line continuation, so
 * one command became a positional argument while the other still pointed at a
 * deleted script. Every script path either lane references must exist.
 */
test("both macOS lanes only reference scripts that exist", async () => {
  const referenced = new Set();
  for (const source of [releaseMacScriptSource, releaseWorkflowSource]) {
    for (const match of source.matchAll(/(?<![\w./-])scripts\/[A-Za-z0-9._-]+\.(?:sh|mjs)/g)) {
      referenced.add(match[0]);
    }
  }
  assert.ok(referenced.size >= 6, "the macOS lanes reference their scripts");
  const missing = [];
  for (const relPath of referenced) {
    try {
      await access(new URL(`../../../${relPath}`, import.meta.url));
    } catch {
      missing.push(relPath);
    }
  }
  assert.deepEqual(missing, []);
});

test("macOS signing instrumentation stays out of the Windows and Linux lanes", () => {
  const instrumentation =
    /macos-signing-watchdog|macos-signing-diagnostics|macos-bundle-inventory/;
  const stepBlock = (name) =>
    releaseWorkflowSource.match(new RegExp(`- name: ${name}[^]*?(?=\\n      - name:)`))?.[0] ??
    "";
  const windowsBlock = stepBlock("Package universal Windows installer");
  assert.ok(windowsBlock, "Windows package step is missing");
  assert.doesNotMatch(windowsBlock, instrumentation);
  const manualBlock = stepBlock("Package macOS manual-install bundle");
  assert.ok(manualBlock, "macOS manual-install package step is missing");
  assert.doesNotMatch(manualBlock, instrumentation);
});

test("the iAgent release stays in its GitHub repository", async () => {
  await assert.rejects(access(new URL("../../../.github/workflows/mirror-to-cnb.yml", import.meta.url)));
  assert.doesNotMatch(releaseWorkflowSource, /CNB_MIRROR_TOKEN|DUV63RKYTW/);
});
