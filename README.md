# usage-bar

Live Claude usage and session monitor: official 5-hour and weekly limits from
Anthropic's usage endpoint, plus everything your local Claude Code transcripts
know about what is running right now.

Two surfaces over one core:

- **macOS menu bar** — a glance (session % left, busy indicator) and the active
  session list. Click a session to open it in the dashboard.
- **Web dashboard** — the drill-down: context fill, cost by model/skill/agent,
  subagent tree, last messages, compaction and error events, history charts.

Limit percentages come from Anthropic's own usage endpoint using the OAuth token
Claude Code already holds — no cookie scraping, no DevTools. Everything else is
read from the transcripts already on your disk.

```
usage-bar status
```
```
Claude Usage default_claude_max_20x
  Session (5h)           ████░░░░░░░░░░░░░░  21%  resets 4h3m
  Weekly (all models)    █░░░░░░░░░░░░░░░░░   4%  resets 2d

Active sessions 2 of 40 · $44.84 · $55.36/h
  ● Claude usage bar with session monitoring   opus-5    5.1M    $9.51
    usage/bar · ctx 14% · ▶ Bash
  ● main/api                                   opus-5   35.7M   $35.33
    main/api · l4/analytics-laneb2 · ctx 10% · 5 subagents · ▶ Agent
```

## Install

**Requires Node.js 20+** — the menu bar app runs a small local server. macOS 12+
for the app itself. No other dependencies, at build time or runtime.

### macOS app (recommended)

Download `UsageBar-<version>.dmg` from [Releases](../../releases), drag
**UsageBar.app** to Applications, and open it.

Release builds are signed with a Developer ID certificate and notarised by Apple,
so they open with no security prompt.

> **If you built it yourself** without a Developer ID certificate, the first open
> shows *"the developer cannot be verified"*. Right-click the app → **Open** →
> **Open**. The DMG's `READ ME FIRST.txt` says the same thing.
>
> Do not strip quarantine from a download you did not build. That flag is the
> only thing standing between you and an unverified binary.

The app has no Dock icon and no window — it is a menu bar item. It starts its own
backend, so it is the only thing you need to launch. The Node source is bundled
inside the app; there is nothing else to clone.

### From source

```bash
git clone <this repo> && cd usage-bar
node src/cli.js serve --open      # dashboard only
./mac/build.sh                    # and the menu bar app (needs Xcode CLT)
open mac/build/UsageBar.app
```

`npm link` optionally puts `usage-bar` on your PATH. To build a DMG yourself:

```bash
./mac/dmg.sh                      # -> mac/build/UsageBar-<version>.dmg
```

A build from `build.sh` points at your working copy, so edits to `src/` take
effect without rebuilding the app. `dmg.sh` builds in distribution mode instead:
it bakes no local paths and the app uses its bundled copy.

### Signing and notarisation

Neither is required to build or run locally — without a certificate `build.sh`
signs ad-hoc, which is fine on your own machine and blocked by Gatekeeper on
anyone else's.

With a paid Apple Developer account, `build.sh` finds a **Developer ID
Application** certificate automatically (`security find-identity -v -p
codesigning`; override with `SIGN_IDENTITY`) and signs with the Hardened Runtime
and a secure timestamp — both required for notarisation, and the timestamp cannot
be added to an existing signature.

`dmg.sh` then notarises if it has credentials. Store them once:

```bash
xcrun notarytool store-credentials usage-bar \
  --apple-id you@example.com --team-id TEAMID --password <app-specific-password>

NOTARY_PROFILE=usage-bar ./mac/dmg.sh
```

