#!/usr/bin/env bash
# Builds UsageBar.app from mac/main.swift. Run this on macOS (needs Xcode CLT).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
APP="$HERE/build/UsageBar.app"
MIN_MACOS="${MIN_MACOS:-12.0}"

command -v swiftc >/dev/null || { echo "swiftc not found — install Xcode Command Line Tools:  xcode-select --install" >&2; exit 1; }

echo "building UsageBar.app (deployment target macOS $MIN_MACOS)"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O \
  -target "$(uname -m)-apple-macosx$MIN_MACOS" \
  -framework AppKit \
  -o "$APP/Contents/MacOS/UsageBar" \
  "$HERE/main.swift"

# The app shells out to `node <repo>/src/cli.js`. A copy dragged out of a DMG
# has no repo, so ship one inside the bundle. Zero runtime dependencies, so this
# is a plain copy of ~220K of source — no install step, nothing to vendor.
RES="$APP/Contents/Resources/usage-bar"
mkdir -p "$RES"
cp -R "$REPO/src" "$RES/"
cp "$REPO/package.json" "$RES/"
echo "bundled CLI ($(find "$RES/src" -type f | wc -l | tr -d ' ') files)"

# A distribution build must not bake the maintainer's home directory into a
# plist shipped to other people; it is meaningless there and leaks a path.
if [ "${USAGE_BAR_DIST:-}" = "1" ]; then
  REPO_KEY=""
  echo "distribution build: using the bundled CLI only"
else
  REPO_KEY="  <key>UsageBarRepoPath</key><string>$REPO</string>"
fi

# One version, from package.json. Hardcoding it here drifts against the DMG
# filename, which is derived from the same file — and a build whose About box
# disagrees with its download is a bug report waiting to be filed.
VERSION="$(node -p "require('$REPO/package.json').version" 2>/dev/null || echo 0.0.0)"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>UsageBar</string>
  <key>CFBundleDisplayName</key><string>Claude Usage Bar</string>
  <key>CFBundleIdentifier</key><string>dev.wfoster.usagebar</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>NSHumanReadableCopyright</key><string>Copyright &#169; 2026 William Foster · https://wfoster.dev · MIT</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>UsageBar</string>
  <key>LSMinimumSystemVersion</key><string>$MIN_MACOS</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <!-- The dashboard is a loopback-only HTTP server on this machine. -->
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
  <!-- Development builds point at the working copy so edits take effect without
       a rebuild. Absent in distribution builds, which use the bundled CLI. -->
$REPO_KEY
</dict>
</plist>
PLIST

# A truncated or malformed Info.plist does not fail loudly: LaunchServices
# simply declines to launch the bundle, so `open` does nothing at all and the
# app has no identity for UserDefaults to key off. Never ship one unchecked.
if command -v plutil >/dev/null; then
  plutil -lint "$APP/Contents/Info.plist" >/dev/null || {
    echo "ERROR: generated Info.plist is malformed." >&2
    plutil -lint "$APP/Contents/Info.plist" >&2 || true
    exit 1
  }
  echo "Info.plist validated"
fi

# The app shells out to `node src/cli.js serve`; record where the repo lives so
# it can find the CLI regardless of where the .app is moved to.
if [ "${USAGE_BAR_DIST:-}" != "1" ]; then
  defaults write dev.wfoster.usagebar UsageBarRepoPath -string "$REPO"
fi

# Signing is NOT optional on Apple Silicon: the kernel refuses to execute an
# arm64 binary without a valid signature, and it does so by killing the process
# at launch with no dialog and no window. For a menu-bar-only app that looks
# exactly like "the app has no UI", so a failure here must be loud.
#
# Two paths. With a Developer ID certificate we sign for real and enable the
# Hardened Runtime, which is what notarisation requires. Without one we fall back
# to an ad-hoc signature: fine for running locally, but Gatekeeper will block it
# on any machine it was downloaded to.
if [ -z "${SIGN_IDENTITY:-}" ]; then
  SIGN_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | awk -F'"' '/Developer ID Application/ {print $2; exit}')"
fi

if [ -n "${SIGN_IDENTITY:-}" ]; then
  echo "signing with: $SIGN_IDENTITY"
  # No --deep: it is documented as a verification flag, and signing nested code
  # this way is discouraged. There is no nested code here anyway — Resources
  # holds JavaScript, which is data as far as codesign is concerned.
  # --timestamp is required for notarisation and cannot be added afterwards.
  if ! codesign --force --options runtime --timestamp \
       --entitlements "$HERE/entitlements.plist" \
       --sign "$SIGN_IDENTITY" "$APP"; then
    echo "ERROR: codesign failed." >&2
    exit 1
  fi
  SIGNED_FOR_DISTRIBUTION=1
else
  echo "signing… (ad-hoc — no Developer ID certificate found)"
  if ! codesign --force --sign - "$APP"; then
    echo "ERROR: codesign failed. The app will be killed at launch on Apple Silicon." >&2
    exit 1
  fi
  SIGNED_FOR_DISTRIBUTION=0
fi

if ! codesign --verify --deep --strict "$APP" 2>&1; then
  echo "ERROR: signature did not verify." >&2
  exit 1
fi
echo "signature verified"

# Records how the app was signed so dmg.sh knows whether notarisation is even
# possible, rather than submitting an ad-hoc bundle and failing opaquely. The
# identity goes with it: dmg.sh runs this script as a child process, so a shell
# variable set here would not survive back up to it, and the disk image has to be
# signed with the same certificate as the app inside it.
echo "$SIGNED_FOR_DISTRIBUTION" > "$HERE/build/.signed-for-distribution"
printf '%s' "${SIGN_IDENTITY:-}" > "$HERE/build/.sign-identity"

if [ "$SIGNED_FOR_DISTRIBUTION" = "1" ]; then
  # Only meaningful for a real signature; an ad-hoc app always fails this.
  if spctl -a -vvv -t exec "$APP" 2>&1 | grep -q 'accepted'; then
    echo "Gatekeeper: accepted"
  else
    echo "Gatekeeper: not yet accepted — needs notarisation (mac/dmg.sh does it)"
  fi
fi

# Files written from a container mount can carry the quarantine flag, which
# makes Gatekeeper block an ad-hoc signed app silently.
if xattr -p com.apple.quarantine "$APP" >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$APP"
  echo "removed quarantine attribute"
fi

echo
echo "built: $APP"
echo
echo "run:      open '$APP'"
echo "log:      tail -f ~/Library/Logs/UsageBar.log"
echo "debug:    '$APP/Contents/MacOS/UsageBar'      # runs in the foreground, prints errors"
echo "check:    '$APP/Contents/MacOS/UsageBar' --check    # diagnostics, then exits"
echo "doctor:   bash '$(cd "$(dirname "$0")" && pwd)/doctor.sh'"
echo "port:     defaults write dev.wfoster.usagebar UsageBarPort -int 4317"
echo "repo:     defaults write dev.wfoster.usagebar UsageBarRepoPath -string '$REPO'"
