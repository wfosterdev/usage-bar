#!/usr/bin/env bash
# Submits one artefact to Apple's notary service, waits, and staples the ticket.
#
#   ./mac/notarize.sh path/to/UsageBar.dmg
#
# Credentials, in order of preference:
#   NOTARY_PROFILE   a stored notarytool profile (best for a laptop, see below)
#   APPLE_ID + APPLE_APP_PASSWORD + APPLE_TEAM_ID   (best for CI)
#
# To store a profile once, so you never paste credentials again:
#   xcrun notarytool store-credentials usage-bar \
#     --apple-id you@example.com --team-id ABCDE12345 --password <app-specific>
#
# APPLE_APP_PASSWORD is an app-specific password from appleid.apple.com, NOT
# your Apple ID password. Notarisation rejects the latter.
set -euo pipefail

ARTEFACT="${1:-}"
[ -n "$ARTEFACT" ] || { echo "usage: notarize.sh <path to .dmg or .zip>" >&2; exit 2; }
[ -e "$ARTEFACT" ] || { echo "no such file: $ARTEFACT" >&2; exit 2; }

command -v xcrun >/dev/null || { echo "xcrun not found — needs Xcode CLT" >&2; exit 1; }

if [ -n "${NOTARY_PROFILE:-}" ]; then
  AUTH=(--keychain-profile "$NOTARY_PROFILE")
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  AUTH=(--apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID")
else
  echo "ERROR: no notarisation credentials." >&2
  echo "  Set NOTARY_PROFILE, or APPLE_ID + APPLE_APP_PASSWORD + APPLE_TEAM_ID." >&2
  echo "  See the comments at the top of this script." >&2
  exit 1
fi

echo "submitting $(basename "$ARTEFACT") to the notary service (this takes a few minutes)…"

# Capture the submission id even on failure: "Invalid" tells you nothing on its
# own, and the log is the only thing that says which rule was broken.
SUBMIT_LOG="$(mktemp)"
trap 'rm -f "$SUBMIT_LOG"' EXIT

if xcrun notarytool submit "$ARTEFACT" "${AUTH[@]}" --wait --output-format json > "$SUBMIT_LOG" 2>&1; then
  STATUS="$(node -p "JSON.parse(require('fs').readFileSync('$SUBMIT_LOG','utf8')).status" 2>/dev/null || echo unknown)"
else
  STATUS=failed
fi

SUBMISSION_ID="$(node -p "JSON.parse(require('fs').readFileSync('$SUBMIT_LOG','utf8')).id" 2>/dev/null || echo '')"

if [ "$STATUS" != "Accepted" ]; then
  echo "ERROR: notarisation returned '$STATUS'." >&2
  cat "$SUBMIT_LOG" >&2
  if [ -n "$SUBMISSION_ID" ]; then
    echo >&2
    echo "--- notary log for $SUBMISSION_ID ---" >&2
    xcrun notarytool log "$SUBMISSION_ID" "${AUTH[@]}" >&2 || true
  fi
  exit 1
fi

echo "notarised."

# A zip is only a transport: stapler refuses it ("incapable of working with ZIP
# archive files"), and there would be nothing to staple to anyway — the ticket
# belongs on the bundle inside, which the caller staples after unpacking.
case "$ARTEFACT" in
  *.zip)
    echo "zip archive — the caller staples the bundle inside it"
    exit 0
    ;;
esac

echo "stapling the ticket…"
# Stapling is what makes it validate OFFLINE. Without it the first launch on a
# machine with no network still shows a warning, which defeats the point.
xcrun stapler staple "$ARTEFACT"
xcrun stapler validate "$ARTEFACT"
echo "stapled: $ARTEFACT"
