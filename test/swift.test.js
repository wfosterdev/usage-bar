import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/core/store.js';
import { menubarView } from '../src/server/index.js';
import { DEFAULTS } from '../src/core/config.js';
import { offlineDeps } from './helpers/fake-usage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SWIFT = await readFile(join(ROOT, 'mac', 'main.swift'), 'utf8');

/**
 * Comments and string literals must not be scanned for code references: a doc
 * comment mentioning `UsageBar.log` is not a use of a type called UsageBar.
 */
const CODE = SWIFT
  .replace(/\/\*[\s\S]*?\*\//g, ' ')      // block comments
  .replace(/\/\/[^\n]*/g, ' ')             // line comments
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');  // string literals

/**
 * The Swift app cannot be compiled in this environment, so these tests stand in
 * for the compiler on the two things that actually broke in practice:
 * a type referenced but never declared, and a Decodable that disagrees with the
 * JSON the server sends.
 */

/** Types provided by Foundation / AppKit / the Swift stdlib. */
const SDK_TYPES = new Set([
  'NSColor', 'NSFont', 'NSApp', 'NSApplication', 'NSAttributedString', 'NSMutableAttributedString',
  'NSMenu', 'NSMenuItem', 'NSStatusBar', 'NSStatusItem', 'NSWorkspace', 'NSRange', 'NSString',
  'NSObject', 'NSNotification', 'NSObjectProtocol', 'Notification', 'DistributedNotificationCenter',
  'FileManager', 'FileHandle', 'URL', 'URLSession', 'URLSessionConfiguration', 'URLRequest',
  'JSONDecoder', 'JSONEncoder', 'Data', 'Date', 'ISO8601DateFormatter', 'Process', 'Pipe',
  'ProcessInfo', 'DispatchQueue', 'Timer', 'RunLoop', 'Bundle', 'UserDefaults', 'Result',
  'String', 'Int', 'Double', 'Bool', 'CGFloat', 'UInt32', 'Set', 'Array', 'Dictionary', 'Error',
  'NSError', 'NSLog', 'NSLocalizedDescriptionKey', 'NSScreen', 'NSImage', 'DispatchSemaphore',
  'CommandLine',
]);

function declaredTypes(src) {
  const out = new Set();
  const re = /^\s*(?:public\s+|private\s+|final\s+)*(enum|struct|class|extension|protocol)\s+([A-Z][A-Za-z0-9_]*)/gm;
  let m;
  while ((m = re.exec(src))) out.add(m[2]);
  return out;
}

test('every type used for static member access is actually declared', () => {
  const declared = declaredTypes(SWIFT);
  const used = new Map();
  // `Foo.bar` where Foo is capitalised — the exact shape that broke.
  const re = /(?<![.\w])([A-Z][A-Za-z0-9_]*)\.[a-z][A-Za-z0-9_]*/g;
  let m;
  while ((m = re.exec(CODE))) {
    const name = m[1];
    if (declared.has(name) || SDK_TYPES.has(name)) continue;
    const line = CODE.slice(0, m.index).split('\n').length;
    if (!used.has(name)) used.set(name, line);
  }
  assert.deepEqual(
    [...used.entries()],
    [],
    `referenced but not declared (add to SDK_TYPES if it is an Apple type): ${
      [...used.entries()].map(([n, l]) => `${n} at main.swift:${l}`).join(', ')}`,
  );
});

test('the Log helper the app depends on for diagnostics exists', () => {
  // It has no UI, so losing this is losing all visibility into failures.
  assert.match(SWIFT, /^enum Log \{/m);
  assert.match(SWIFT, /static func write\(/);
  assert.match(SWIFT, /static let url: URL/);
});

test('every @objc selector target is defined', () => {
  // A dotted selector names another type's method (NSApplication.terminate),
  // which is not ours to declare; only bare selectors must resolve here.
  const selectors = [...CODE.matchAll(/#selector\(([A-Za-z0-9_.]+)/g)]
    .map((m) => m[1])
    .filter((sel) => !sel.includes('.'));
  const defined = new Set([...CODE.matchAll(/@objc\s+(?:private\s+)?func\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  const missing = selectors.filter((sel) => !defined.has(sel));
  assert.deepEqual(missing, [], `#selector targets with no @objc func: ${missing.join(', ')}`);
});

test('every @objc handler is actually wired to a selector', () => {
  // The reverse of the check above. An @objc func with no #selector is dead
  // code, and in practice means a menu item edit silently failed to apply.
  const defined = [...CODE.matchAll(/@objc\s+(?:private\s+)?func\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  const referenced = new Set([...CODE.matchAll(/#selector\(([A-Za-z0-9_.]+)/g)].map((m) => m[1]));
  const orphaned = defined.filter((f) => !referenced.has(f));
  assert.deepEqual(orphaned, [], `@objc funcs never referenced by a #selector: ${orphaned.join(', ')}`);
});

/* ---------- Decodable contract against the real payload ---------- */

/** Parses `let name: Type` / `let name: Type?` out of a Swift struct body. */
function structFields(src, name) {
  const start = src.indexOf(`struct ${name}: Decodable {`);
  if (start === -1) return null;
  const body = src.slice(start, src.indexOf('\n}', start));
  return [...body.matchAll(/let\s+([A-Za-z0-9_]+):\s*([^\n/]+)/g)].map((m) => ({
    name: m[1],
    optional: m[2].trim().endsWith('?'),
  }));
}

function assertDecodes(structName, obj) {
  const fields = structFields(SWIFT, structName);
  assert.ok(fields?.length, `no Decodable struct ${structName} found in main.swift`);
  for (const f of fields) {
    if (f.optional) continue;
    assert.ok(
      Object.prototype.hasOwnProperty.call(obj, f.name),
      `${structName}.${f.name} is non-optional in Swift but missing from the payload — decoding would fail at runtime`,
    );
    assert.notEqual(obj[f.name], null, `${structName}.${f.name} is non-optional in Swift but null in the payload`);
  }
}

test('the Swift Decodables match what /api/menubar actually sends', async () => {
  const store = new Store({ ...DEFAULTS, notify: false }, offlineDeps());
  await store.scan({ full: true });
  await store.refreshLimits();
  const payload = menubarView(store);

  assertDecodes('MenubarState', payload);
  assertDecodes('Glance', payload.glance);
  assertDecodes('Totals', payload.totals);
  if (payload.theme) {
    assertDecodes('ThemeInfo', payload.theme);
    assertDecodes('MenubarColors', payload.theme.dark);
  }
  if (payload.session) assertDecodes('LimitView', payload.session);
  for (const w of payload.weekly) assertDecodes('LimitView', w);
  for (const s of payload.activeSessions) assertDecodes('ActiveSession', s);
});

test('the payload carries no key the Swift side silently drops', async () => {
  // Not a failure, but a drift signal: a field added server-side and never
  // consumed means the two halves are diverging.
  const store = new Store({ ...DEFAULTS, notify: false }, offlineDeps());
  await store.refreshLimits();
  const payload = menubarView(store);
  const swiftFields = new Set((structFields(SWIFT, 'MenubarState') || []).map((f) => f.name));
  // Keys the menu bar deliberately does not render.
  const INTENTIONALLY_UNUSED = new Set(['costBasis']);
  const unused = Object.keys(payload).filter((k) => !swiftFields.has(k) && !INTENTIONALLY_UNUSED.has(k));
  assert.deepEqual(unused, [], `menubar payload keys not decoded by Swift: ${unused.join(', ')}`);
});

// The generated Info.plist is the app's identity. When it is malformed,
// LaunchServices declines the bundle without a word: `open` appears to do
// nothing, and UserDefaults has no domain to key off — which reads as a menu
// bar bug and a network bug rather than as a build bug. Check it structurally.
test('mac/build.sh generates a well-formed Info.plist', () => {
  const build = readFileSync(new URL('../mac/build.sh', import.meta.url), 'utf8');
  const m = build.match(/cat > "\$APP\/Contents\/Info\.plist" <<PLIST\n([\s\S]*?)\nPLIST\n/);
  assert.ok(m, 'could not find the Info.plist heredoc in build.sh');

  // $REPO_KEY is a whole conditional line, so render both branches: a
  // development build bakes the working-copy path, a distribution build must
  // not. Only checking one of them would let the other ship malformed.
  const variants = {
    development: '  <key>UsageBarRepoPath</key><string>/some/repo</string>',
    distribution: '',
  };
  for (const [mode, repoKey] of Object.entries(variants)) {
    const xml = m[1]
      .replace(/\$REPO_KEY/g, repoKey)
      .replace(/\$\{?[A-Z_]+\}?/g, 'x')
      .replace(/<!--[\s\S]*?-->/g, '');
    assertPlistWellFormed(xml, mode);
    if (mode === 'distribution') {
      assert.ok(!xml.includes('UsageBarRepoPath'),
        'a distribution build must not bake a local path into the plist');
    }
  }
});

/* A plist that does not parse is silently ignored by LaunchServices, which is
   how the app once shipped with a working signature and no menu bar icon. */
function assertPlistBalanced(xml, mode) {
  const stack = [];
  for (const [, close, name, selfClose] of xml.matchAll(/<(\/?)([a-zA-Z][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (name.startsWith('?') || name === '!DOCTYPE' || selfClose) continue;
    if (close) {
      assert.equal(stack.pop(), name, `${mode}: </${name}> does not close the open element`);
    } else {
      stack.push(name);
    }
  }
  assert.deepEqual(stack, [], `${mode} plist has unclosed elements: ${stack.join(', ')}`);
}

function assertPlistWellFormed(xml, mode) {
  assertPlistBalanced(xml, mode);

  for (const key of ['CFBundleIdentifier', 'CFBundleExecutable', 'LSUIElement']) {
    assert.ok(xml.includes(`<key>${key}</key>`), `${mode} Info.plist is missing ${key}`);
  }
}

test('the app bundles its own copy of the CLI', async () => {
  // An app dragged out of a DMG has no repo to shell into. Without the bundled
  // copy it launches, finds no src/cli.js, and reports "backend not reachable"
  // — which looks like a network fault rather than a packaging one.
  const build = await readFile(new URL('../mac/build.sh', import.meta.url), 'utf8');
  assert.match(build, /Contents\/Resources\/usage-bar/, 'build.sh does not stage the CLI');
  assert.match(build, /cp -R "\$REPO\/src"/, 'build.sh does not copy src/');
  assert.match(build, /cp "\$REPO\/package\.json"/, 'build.sh does not copy package.json');

  const swift = await readFile(new URL('../mac/main.swift', import.meta.url), 'utf8');
  assert.match(swift, /resourcePath/, 'the app never looks inside its own bundle for the CLI');
  assert.match(swift, /bundled in the app/, 'the bundled path is not reported as an origin');

  // A distribution build must not ship the maintainer's home directory.
  assert.match(build, /USAGE_BAR_DIST/, 'no way to build without baking a local path');
});

/* The chip is the whole readability guarantee: the server measures the ink
   against the plate, and Swift paints exactly what it is told. If these two
   drift, the app silently goes back to guessing a text colour. */
test('the menu bar chip contract survives the round trip to Swift', async () => {
  const { Store } = await import('../src/core/store.js');
  const { DEFAULTS } = await import('../src/core/config.js');
  const { contrastRatio } = await import('../src/core/themes.js');

  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  cfg.appearance.menubar = { scheme: 'violet', fill: 'solid', severity: true };
  cfg.appearance.gauge = { style: 'dots', palette: 'gradient' };
  const store = new Store(cfg, offlineDeps());
  await store.refreshLimits();
  const payload = menubarView(store);

  // The dropdown is themed off a different block than the bar; both must decode.
  for (const key of ['menuLight', 'menuDark']) {
    assertDecodes('MenuColors', payload.theme[key]);
  }

  for (const mode of ['light', 'dark']) {
    const colors = payload.theme[mode];
    assertDecodes('MenubarColors', colors);
    for (const key of ['normal', 'warning', 'critical']) {
      assertDecodes('Chip', colors[key]);
      const { background, text } = colors[key];
      assert.ok(background && text, `${mode}.${key}: a solid fill must produce a plate`);
      assert.ok(contrastRatio(text, background) >= 4.5,
        `${mode}.${key}: the server sent ink Swift would paint unreadably`);
    }
  }

  // Limit rows carry their own bar and colour, so the glyph style and palette
  // are configurable without recompiling the app.
  for (const limit of [payload.session, ...payload.weekly].filter(Boolean)) {
    assert.equal(typeof limit.bar, 'string');
    assert.ok(limit.bar.length > 0, `${limit.label} has no bar`);
    assert.ok(/^[●○]+$/u.test(limit.bar), `${limit.label} ignored the dots style: ${limit.bar}`);
    assertDecodes('ModeColor', limit.color);
  }
});

/* The DMG is how most people will get this, so its script is worth checking for
   the things that silently produce a broken download. */
test('the DMG script produces something installable', async () => {
  const dmg = await readFile(new URL('../mac/dmg.sh', import.meta.url), 'utf8');

  assert.match(dmg, /USAGE_BAR_DIST=1/, 'the DMG must be built in distribution mode');
  assert.match(dmg, /ln -s \/Applications/, 'no drag-to-Applications target');
  assert.match(dmg, /hdiutil create/, 'nothing actually builds an image');
  assert.match(dmg, /-format UDZO/, 'the image should be compressed');

  assert.match(dmg, /READ ME FIRST/, 'no note in the mounted volume');
  assert.match(dmg, /node/i, 'the Node requirement is not stated');

  // The note has two branches. The un-notarised one has to explain the
  // Gatekeeper block, because otherwise the download simply looks broken; the
  // notarised one must not, because that prompt never appears and telling people
  // to strip quarantine from a signed app is bad advice.
  const notes = dmg.split(/<<'NOTE'/).slice(1).map((chunk) => chunk.split('\nNOTE')[0]);
  assert.equal(notes.length, 2, 'expected a notarised and an un-notarised note');
  const withWorkaround = notes.filter((n) => /quarantine/i.test(n));
  assert.equal(withWorkaround.length, 1, 'exactly one note should mention quarantine');
  assert.match(withWorkaround[0], /cannot be verified/i,
    'the un-notarised note should quote the message users actually see');

  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /cannot be verified/i, 'the README does not warn about Gatekeeper');
  assert.match(readme, /Node\.js 20\+/, 'the README does not state the Node requirement');
});

/* Signing is easy to get subtly wrong in ways that only surface once someone
   else downloads the result, which is far too late to find out. */
test('the build signs in a way notarisation will accept', async () => {
  const build = await readFile(new URL('../mac/build.sh', import.meta.url), 'utf8');

  // Notarisation rejects a bundle without the Hardened Runtime, and a secure
  // timestamp cannot be added after the fact — a re-sign is the only fix.
  assert.match(build, /--options runtime/, 'the Hardened Runtime is not enabled');
  assert.match(build, /--timestamp/, 'no secure timestamp; notarisation will reject it');
  assert.match(build, /--entitlements/, 'the entitlements file is not applied');

  // dmg.sh runs build.sh as a child process, so the identity has to reach it
  // through the filesystem or the disk image goes out unsigned.
  assert.match(build, /\.sign-identity/, 'the signing identity is not recorded for dmg.sh');
  assert.match(build, /\.signed-for-distribution/, 'nothing records how the app was signed');

  const dmg = await readFile(new URL('../mac/dmg.sh', import.meta.url), 'utf8');
  assert.match(dmg, /\.sign-identity/, 'dmg.sh does not pick the identity back up');

  // A plain zip mangles the bundle's symlinks and notarisation then rejects it.
  assert.match(dmg, /ditto -c -k --keepParent/, 'the app must be zipped with ditto');
  // Without its own stapled ticket the installed app needs a network round trip
  // to validate, and fails closed offline.
  assert.match(dmg, /stapler staple "\$APP"/, 'the app itself is never stapled');
});

test('entitlements are present and deliberately minimal', async () => {
  const ents = await readFile(new URL('../mac/entitlements.plist', import.meta.url), 'utf8');
  assertPlistBalanced(ents, 'entitlements');

  // Every Hardened Runtime exception is an attack surface we would be opting
  // into. This app spawns node as a child process, which needs none of them.
  for (const risky of [
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
    'com.apple.security.cs.allow-dyld-environment-variables',
  ]) {
    assert.ok(!ents.includes(risky), `entitlements should not grant ${risky}`);
  }
});

/* Releases are cut from a maintainer's machine, deliberately: the signing
   certificate never goes into GitHub, so no workflow — and nobody with write
   access — can reach it. What that buys in safety it costs in ceremony, and the
   ceremony is what these checks protect. */
test('the release script refuses to publish a broken download', async () => {
  const rel = await readFile(new URL('../mac/release.sh', import.meta.url), 'utf8');

  // A release built from a dirty tree cannot be reproduced from its own tag, and
  // nothing about the artefact reveals the difference.
  assert.match(rel, /git status --porcelain/, 'a dirty working tree is not caught');
  assert.match(rel, /npm test/, 'a release should not skip the suite');

  // The checks that answer "would this actually install?".
  assert.match(rel, /stapler validate/, 'the ticket is never validated');
  assert.match(rel, /spctl -a -vvv -t install/, 'Gatekeeper acceptance is never checked');
  assert.match(rel, /refusing to publish a download that Gatekeeper blocks/,
    'an un-notarised DMG should not be publishable by accident');

  // Publishing is public and cannot be quietly undone.
  assert.match(rel, /Publish\? \[y\/N\]/, 'there is no confirmation before publishing');
  assert.match(rel, /--dry-run/, 'there is no way to rehearse a release');

  assert.match(rel, /gh release create/, 'nothing actually publishes the release');
  assert.match(rel, /--verify-tag/, 'gh should refuse a tag that was never pushed');
});

test('no workflow is in a position to leak the certificate', async () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const files = await readdir(dir);

  for (const name of files) {
    const wf = await readFile(new URL(name, dir), 'utf8');

    // The whole point of releasing locally: there is no signing material in CI
    // to steal, so a workflow that starts asking for some is a regression.
    for (const secret of ['MACOS_CERTIFICATE', 'APPLE_APP_PASSWORD', 'APPLE_ID', 'APPLE_TEAM_ID']) {
      assert.ok(!wf.includes(secret), `${name} references ${secret} — signing belongs on a local machine`);
    }
    assert.ok(!/create-keychain|security import/.test(wf),
      `${name} imports a certificate; releases are cut locally`);

    // Comments may name the variable; only an actual assignment opts in.
    const code = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.ok(!/USAGE_BAR_LIVE/.test(code), `${name} must not opt in to the live endpoint`);
  }
});
