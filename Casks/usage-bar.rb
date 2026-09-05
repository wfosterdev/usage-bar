# Homebrew cask for UsageBar.
#
# This file is the source of truth. `scripts/update-cask.sh` rewrites the version
# and sha256 lines from a built DMG, and the release workflow pushes the result to
# the tap repository — so the two lines below are expected to be edited by a
# machine, and everything else by a person.
#
#   brew install --cask wfosterdev/tap/usage-bar
cask "usage-bar" do
  version "0.1.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/wfosterdev/usage-bar/releases/download/v#{version}/UsageBar-#{version}.dmg"
  name "Claude Usage Bar"
  desc "Menu bar monitor for Claude usage limits and Claude Code sessions"
  homepage "https://wfoster.dev"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Matches LSMinimumSystemVersion in the bundle.
  depends_on macos: ">= :monterey"

  app "UsageBar.app"

  # The app has no Dock icon, so there is no obvious way to quit it before the
  # files go away. Without this, an upgrade leaves the old build running.
  uninstall quit: "dev.wfoster.usagebar"

  # Node is required but deliberately not declared as a formula dependency: the
  # app finds nvm, fnm and asdf installations as well as Homebrew's, and forcing
  # `brew install node` would give those users a second, unused copy.
  caveats <<~EOS
    UsageBar needs Node.js 20 or newer:

      node --version

    If you do not have it:  brew install node

    The app has no Dock icon and no window — it lives in the menu bar.
    Diagnostics:  /Applications/UsageBar.app/Contents/MacOS/UsageBar --check
  EOS

  zap trash: [
    "~/Library/Logs/UsageBar.log",
    "~/.config/usage-bar",
  ]
end
