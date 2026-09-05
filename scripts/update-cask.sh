#!/usr/bin/env bash
# Rewrites the version and sha256 in Casks/usage-bar.rb from a built DMG.
#
#   scripts/update-cask.sh mac/build/UsageBar-0.1.0.dmg
#
# The version comes from package.json rather than the filename: the filename is
# derived from it too, so trusting the filename would only hide a mismatch.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CASK="$REPO/Casks/usage-bar.rb"

DMG="${1:-}"
[ -n "$DMG" ] || { echo "usage: update-cask.sh <path-to-dmg>" >&2; exit 1; }
[ -f "$DMG" ] || { echo "no such file: $DMG" >&2; exit 1; }

VERSION="$(node -p "require('$REPO/package.json').version")"

# The cask's url interpolates #{version}, so a DMG whose name does not match
# would publish a cask pointing at a file that does not exist.
EXPECTED="UsageBar-$VERSION.dmg"
if [ "$(basename "$DMG")" != "$EXPECTED" ]; then
  echo "ERROR: expected $EXPECTED but got $(basename "$DMG")." >&2
  echo "       package.json says $VERSION — is the tag out of step?" >&2
  exit 1
fi

if command -v shasum >/dev/null; then
  SHA="$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
else
  SHA="$(sha256sum "$DMG" | cut -d' ' -f1)"
fi

# Anchored to the start of the line so nothing in the comments or caveats can be
# rewritten by accident.
tmp="$(mktemp)"
sed -e "s|^  version \".*\"$|  version \"$VERSION\"|" \
    -e "s|^  sha256 \".*\"$|  sha256 \"$SHA\"|" \
    "$CASK" > "$tmp"
mv "$tmp" "$CASK"

grep -q "version \"$VERSION\"" "$CASK" || { echo "ERROR: version was not written" >&2; exit 1; }
grep -q "sha256 \"$SHA\"" "$CASK" || { echo "ERROR: sha256 was not written" >&2; exit 1; }

echo "cask updated: $VERSION"
echo "  sha256 $SHA"
