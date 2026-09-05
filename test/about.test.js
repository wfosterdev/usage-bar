import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { ABOUT } from '../src/core/about.js';

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

/* Attribution is spread across a licence, a manifest, a plist, a CLI banner and
   a settings panel. Nothing fails loudly when one drifts — it just quietly
   credits the wrong thing, or ships a version that disagrees with its filename. */

test('the version has exactly one source', async () => {
  const pkg = JSON.parse(await read('../package.json'));
  assert.equal(ABOUT.version, pkg.version, 'about.js disagrees with package.json');

  // build.sh derives both the plist version and the DMG filename from
  // package.json. A literal here would drift the moment npm version runs.
  const build = await read('../mac/build.sh');
  assert.match(build, /VERSION="\$\(node -p "require\('\$REPO\/package\.json'\)\.version"/,
    'build.sh should read the version from package.json');
  assert.ok(!/<string>\d+\.\d+\.\d+<\/string>/.test(build),
    'build.sh has a hardcoded version in the plist');
});

test('the author and homepage agree everywhere they appear', async () => {
  assert.equal(ABOUT.author, 'William Foster');
  assert.equal(ABOUT.homepage, 'https://wfoster.dev');

  const pkg = JSON.parse(await read('../package.json'));
  assert.ok(pkg.author.includes(ABOUT.author), 'package.json names someone else');
  assert.equal(pkg.homepage, ABOUT.homepage);
  assert.equal(pkg.license, ABOUT.licence);

  const licence = await read('../LICENSE');
  assert.match(licence, new RegExp(`Copyright \\(c\\) \\d{4} ${ABOUT.author}`),
    'LICENSE does not name the copyright holder');
  assert.ok(licence.includes(ABOUT.homepage), 'LICENSE does not carry the homepage');

  // The Swift app cannot import from src/core, so it restates these.
  const swift = await read('../mac/main.swift');
  assert.ok(swift.includes(`"${ABOUT.homepage}"`), 'main.swift has a different homepage');
  assert.ok(swift.includes(`"${ABOUT.author}"`), 'main.swift names someone else');

  const build = await read('../mac/build.sh');
  assert.ok(build.includes(ABOUT.author), 'the bundle copyright names someone else');
  assert.ok(build.includes(ABOUT.homepage), 'the bundle copyright omits the homepage');
});

test('every surface can say what it is and who made it', async () => {
  const cli = await read('../src/cli.js');
  assert.match(cli, /-v, --version/, 'the CLI does not document --version');
  assert.match(cli, /ABOUT\.homepage/, 'the CLI banner omits the homepage');

  const html = await read('../src/web/index.html');
  assert.match(html, /data-tab="about"/, 'the dashboard has no About panel');

  const app = await read('../src/web/app.js');
  assert.match(app, /\/api\/about/, 'the About panel is never populated');

  const swift = await read('../mac/main.swift');
  assert.match(swift, /openHomepage/, 'the menu has no way to reach the homepage');
});

test('the attribution is honest about what this is not', async () => {
  // Trading on Anthropic's name is the one claim that could actually mislead
  // someone, so every surface that shows a byline disclaims it.
  for (const rel of ['../README.md', '../src/cli.js', '../src/web/index.html']) {
    const text = await read(rel);
    assert.match(text, /[Nn]ot affiliated with or endorsed by Anthropic/,
      `${rel} shows attribution without the disclaimer`);
  }
});

/* A cask is published to a separate repository where nothing here can test it,
   so the checks that matter are the ones that keep it internally consistent with
   what the release actually produces. */

test('the cask matches what the release actually builds', async () => {
  const cask = await read('../Casks/usage-bar.rb');
  const pkg = JSON.parse(await read('../package.json'));

  const version = cask.match(/^  version "([^"]+)"$/m);
  assert.ok(version, 'the cask has no version line for the updater to rewrite');
  assert.ok(/^  sha256 "[0-9a-f]{64}"$/m.test(cask), 'the cask sha256 is not a plain digest');

  // build.sh names the DMG from package.json, and the cask interpolates its own
  // version into the download URL. If those two disagree the cask 404s.
  assert.match(cask, /UsageBar-#\{version\}\.dmg/,
    'the cask url should follow the DMG naming build.sh uses');
  assert.ok(cask.includes(`/download/v#{version}/`),
    'the download URL should be built from the tag, not hardcoded');

  assert.ok(cask.includes(`homepage "${ABOUT.homepage}"`), 'the cask homepage is wrong');
  assert.match(cask, /app "UsageBar\.app"/, 'the cask installs nothing');

  // Without this an upgrade replaces the files under a still-running app.
  assert.match(cask, /uninstall quit: "dev\.wfoster\.usagebar"/,
    'the cask should quit the app before replacing it');

  // The app fails outright without Node, so the requirement has to be stated
  // somewhere the installer will see it.
  assert.match(cask, /caveats/, 'the cask never mentions the Node requirement');
  assert.match(cask, /Node\.js 20/, 'the cask does not state which Node version');

  // Nothing here should drift from the plist's LSMinimumSystemVersion.
  const build = await read('../mac/build.sh');
  const minMacos = build.match(/MIN_MACOS="\$\{MIN_MACOS:-([\d.]+)\}"/);
  assert.ok(minMacos, 'build.sh no longer declares a minimum macOS');
  assert.equal(minMacos[1], '12.0', 'the cask says :monterey — update both together');
  assert.match(cask, /depends_on macos: ">= :monterey"/, 'the cask minimum does not match the bundle');

  assert.ok(!cask.includes(pkg.version) || version[1] === pkg.version,
    'the cask version disagrees with package.json');
});

test('the cask updater is wired into the release', async () => {
  const rel = await read('../mac/release.sh');

  assert.match(rel, /update-cask\.sh/, 'the release never refreshes the cask');
  // A cask pointing at a release asset that does not exist yet is a broken
  // install for anyone who runs brew in the gap.
  assert.ok(rel.indexOf('gh release create') < rel.indexOf('update-cask.sh'),
    'the cask must be updated after the release is published');
  // A missing tap should not fail a release that has already been published.
  assert.match(rel, /no tap at .* skipping|skipping/, 'a missing tap should be survivable');

  const script = await read('../scripts/update-cask.sh');
  // Publishing a cask whose URL does not resolve is worse than not publishing.
  assert.match(script, /ERROR: expected/, 'the updater does not check the DMG filename');
  assert.match(script, /require\('\$REPO\/package\.json'\)\.version/,
    'the updater should take the version from package.json');
  assert.match(script, /\^  version/, 'the sed should be anchored to the line start');
});
