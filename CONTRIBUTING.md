# Contributing

Thanks for looking. This is a small, dependency-free project and the bar for a
change is simply that it works and is covered.

## Getting set up

```bash
git clone <repo> && cd usage-bar
npm test            # no install step — there are no dependencies
node src/cli.js serve --open
```

Node 20+. The macOS app additionally needs Xcode Command Line Tools
(`xcode-select --install`).

## Tests

```bash
npm test            # everything, offline, ~1s
npm run test:live   # one request to the real usage endpoint
```

**The suite must not touch the network.** `test/helpers/fake-usage.js` provides a
fixture and `Store` takes injectable fetchers, so use `offlineDeps()`. Exactly one
test — `test/live.test.js` — calls the real endpoint, it is skipped unless
`USAGE_BAR_LIVE=1`, and it makes a single request. Add to that test rather than
writing a second live one: the usage endpoint publishes no rate limit and a test
suite that polls it will get the maintainer's account 429'd.

For UI work, `USAGE_BAR_FAKE_LIMITS=1 node src/cli.js serve` serves canned data
so iterating on layout costs no requests.

## Releasing

Maintainers only, and only needed to publish a build others will download.

Releases are cut from a Mac, not from CI — the Developer ID certificate stays in
the local keychain and is never a GitHub secret, so there is nothing in the repo
for a workflow to leak.

```bash
npm version minor
./mac/release.sh --dry-run   # build, sign, notarise, verify — publish nothing
./mac/release.sh
```

It needs a Developer ID Application certificate, notarisation credentials
(`NOTARY_PROFILE`, or `APPLE_ID` + `APPLE_APP_PASSWORD` + `APPLE_TEAM_ID`) and
`gh auth login`. It stops before publishing anything and asks.

The script refuses a dirty tree, a version already published, a failing suite,
and a DMG that came out un-notarised. That last one matters: a release nobody can
open without a Gatekeeper fight is worse than no release.

Afterwards it refreshes `Casks/usage-bar.rb` and pushes it to the tap, after the
GitHub release exists so `brew` never points at a missing asset. By hand:
`./scripts/update-cask.sh mac/build/UsageBar-<version>.dmg`.

Without a certificate, `./mac/dmg.sh` still produces an ad-hoc signed image and
says plainly that Gatekeeper will block it. That is the right build for testing
packaging changes; it is not something to hand to anyone else.

Never strip quarantine from a build you did not produce yourself, and do not
suggest it to users of a notarised release — they will not see the prompt, and
the advice is only ever a habit worth not forming.

## Things worth knowing before you change them

- **Severity colours are not themeable.** Green / amber / red are the
  load-bearing signal; themes restyle chrome and accent, never meaning.
- **Menu bar text colour is derived, never configured.** `readableInk()` measures
  both candidates against the plate and picks the winner, which is what makes
  "always readable" a guarantee. Tests assert 4.5:1 across every combination.
- **The Swift app is checked by `test/swift.test.js`,** which parses `main.swift`
  for undeclared types, unwired selectors and Decodable/payload drift. It is not
  a compiler, so build the app too — but it catches the whole class of "the
  server changed and the app silently stopped decoding".
- **`src/web/app.js` duplicates some maths from `src/core/themes.js`** because the
  browser cannot import from `src/core`. A test compares the two implementations
  across every theme and percentage; keep them in step.
- **`mac/build.sh` hands the signing identity to `mac/dmg.sh` through a file**
  (`mac/build/.sign-identity`), not the environment — `dmg.sh` runs `build.sh` as
  a child process, so a variable set there would not come back up, and the image
  would go out unsigned around a signed app.

## Style

Match the surrounding code. Comments explain *why*, not *what* — if a line looks
arbitrary, the comment should say what goes wrong without it.
