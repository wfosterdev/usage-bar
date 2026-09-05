#!/usr/bin/env bash
# Builds a distributable UsageBar.dmg. Run on macOS (needs Xcode CLT).
#
# With a Developer ID certificate and notarisation credentials this produces a
# disk image that opens with no warning at all. Without them it still builds,
# ad-hoc signed, and says clearly that users will hit Gatekeeper.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
APP="$HERE/build/UsageBar.app"
STAGE="$HERE/build/dmg"
VERSION="$(node -p "require('$REPO/package.json').version" 2>/dev/null || echo 0.0.0)"
DMG="$HERE/build/UsageBar-$VERSION.dmg"

command -v hdiutil >/dev/null || { echo "hdiutil not found — this only runs on macOS" >&2; exit 1; }

# A distribution build ships the bundled CLI and bakes no local paths.
USAGE_BAR_DIST=1 "$HERE/build.sh"

SIGNED="$(cat "$HERE/build/.signed-for-distribution" 2>/dev/null || echo 0)"
# build.sh ran as a child process, so pick the identity back up from disk rather
# than from the environment — otherwise the image below goes out unsigned.
if [ -z "${SIGN_IDENTITY:-}" ]; then
  SIGN_IDENTITY="$(cat "$HERE/build/.sign-identity" 2>/dev/null || echo '')"
fi
CAN_NOTARIZE=0
if [ "$SIGNED" = "1" ]; then
  if [ -n "${NOTARY_PROFILE:-}" ] || { [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; }; then
    CAN_NOTARIZE=1
  fi
fi

# Notarise the .app itself before it goes in the image, and staple it. Notarising
# only the DMG leaves the app without its own ticket, so once someone drags it to
# Applications it needs a network round trip to validate — and fails closed on a
# machine that is offline.
if [ "$CAN_NOTARIZE" = "1" ]; then
  echo
  echo "notarising the app"
  APP_ZIP="$HERE/build/UsageBar-app.zip"
  rm -f "$APP_ZIP"
  # ditto, not zip: it preserves the bundle's symlinks and extended attributes,
  # which a plain zip mangles and notarisation then rejects.
  /usr/bin/ditto -c -k --keepParent "$APP" "$APP_ZIP"
  "$HERE/notarize.sh" "$APP_ZIP"
  # The ticket is stapled to the zip's contents, so re-staple the .app directly.
  xcrun stapler staple "$APP"
  rm -f "$APP_ZIP"
fi

echo
echo "staging disk image contents"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
# The conventional drag-to-install target.
ln -s /Applications "$STAGE/Applications"

# A short note in the mounted volume. Its content depends on what we can actually
# promise: telling notarised users about a Gatekeeper prompt they will never see
# would be its own kind of wrong.
if [ "$CAN_NOTARIZE" = "1" ]; then
  cat > "$STAGE/READ ME FIRST.txt" <<'NOTE'
UsageBar
========

1. Drag UsageBar.app to Applications, then open it.

2. Node.js 20 or newer must be installed — the app runs a small local server.
     node --version
   If you do not have it:  https://nodejs.org  or  brew install node

3. UsageBar has no Dock icon and no window. It lives in the menu bar.
   If nothing appears, your menu bar may be full (common on notched displays):
   quit another menu bar app, or hold Command and drag icons to make room.

Diagnostics:  /Applications/UsageBar.app/Contents/MacOS/UsageBar --check
Log:          ~/Library/Logs/UsageBar.log
NOTE
else
  cat > "$STAGE/READ ME FIRST.txt" <<'NOTE'
UsageBar
========

1. Drag UsageBar.app to Applications.

2. This build is NOT notarised, so the first time you open it macOS will say the
   app "cannot be opened because the developer cannot be verified".

   To open it anyway:
     - Right-click (or Control-click) UsageBar.app -> Open -> Open

   Or from Terminal:
     xattr -dr com.apple.quarantine /Applications/UsageBar.app

3. Node.js 20 or newer must be installed — the app runs a small local server.
     node --version
   If you do not have it:  https://nodejs.org  or  brew install node

4. UsageBar has no Dock icon and no window. It lives in the menu bar.
   If nothing appears, your menu bar may be full (common on notched displays):
   quit another menu bar app, or hold Command and drag icons to make room.

Diagnostics:  /Applications/UsageBar.app/Contents/MacOS/UsageBar --check
Log:          ~/Library/Logs/UsageBar.log
NOTE
fi

echo "building $DMG"
hdiutil create \
  -volname "UsageBar" \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  "$DMG" >/dev/null

rm -rf "$STAGE"

# The image itself is signed and notarised too, so the download validates before
# anyone has opened it.
if [ "$SIGNED" = "1" ] && [ -n "${SIGN_IDENTITY:-}" ]; then
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
  echo "signed the disk image"
elif [ "$SIGNED" = "1" ]; then
  echo "WARNING: the app is signed but the disk image is not — no identity found." >&2
fi

if [ "$CAN_NOTARIZE" = "1" ]; then
  echo
  echo "notarising the disk image"
  "$HERE/notarize.sh" "$DMG"
fi

SIZE="$(du -h "$DMG" | cut -f1 | tr -d ' ')"
echo
echo "built: $DMG  ($SIZE)"
echo

if [ "$CAN_NOTARIZE" = "1" ]; then
  echo "Signed with Developer ID and notarised. Opens with no warning."
  echo "Verify:  spctl -a -vvv -t install '$DMG'"
  echo "         xcrun stapler validate '$DMG'"
else
  echo "NOT notarised — users will hit Gatekeeper on first open."
  if [ "$SIGNED" != "1" ]; then
    echo "  No Developer ID certificate found. Check:  security find-identity -v -p codesigning"
  else
    echo "  Signed, but no notarisation credentials. Set NOTARY_PROFILE, or"
    echo "  APPLE_ID + APPLE_APP_PASSWORD + APPLE_TEAM_ID. See mac/notarize.sh."
  fi
  echo "  The workaround is documented in READ ME FIRST.txt and the README."
fi
