#!/usr/bin/env bash
# Release build for macOS: Developer ID-signed and notarized universal DMG/ZIP.
#
# Local builds without a certificate remain unsigned. This script injects a
# real signing identity and requires notarization credentials:
#
#   MAC_SIGNING_IDENTITY   Developer ID Application certificate common
#                          name; electron-builder rejects the
#                          "Developer ID Application:" prefix
#   APPLE_ID               Apple ID email for notarization
#   APPLE_APP_SPECIFIC_PASSWORD  app-specific password for the Apple ID
#   APPLE_TEAM_ID          Apple Developer Team ID matching the certificate
#
# Observability: the packaging command runs under
# scripts/macos-signing-watchdog.mjs, which enables the per-file signing trace
# (DEBUG=electron-osx-sign*) and the notarization progress
# (DEBUG=electron-notarize*), prints a heartbeat while electron-builder is
# silent, dumps diagnostics when the signing phase stalls, bounds the phase
# with a hard timeout, and reports per-file codesign timings. The
# `signing PI-Desktop.app` line electron-builder emits is otherwise the last
# thing the log shows for minutes, because nested signing, silent full
# retries, and Apple's notarization queue all happen without output.
# See docs/spec/06-delivery/06-release-runbook.md for the full runbook.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: scripts/release-macos.sh must run on macOS." >&2
  exit 1
fi

MAC_SIGNING_IDENTITY="${MAC_SIGNING_IDENTITY:?Set the Developer ID Application identity}"
MAC_SIGNING_IDENTITY="${MAC_SIGNING_IDENTITY#Developer ID Application: }"
export APPLE_TEAM_ID="${APPLE_TEAM_ID:?Set the Developer ID team ID}"

if [[ -z "${APPLE_ID:-}" || -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
  echo "error: notarization credentials are required (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD)." >&2
  echo "For an unsigned local build use: pnpm --filter @pi-desktop/desktop dist" >&2
  exit 1
fi

if [[ ! "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "error: Invalid APPLE_TEAM_ID." >&2
  exit 1
fi

echo "==> Packaging the universal desktop (Developer ID signed + notarized)"
# The packaging wrapper uses `--publish never`; the
# Release workflow owns publication. The watchdog is transparent: it forwards
# every line, keeps the child's exit code, and only fails on its own timeout.
# `electron-builder` is intentionally absent from DEBUG: builder-util's
# `executing` line prints every spawned command with only its own stem list
# redacted, which leaves `security set-key-partition-list -k <p12 password>`
# in clear text on a terminal or in a log file.
PI_STAPLER_MAX_ATTEMPTS="${PI_STAPLER_MAX_ATTEMPTS:-6}" \
PI_STAPLER_RETRY_DELAY_SECONDS="${PI_STAPLER_RETRY_DELAY_SECONDS:-10}" \
DEBUG="${DEBUG:-electron-osx-sign*,electron-notarize*}" \
  node scripts/macos-signing-watchdog.mjs --label "release-macos-universal" -- \
  pnpm --filter @pi-desktop/desktop run dist:mac --signed-macos \
    -c.extraMetadata.piMacUpdates=true \
    -c.mac.identity="${MAC_SIGNING_IDENTITY}" \
    -c.mac.forceCodeSigning=true \
    -c.mac.notarize=true

echo "==> Analyzing the packaged app bundle"
node scripts/macos-bundle-inventory.mjs apps/desktop/release

echo "==> Notarizing and stapling the DMG"
scripts/notarize-and-staple-macos-release-dmg.sh apps/desktop/release

echo "==> Verifying the signed and notarized release"
scripts/verify-macos-release.sh apps/desktop/release

node scripts/write-macos-update-feed.mjs apps/desktop/release

echo "==> Done. Artifacts in apps/desktop/release/"
