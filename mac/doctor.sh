#!/usr/bin/env bash
# Diagnoses a UsageBar.app that shows nothing in the menu bar. Run on macOS.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
APP="$HERE/build/UsageBar.app"
BIN="$APP/Contents/MacOS/UsageBar"
PORT="$(defaults read dev.wfoster.usagebar UsageBarPort 2>/dev/null || echo 4317)"
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad(){ printf '  \033[31m✗\033[0m %s\n' "$1"; }
info(){ printf '    %s\n' "$1"; }

echo "UsageBar doctor"
echo
echo "Bundle"
[ -d "$APP" ] && ok "app exists: $APP" || { bad "no app at $APP — run ./mac/build.sh"; exit 1; }
[ -x "$BIN" ] && ok "binary is executable" || bad "binary missing or not executable"
info "arch: $(lipo -archs "$BIN" 2>/dev/null || file -b "$BIN")"

echo
echo "Signature  (unsigned arm64 binaries are killed at launch with no error)"
if codesign --verify --deep --strict "$APP" 2>/dev/null; then ok "signature verifies"
else bad "signature invalid — re-run ./mac/build.sh"; codesign --verify --deep --strict "$APP" 2>&1 | sed 's/^/    /'; fi
if xattr -p com.apple.quarantine "$APP" >/dev/null 2>&1; then
  bad "quarantined — fix with: xattr -dr com.apple.quarantine '$APP'"
else ok "not quarantined"; fi

echo
echo "Process"
if pgrep -x UsageBar >/dev/null; then ok "running (pid $(pgrep -x UsageBar | tr '\n' ' '))"
else bad "not running — start with: open '$APP'"; fi

echo
echo "Defaults"
info "UsageBarPort     = $PORT"
info "UsageBarRepoPath = $(defaults read dev.wfoster.usagebar UsageBarRepoPath 2>/dev/null || echo '(unset, falls back to bundle parent)')"
[ -f "$REPO/src/cli.js" ] && ok "CLI found at $REPO/src/cli.js" || bad "no CLI at $REPO/src/cli.js"

echo
echo "Node"
if N="$(command -v node)"; then ok "node on this shell's PATH: $N ($(node -v))"
else bad "node not on PATH"; fi
if L="$(zsh -lc 'command -v node' 2>/dev/null)" && [ -n "$L" ]; then ok "node on login-shell PATH: $L"
else bad "node NOT on the login-shell PATH — the app looks it up that way"; fi

echo
echo "Port $PORT"
if ! command -v lsof >/dev/null; then
  info "lsof not available; skipping the port check"
else
  LISTENERS="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2)"
  if [ -n "$LISTENERS" ]; then
    ok "something is listening"
    echo "$LISTENERS" | head -3 | sed 's/^/    /'
  else
    bad "nothing is listening on $PORT"
  fi
fi

echo
echo "Backend"
if curl -sf --max-time 5 "http://127.0.0.1:$PORT/api/menubar" -o /tmp/ub-doctor.json; then
  ok "responding"
  /usr/bin/python3 -c '
import json
d = json.load(open("/tmp/ub-doctor.json"))
g = d.get("glance", {})
if not d.get("ready"):
    print("    still starting - re-run in a few seconds")
else:
    print("    glance: {}% {}  ({}, severity {})".format(
        g.get("display"), g.get("suffix"), g.get("label"), g.get("severity")))
    print("    active sessions: {}".format(len(d.get("activeSessions", []))))
' 2>/dev/null || cat /tmp/ub-doctor.json
else
  bad "not responding"
  echo
  echo "  Running the CLI directly to see why:"
  if [ -f "$REPO/src/cli.js" ] && command -v node >/dev/null; then
    # `status` exercises the same credential and transcript resolution as
    # `serve`, without needing a free port.
    node "$REPO/src/cli.js" status 2>&1 | head -20 | sed 's/^/    /'
  else
    bad "cannot run the CLI (missing node or src/cli.js)"
  fi
fi

echo
echo "Log  (~/Library/Logs/UsageBar.log)"
if [ -f "$HOME/Library/Logs/UsageBar.log" ]; then tail -15 "$HOME/Library/Logs/UsageBar.log" | sed 's/^/    /'
else bad "no log yet — the app has not started, or was killed before running"; fi

echo
echo "Crash reports"
CRASHES=$(ls -t "$HOME/Library/Logs/DiagnosticReports"/UsageBar-*.ips 2>/dev/null | head -3)
if [ -n "$CRASHES" ]; then
  bad "the app has crashed — most recent reports:"
  echo "$CRASHES" | sed 's/^/    /'
  echo
  echo "  Top of the newest report:"
  # The first JSON line is metadata; the useful part is the termination reason
  # and the crashing thread, which sit a little further in.
  grep -m1 -A3 -E '"termination"|Termination Reason' "$(echo "$CRASHES" | head -1)" 2>/dev/null | sed 's/^/    /'
else
  ok "no crash reports"
fi

echo
echo "Self-check (runs the app's own diagnostics in the foreground)"
if [ -x "$BIN" ]; then "$BIN" --check 2>&1 | sed 's/^/    /'
else bad "no binary at $BIN — build it first with mac/build.sh"; fi

echo
echo "If the item still does not appear, launch it in the foreground and watch:"
echo "    '$BIN'"
echo "    tail -f ~/Library/Logs/UsageBar.log"
