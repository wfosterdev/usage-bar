#!/usr/bin/env bash
# Cuts a release from this machine.
#
#   ./mac/release.sh                 # release the version in package.json
#   ./mac/release.sh --dry-run       # build and verify, publish nothing
#   ./mac/release.sh --yes           # skip the confirmation prompt
#
# Signing and notarisation credentials stay here. Nothing about them is ever
# stored in GitHub, so no workflow — and nobody with write access to the repo —
# can reach the certificate.
#
# Publishing needs the GitHub CLI, authenticated as you:
#   brew install gh && gh auth login
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
cd "$REPO"

DRY=0
ASSUME_YES=0
ALLOW_UNNOTARISED=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    # Publishes a build that Gatekeeper will block. Only ever for testing the
    # release plumbing itself.
    --allow-unnotarised) ALLOW_UNNOTARISED=1 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- preflight

step "Checking the machine"

[ "$(uname -s)" = "Darwin" ] || die "the DMG can only be built on macOS"
command -v node >/dev/null || die "node not found"
command -v xcrun >/dev/null || die "Xcode Command Line Tools not installed (xcode-select --install)"

if [ "$DRY" = "0" ]; then
  command -v gh >/dev/null || die "the GitHub CLI is not installed (brew install gh)"
  gh auth status >/dev/null 2>&1 || die "not signed in to GitHub (gh auth login)"
fi

git rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository"

# A release built from a dirty tree cannot be reproduced from the tag, and the
# difference is invisible in the artefact.
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "working tree is not clean — commit or stash first"
fi

VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  # An existing tag must point at what is about to be built, or the release
  # would carry a binary that does not match its own source.
  if [ "$(git rev-parse "$TAG^{commit}")" != "$(git rev-parse HEAD)" ]; then
    die "$TAG exists but points at a different commit — bump the version first"
  fi
  TAG_EXISTS=1
else
  TAG_EXISTS=0
fi

if [ "$DRY" = "0" ] && gh release view "$TAG" >/dev/null 2>&1; then
  die "$TAG is already published — run 'npm version patch' first"
fi

echo "  version   $VERSION  ($TAG)"
echo "  branch    $BRANCH"
echo "  commit    $(git rev-parse --short HEAD)"

# ---------------------------------------------------------------- credentials

step "Checking signing credentials"

IDENTITY="${SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null \
  | awk -F'"' '/Developer ID Application/ {print $2; exit}')}"
[ -n "$IDENTITY" ] || die "no Developer ID Application certificate in the keychain"
echo "  identity  $IDENTITY"

if [ -n "${NOTARY_PROFILE:-}" ]; then
  echo "  notary    keychain profile '$NOTARY_PROFILE'"
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  echo "  notary    $APPLE_ID (team $APPLE_TEAM_ID)"
elif [ "$ALLOW_UNNOTARISED" = "1" ]; then
  echo "  notary    NONE — --allow-unnotarised was passed"
else
  die "no notarisation credentials. Set NOTARY_PROFILE (see mac/notarize.sh),
       or APPLE_ID + APPLE_APP_PASSWORD + APPLE_TEAM_ID."
fi

# ---------------------------------------------------------------- build

step "Running the test suite"
npm test

step "Building, signing and notarising"
SIGN_IDENTITY="$IDENTITY" "$HERE/dmg.sh"

DMG="$HERE/build/UsageBar-$VERSION.dmg"
[ -f "$DMG" ] || die "expected $DMG but it was not built"

# ---------------------------------------------------------------- verify

step "Verifying the artefact a user would download"

hdiutil verify "$DMG" >/dev/null && echo "  image      ok"

NOTARISED=0
if xcrun stapler validate "$DMG" >/dev/null 2>&1; then
  NOTARISED=1
  echo "  ticket     stapled"
else
  echo "  ticket     NOT stapled"
fi

if spctl -a -vvv -t install "$DMG" 2>&1 | grep -q accepted; then
  echo "  gatekeeper accepted"
else
  echo "  gatekeeper rejected"
fi

if [ "$NOTARISED" = "0" ] && [ "$ALLOW_UNNOTARISED" = "0" ]; then
  die "the DMG is not notarised — refusing to publish a download that Gatekeeper blocks"
fi