Or pass `APPLE_ID` + `APPLE_APP_PASSWORD` + `APPLE_TEAM_ID` directly. The password
must be an [app-specific password](https://support.apple.com/en-us/102654), never
your Apple ID password.

The app is notarised and stapled *before* it goes into the image, then the image
is signed and notarised too. Stapling matters: without its own ticket, the
installed app needs a network round trip to validate and fails closed offline.

`mac/entitlements.plist` is deliberately empty. The Hardened Runtime's
restrictions are all things this app does not do, and spawning `node` as a child
process needs no entitlement — library validation governs code loaded *into* the
process, not processes it starts.

### Cutting a release

Releases are built and published from a maintainer's Mac, not from CI. The
signing certificate stays in the local keychain and is never stored as a GitHub
secret, so no workflow — and nobody with write access to the repo — is in a
position to use it.

```bash
npm version minor          # or patch / major
./mac/release.sh --dry-run # build, sign, notarise, verify — publish nothing
./mac/release.sh           # the real thing, after a confirmation prompt
```

`release.sh` refuses to continue on a dirty working tree, if the tag already
exists on a different commit, if the version is already published, if there is no
Developer ID certificate or notarisation credentials, if the suite fails, or if
the finished DMG is not stapled. Then it tags, pushes, creates the GitHub release
with `gh`, uploads the DMG, and updates the Homebrew cask.

Publishing needs the [GitHub CLI](https://cli.github.com) signed in as you:

```bash
brew install gh && gh auth login
```

That is a credential on your machine, not in the repository — which is the whole
point of releasing this way.

CI still runs on every push (`.github/workflows/test.yml`): the suite on Linux,
and a Swift compile plus `--check` on macOS, because `test/swift.test.js` parses
`main.swift` but only a compiler proves it builds. That workflow needs no secrets
of any kind.

### The Homebrew cask

`Casks/usage-bar.rb` is the source of truth. After the release is published,
`release.sh` runs `scripts/update-cask.sh` to write the new version and the DMG's
sha256 into it, then pushes it to the tap repository — so `brew` never points at
an asset that does not exist yet.

The tap is an ordinary repository named `homebrew-tap` with a `Casks/` directory;
the `homebrew-` prefix is what lets `brew` resolve `wfosterdev/tap/usage-bar`.
Set `HOMEBREW_TAP_REPO` to use a different one. If the tap does not exist the
step is skipped and the release still stands.

To update the cask by hand:

```bash
./scripts/update-cask.sh mac/build/UsageBar-0.1.0.dmg
```

It refuses if the DMG's filename disagrees with `package.json`, because that
mismatch produces a cask whose download URL 404s.

Submitting to the official `homebrew-cask` instead of your own tap needs the
project to meet Homebrew's notability thresholds (roughly 75 stars, 30 forks, or
75 watchers), so the tap is the right route until then.

## Commands

| Command | What it does |
|---|---|
| `usage-bar serve` | Dashboard + live SSE stream on `http://127.0.0.1:4317` |
| `usage-bar status` | One-shot summary in the terminal |
| `usage-bar menubar` | Compact JSON — what the macOS app polls |
| `usage-bar json` | Full state as JSON |
| `usage-bar statusline` | Claude Code `statusLine` filter (reads stdin) |
| `usage-bar config` | Show the resolved configuration and where it came from |

Options: `--port`, `--host`, `--credentials <path>`, `--projects <dir>`,
`--interval` (transcript scan, default 3s), `--limits` (usage poll, default 180s,
minimum 30s — see [Polling](#polling-and-rate-limits)), `--thresholds 50,75,90,95`,
`--quiet-for <minutes>`, `--webhook <url>`, `--no-notify`, `--open`.

### Notifications

Desktop notifications are **on** by default at 50/75/90/95%, and both the switch
and the percentages are in Settings (or `--no-notify` / `--thresholds`).

Each threshold notifies once per limit per reset window, and three rules keep
that from becoming a stream: crossing several thresholds in one jump is a single
notification for the highest, limits that cross in the same poll are combined
into one, and a **quiet period** (15 minutes by default, `--quiet-for 0` to
disable) suppresses anything after that — except the highest threshold on your
list, which always gets through. Suppressed crossings are still shown on the
dashboard and still sent to the webhook; only the ping is rationed.

## Settings

Claude does not always keep its credentials and logs where you expect — a
sandbox, a container, a per-workspace `CLAUDE_CONFIG_DIR`, or macOS storing the
OAuth blob in the keychain rather than on disk. **Settings** (top right of the
dashboard, or `⌘,` from the menu bar) points usage-bar at the right places.

**Credentials** — five sources:

| Source | Use when |
|---|---|
| `auto` *(default)* | The standard location. On macOS it falls back to the keychain. |
| `file` | An explicit `.credentials.json` — a container, or a per-workspace `_claude-data/`. |
| `keychain` | macOS, where Claude Code keeps the OAuth blob in the login keychain. |
| `command` | Anything else: a command that prints the credentials JSON or a bare token. |
| `token` | Paste an access token directly. It will not be refreshed when it expires. |

**Session logs** — `auto` uses `<claude dir>/projects`; `dir` points somewhere
specific; **Additional directories** scans several at once. Roots are
deduplicated by resolved real path, so the same directory reached through a bind
mount and its target is never counted twice.

Both sections have a test button that resolves the source and makes a real call
before you commit to it, detected locations appear as one-click chips, and path
fields have a **Browse…** button that walks the filesystem on the machine running
the server.

Saving applies immediately — no restart. Repointing the log directories throws
away all derived state and re-reads from scratch, because every cost and total
depends on which transcripts were counted.

Settings are stored at `~/.config/usage-bar/config.json` (owner-only, since it
may hold a pasted token). CLI flags override the saved settings for one run
without rewriting them.

## Appearance

Settings is a tabbed sheet: **Credentials**, **Session logs**, **Appearance**,
**Menu bar**, **Polling & alerts**. Path fields have a **Browse…** button — a
browser cannot open a native chooser for a path on the machine running the
server (`webkitdirectory` returns a sandboxed name, never an absolute one), so
the server enumerates and the page renders it.

### Dashboard theme

Six palettes — **Ember**, **Slate**, **Forest**, **Teal**, **Violet**, **Mono** —
each with a light and a dark variant. Light/dark can follow the system or be
pinned; the header button cycles system → light → dark without opening settings.

Palettes are defined once in `src/core/themes.js` and served over `/api/themes`.
**Adding a theme is a one-file change and needs no Swift recompile** — the app
paints whatever hex values the server sends it.

**Severity colours are not themed.** Green / amber / red mean "fine", "getting
close" and "nearly rate limited" — the load-bearing signal in this UI, so a theme
restyles chrome and accent but never meaning. The suite enforces it, checking the
three stay mutually distinct and keep their conventional hues in every theme and
mode, and that body text clears WCAG AA (4.5:1) against both `bg` and `panel`.

### Menu bar plate

The menu bar is a hostile surface: its background is your wallpaper — translucent,
arbitrary, and repainted by macOS whenever the desktop changes. No fixed text
colour survives that, which is why the item can paint its own opaque plate and
make the only contrast that matters one we control.

| Plate | What you get |
|---|---|
| **None** *(default)* | Plain text in `NSColor.labelColor` — the one colour macOS guarantees is readable there |
| **Soft** | A quiet plate matching the system appearance |
| **Solid** | A saturated badge in your chosen colour |

Six plate colours, each defined separately for light and dark **system**
appearance (not the dashboard's setting — they are different surfaces). Optionally
the plate itself turns amber past 75% and red past 90%, which reads far louder
than a text tint.

**Text colour is never configured — it is derived.** `readableInk()` measures both
candidate inks against the actual plate and returns the winner, so readability is
a guarantee rather than an intention. A test walks every combination of theme ×
scheme × fill × appearance × severity and asserts ≥ 4.5:1.

The dropdown is themed separately. Unlike the menu bar, a menu has a predictable
near-opaque backing that follows the system appearance — that is what makes it
safe to colour at all, and the assumption is measured rather than assumed. It
keeps your scheme colour even when the bar itself is unplated: "no plate" exists
because the wallpaper is unpredictable, and that reason does not apply inside a
menu.

### Usage bars

Four styles — solid, segmented, dots, thin line — and four colour palettes:
severity (green → amber → red), gradient (a continuous ramp anchored to the same
75/90 thresholds), theme accent, greyscale. Applies to the dashboard gauges and
to the bars in the menu bar dropdown, which the server renders as text
(`██████░░░░`, `▰▰▰▰▰▰▱▱▱▱`, `●●●●●●○○○○`, `━━━━━━────`) so style and palette are
configurable without a rebuild.

### What the number means

By default the glance shows **% remaining** of the 5h session — `◐ 57% left` means
57% of the window is left. Under **Appearance → Show** you can switch to *% used*
(which matches what `/usage` reports in Claude Code), and change what it tracks
from *Session (5h) only* to *whichever limit is closest to biting*.

The setting flips the whole gauge on both surfaces, not just the number: "57%"
above a bar filled to 43% would read as a contradiction. Severity always follows
how much is **spent** either way — 5% remaining and 95% used are the same
emergency. Every percentage carries its unit, because a bare `57%` next to a
`43%` elsewhere is genuinely ambiguous.

## Polling and rate limits

The usage endpoint is undocumented internal infrastructure. It publishes no
quota: no `anthropic-ratelimit-*` headers, and an observed 429 came back with
`retry-after: 0`, which is no guidance at all. With nothing to aim at, the policy
is to ask rarely and make each request count.

| | Interval |
|---|---|
| While a session is running | 180s |
| Idle | 12 min (`limitsIntervalMs × idleLimitsFactor`) |
| Hard floor, any caller | 30s (5s for an explicit click) |
| Backoff cap after failures | 10 min |

That is roughly **200 requests a day**, against 1,440 for a naive 60s poll. Both
bounds are pinned by tests — too eager gets you rate limited, too lazy makes the
number wrong.

Idle being slow costs nothing, because the clock is not the only trigger:

- **A session going live takes a reading immediately.** Transcripts are scanned
  every 3s, so the moment work starts the number is refreshed.
- **A limit rolling over schedules its own re-read.** `resetsAt` is exact, so
  that is a scheduled event rather than a guess.

The idle interval therefore governs one thing only: how quickly usage incurred
*somewhere else* — another machine, the web app — shows up.

**When it does fail**, the last good reading is kept and labelled rather than
thrown away: *"Usage endpoint is rate limiting us. Retrying in 5m. Showing the
last reading from 14:32."* A calm notice, not a red alarm — the numbers under it
are real. `Retry-After` is honoured in both the seconds and HTTP-date forms, and
a longer one overrides our own backoff, because it is an instruction rather than
an estimate.

A backoff can outlive the outage that caused it, so **Try now** in the dashboard
and **Refresh Now** in the menu force an upstream re-poll. Both are floored at
5s, so repeated clicking cannot become a retry loop.

## Environment

| Variable | Effect |
|---|---|
| `CLAUDE_CONFIG_DIR` | Claude's directory when it is not `~/.claude` |
| `USAGE_BAR_CONFIG` | Use a different config file |
| `USAGE_BAR_ALLOW_COMMAND=1` | Permit the `command` credential source |
| `USAGE_BAR_FAKE_LIMITS=1` | Serve canned usage data — for UI work, so iterating on layout costs no requests |
| `USAGE_BAR_LIVE=1` | Let the one live test actually call the endpoint |
| `USAGE_BAR_DIST=1` | Build the macOS app in distribution mode (bundled CLI, no local paths baked in) |

## Two deliberate restrictions

The **`command` source is disabled by default**. It runs a shell command every
time usage is polled, and the settings page is reachable from your browser —
so it is opt-in via `USAGE_BAR_ALLOW_COMMAND=1` rather than something a stray
page could switch on. `keychain` covers the common macOS case without it.

**Mutating endpoints reject cross-origin requests.** The dashboard binds to
loopback, but any page in your browser can still POST to it; without this, a
hostile page could silently repoint your credential path. Browsers always send
`Origin` on a cross-origin POST, so mismatches are refused. Non-browser clients
(curl, the menu bar app) are unaffected.

## macOS menu bar app

```bash
./mac/build.sh          # needs Xcode Command Line Tools
open mac/build/UsageBar.app

./mac/dmg.sh            # or a distributable disk image
```

It launches `usage-bar serve` itself if nothing is already listening, so the app
is the only thing you need to start. It finds the CLI in this order — the first
that actually contains `src/cli.js` wins, and `--check` reports which:

1. a `defaults` override, if you set one
2. the working copy a development build points at (so edits need no rebuild)
3. **the copy bundled inside the app** — this is what a DMG install uses
4. a walk up from the bundle

```bash
defaults write dev.wfoster.usagebar UsageBarPort -int 4317
defaults write dev.wfoster.usagebar UsageBarRepoPath -string /path/to/usage-bar
```

To launch it at login: System Settings → General → Login Items → add `UsageBar.app`.

### If it says "backend not reachable"

The menu now tells you *why*, not just *that* — `node not found on PATH`, `No CLI
at <path>`, or the backend's own stderr — plus **Restart Backend** and **Reveal
Log in Finder**. Failing that, `./mac/doctor.sh` runs the CLI directly and prints
what it says.

The server binds its port **before** indexing, so it is reachable in about a
second and reports a `Starting...` state (`◐ ..` in the menu bar) while the first
scan runs. Doing it the other way round meant the port stayed shut for as long as
startup took - and on macOS the first credential read can sit behind a keychain
prompt, which looks exactly like a dead server.

### If the menu bar shows nothing

The app is `LSUIElement`: no Dock icon, no window, nothing but a menu bar item.
So "no UI" and "crashed at launch" look identical. Run the doctor:

```bash
./mac/doctor.sh
```

It checks the bundle, the **code signature**, quarantine, whether the process is
alive, the `UsageBarPort` / `UsageBarRepoPath` defaults, whether `node` is on the
*login shell's* PATH (which is how the app looks it up), whether the backend is
answering, and prints the tail of the log.

The signature is the one worth understanding: **macOS refuses to execute an
unsigned arm64 binary and kills it at launch with no dialog** — which, for a
menu-bar-only app, presents exactly as "the app has no UI". `build.sh` now fails
loudly if signing does not succeed and verify, rather than carrying on.

Two more things to reach for:

```bash
tail -f ~/Library/Logs/UsageBar.log                  # the app logs here
mac/build/UsageBar.app/Contents/MacOS/UsageBar       # run in the foreground
```

The menu bar item is `◐ 57% left` normally, `◉` while a session is working, a
spinning `◐ ◓ ◑ ◒` during startup, and `◐ !` when usage is unavailable. Startup is
a state, not a failure: the app spawns node, binds a port, reads credentials and
indexes the archive before it can say anything true, and reporting that window as
"not reachable" was both alarming and wrong. It is bounded — only the server's own
"Starting…" spins, and only for 90s — so a backend that can never become ready
shows its actual reason instead of a spinner forever.

## Claude Code statusline

Add to `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "node /path/to/usage-bar/src/cli.js statusline" } }
```

## Where the data comes from

**Limits** — `GET https://api.anthropic.com/api/oauth/usage`, authenticated with
the OAuth token Claude Code already holds. These percentages are Anthropic's own
and are what actually gates you. No cookie scraping, no DevTools. Where that
token lives is configurable — see [Settings](#settings).

The credentials file is read **read-only**; usage-bar never refreshes the token
itself. Claude Code rotates it and rewrites the file, and a refresh issued from
here could rotate the refresh token out from under the CLI. The file is re-read
on every poll, so a refresh is picked up immediately. If the token has genuinely
expired, usage-bar says so and keeps working on local data alone.

The response is read via its generic `limits[]` array rather than the flat
top-level keys, so new limit types appear automatically and nothing unreleased
gets rendered.

**Sessions** — `<claude dir>/projects/**/*.jsonl`, tailed incrementally, from one
or more directories you choose in [Settings](#settings). The first
pass reads the whole archive (~500ms for 27k lines) to build history; after that
each poll reads only appended bytes (~13ms). Subagent transcripts under
`<session>/subagents/` roll up into their parent session while keeping their own
per-agent cost and context.

## Privacy

Everything runs locally. Specifically:

- The dashboard binds to **`127.0.0.1`** and is not reachable from your network.
- The **only** outbound requests are to `api.anthropic.com` — the usage and
  profile endpoints — authenticated with the token Claude Code already stores.
- **No telemetry, no analytics, no crash reporting.** There is no server to send
  anything to.
- Transcripts are read from disk and never leave the machine. Message text
  appears only in your own browser, from your own local server.
- The credentials file is opened **read-only**. usage-bar never writes it and
  never refreshes the token.
- The one thing written outside its own directory is
  `~/.config/usage-bar/config.json` (owner-only permissions, since it may hold a
  pasted token), plus `~/Library/Logs/UsageBar.log` on macOS.

If you configure a **webhook**, threshold alerts are POSTed to the URL you give
it. That is the only way data leaves the machine, and it is off unless you set it.

## About the dollar figures

They are **equivalent API cost**: what the traffic would cost at published
per-MTok rates, including the cache multipliers (5-minute writes at 1.25×
input, 1-hour writes at 2×, reads at 0.1×).

**On a Pro or Max subscription you are not billed these amounts.** They are a
common unit for comparing sessions, models, skills and agents against each
other — "this L4 run cost 4× that one" is the useful signal, not the dollar
value. Limit percentages, by contrast, are authoritative.

Rates are in `src/core/pricing.js`; update that table when pricing changes.

## What it surfaces that the raw transcripts do not

- **Context fill** — tokens on the model's most recent request against that
  model's window, per session *and* per subagent.
- **Compaction cost** — trigger, before → after, tokens dropped, seconds spent.
  An auto-compaction dropping 351K tokens is visible spend.
- **Time to limit** — the projector samples the official percentage over a
  45-minute window and fits a slope, then compares exhaustion against the reset
  time. It reports "resets before exhausting" when you are fine. Slope is fitted
  from server-reported percentages, not local tokens, so it accounts for traffic
  this machine never saw.
- **Cache efficiency** — hit ratio and the spend the cache avoided.
- **Attribution** — cost by `attributionSkill` and `attributionAgent`, so you
  can see what a given skill actually costs across a run.
- **Friction** — API errors with status, tool denials, queued prompts.

## Tests

```bash
npm test            # everything, offline, no dependencies
npm run test:live   # one request to the real usage endpoint
```

**The suite does not touch the network.** `test/helpers/fake-usage.js` holds a
fixture copied from a real response, and `Store` takes injectable fetchers.
Exactly one test calls the real endpoint, it is skipped unless `USAGE_BAR_LIVE=1`,
and it makes a single request — enough to catch schema drift, which a fixture
never can, without a test run spending an account's rate limit budget.

`test/swift.test.js` stands in for a Swift compiler on non-macOS machines: it
parses `main.swift` for undeclared types, `@objc` selectors wired in only one
direction, and drift between the `Decodable` structs and what `/api/menubar`
actually sends. It is not a substitute for building the app, but it catches the
whole class of "the server changed and the app silently stopped decoding".

## Layout

```
src/core/     config, themes, pricing, credentials, limits client, transcript
              tailer, session aggregation, history, projection, notifications, store
src/server/   HTTP + SSE, config API, /api/menubar projection for the Mac app
src/web/      dashboard (vanilla, no build step)
mac/          AppKit menu bar app, build.sh, dmg.sh, notarize.sh, release.sh, doctor.sh
test/         node:test suite + offline usage fixture
Casks/        Homebrew cask, copied to the tap on release
scripts/      update-cask.sh
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: no dependencies, no
build step, `npm test` must stay offline, and severity colours stay green / amber
/ red in every theme.

## Licence

[MIT](LICENSE) &copy; 2026 [William Foster](https://wfoster.dev).

Not affiliated with or endorsed by Anthropic. "Claude" is Anthropic's trademark;
this is an independent tool that reads data Claude Code already stores on your own
machine.