if [ "$DRY" = "1" ]; then
  step "Dry run — nothing was published"
  echo "  $DMG"
  exit 0
fi

# ---------------------------------------------------------------- confirm

step "Ready to publish"
cat <<SUMMARY
  tag       $TAG $([ "$TAG_EXISTS" = "1" ] && echo "(exists)" || echo "(will be created)")
  remote    $(git remote get-url origin)
  asset     $(basename "$DMG") ($(du -h "$DMG" | cut -f1 | tr -d ' '))
  notarised $([ "$NOTARISED" = "1" ] && echo yes || echo "NO — Gatekeeper will block it")

This publishes a public release. It cannot be quietly undone.
SUMMARY

if [ "$ASSUME_YES" = "0" ]; then
  printf 'Publish? [y/N] '
  read -r reply
  case "$reply" in [yY]*) ;; *) echo "aborted"; exit 1 ;; esac
fi

# ---------------------------------------------------------------- publish

step "Publishing"

if [ "$TAG_EXISTS" = "0" ]; then
  git tag -a "$TAG" -m "usage-bar $VERSION"
fi
git push origin "$BRANCH"
git push origin "$TAG"

# Only advertise brew if the tap is actually there. Release notes telling people
# to run a command that fails are worse than notes that never mention it.
TAP_REPO="${HOMEBREW_TAP_REPO:-wfosterdev/homebrew-tap}"
# Written long-hand: `cmd && TAP_EXISTS=1` is exempt from set -e, but only by a
# rule the reader has to already know.
if gh repo view "$TAP_REPO" >/dev/null 2>&1; then
  TAP_EXISTS=1
else
  TAP_EXISTS=0
fi

NOTES="$(mktemp)"
cat > "$NOTES" <<NOTE
## Install

Download the DMG below, drag **UsageBar.app** to Applications, and open it.

Signed with a Developer ID certificate and notarised by Apple, so it opens with
no security prompt.

**Requires [Node.js](https://nodejs.org) 20+** — the app runs a small local
server — and macOS 12 or newer.

UsageBar has no Dock icon and no window; it lives in the menu bar. If nothing
appears, your menu bar may be full (common on notched displays). Diagnostics:

\`\`\`
/Applications/UsageBar.app/Contents/MacOS/UsageBar --check
\`\`\`
NOTE

if [ "$TAP_EXISTS" = "1" ]; then
  cat >> "$NOTES" <<NOTE

Or with Homebrew:

\`\`\`
brew install --cask ${TAP_REPO%%/*}/tap/usage-bar
\`\`\`
NOTE
fi

gh release create "$TAG" "$DMG" \
  --title "$TAG" \
  --notes-file "$NOTES" \
  --verify-tag
rm -f "$NOTES"

# ---------------------------------------------------------------- cask

step "Updating the Homebrew cask"

if [ "$TAP_EXISTS" = "1" ]; then
  "$REPO/scripts/update-cask.sh" "$DMG"

  TAP_DIR="$(mktemp -d)"
  gh repo clone "$TAP_REPO" "$TAP_DIR" -- --depth 1 >/dev/null
  mkdir -p "$TAP_DIR/Casks"
  cp "$REPO/Casks/usage-bar.rb" "$TAP_DIR/Casks/usage-bar.rb"

  (
    cd "$TAP_DIR"
    git add Casks/usage-bar.rb
    # --cached: a cask the tap has never seen is untracked, and a plain diff
    # would report it as no change.
    if git diff --cached --quiet; then
      echo "  cask already current"
    else
      git commit -q -m "usage-bar $TAG"
      git push -q
      echo "  pushed to $TAP_REPO"
    fi
  )
  rm -rf "$TAP_DIR"

  # The updated sha256 belongs in this repo's history too.
  if [ -n "$(git status --porcelain Casks/usage-bar.rb)" ]; then
    git add Casks/usage-bar.rb
    git commit -q -m "cask: usage-bar $VERSION"
    git push -q origin "$BRANCH"
    echo "  committed the new sha256"
  fi
else
  echo "  no tap at $TAP_REPO — skipping"
  echo "  (create it, or set HOMEBREW_TAP_REPO, then: scripts/update-cask.sh '$DMG')"
fi

step "Released $TAG"
gh release view "$TAG" --json url --jq .url
