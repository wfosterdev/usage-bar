import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

import { validate, withOverrides, resolveTranscriptDirs, DEFAULTS, CREDENTIAL_SOURCES } from '../src/core/config.js';
import { readCredentials, describeSource } from '../src/core/credentials.js';
import { discoverAll } from '../src/core/transcripts.js';

const creds = (over = {}) => JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-test', refreshToken: 'sk-ant-ort01-test',
    expiresAt: Date.now() + 3600_000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
    scopes: ['user:inference'], ...over,
  },
});

/* ---------- validation ---------- */

test('an empty patch yields the defaults', () => {
  const { config, errors } = validate({});
  assert.deepEqual(errors, []);
  assert.equal(config.credentials.source, 'auto');
  assert.equal(config.transcripts.source, 'auto');
});

test('an unknown credential source is rejected and falls back to auto', () => {
  const { config, errors } = validate({ credentials: { source: 'ftp' } });
  assert.equal(config.credentials.source, 'auto');
  assert.ok(errors.some((e) => e.includes('credentials.source')));
});

test('each source demands its own required field', () => {
  assert.ok(validate({ credentials: { source: 'file' } }).errors.some((e) => e.includes('credentials.path')));
  assert.ok(validate({ credentials: { source: 'token' } }).errors.some((e) => e.includes('credentials.token')));
  assert.ok(validate({ transcripts: { source: 'dir' } }).errors.some((e) => e.includes('transcripts.dir')));
});

test('the command source is refused unless explicitly enabled', () => {
  // USAGE_BAR_ALLOW_COMMAND is not set in the test environment.
  const { errors } = validate({ credentials: { source: 'command', command: 'echo hi' } });
  assert.ok(errors.some((e) => e.includes('USAGE_BAR_ALLOW_COMMAND')));
});

test('the usage poll interval has a floor so we do not hammer the endpoint', () => {
  const { config, errors } = validate({ limitsIntervalMs: 1000 });
  assert.equal(config.limitsIntervalMs, 30000);
  assert.ok(errors.some((e) => e.includes('30000')));
});

test('the default poll rate is conservative and backs off further when idle', () => {
  // A limit measured over five hours does not need a reading every minute, and
  // over-polling is exactly what got the endpoint to rate limit us.
  assert.ok(DEFAULTS.limitsIntervalMs >= 120000,
    `default poll is ${DEFAULTS.limitsIntervalMs}ms — too eager for a 5h window`);
  assert.ok(DEFAULTS.idleLimitsFactor > 1, 'idle must be slower than active');

  const { config, errors } = validate({ idleLimitsFactor: 0 });
  assert.ok(errors.some((e) => e.includes('idleLimitsFactor')));
  assert.equal(config.idleLimitsFactor, DEFAULTS.idleLimitsFactor);
});

test('thresholds are cleaned, sorted, deduplicated and bounded', () => {
  const { config } = validate({ thresholds: [90, 50, 50, 0, 150, 'x', 75] });
  assert.deepEqual(config.thresholds, [50, 75, 90]);
});

test('an empty threshold list falls back to the defaults rather than silencing alerts', () => {
  const { config } = validate({ thresholds: [] });
  assert.deepEqual(config.thresholds, DEFAULTS.thresholds);
});

test('a non-http webhook is rejected', () => {
  const { config, errors } = validate({ webhook: 'ftp://x/y' });
  assert.equal(config.webhook, null);
  assert.ok(errors.some((e) => e.includes('webhook')));
});

test('blank extra directories are dropped and whitespace trimmed', () => {
  const { config } = validate({ transcripts: { source: 'auto', extraDirs: ['  /a  ', '', '   ', '/b'] } });
  assert.deepEqual(config.transcripts.extraDirs, ['/a', '/b']);
});

test('validate never mutates the shared defaults', () => {
  validate({ thresholds: [1, 2], credentials: { source: 'file', path: '/x' } });
  assert.deepEqual(DEFAULTS.thresholds, [50, 75, 90, 95]);
  assert.equal(DEFAULTS.credentials.path, null);
});

/* ---------- overrides ---------- */

test('CLI overrides beat the saved config without rewriting it', () => {
  const saved = validate({ credentials: { source: 'auto' }, transcripts: { source: 'auto' } }).config;
  const out = withOverrides(saved, { credentialsPath: '/tmp/c.json', projectsDir: '/tmp/p' });
  assert.equal(out.credentials.source, 'file');
  assert.equal(out.credentials.path, '/tmp/c.json');
  assert.equal(out.transcripts.source, 'dir');
  assert.equal(saved.credentials.source, 'auto', 'the saved config must be untouched');
});

test('absent overrides leave the saved values alone', () => {
  const saved = validate({ scanIntervalMs: 9000, webhook: 'https://a.example/hook' }).config;
  const out = withOverrides(saved, {});
  assert.equal(out.scanIntervalMs, 9000);
  assert.equal(out.webhook, 'https://a.example/hook');
});

test('extra directories are appended after the primary, without duplicates', () => {
  const cfg = validate({ transcripts: { source: 'dir', dir: '/a', extraDirs: ['/b', '/a'] } }).config;
  assert.deepEqual(resolveTranscriptDirs(cfg), ['/a', '/b']);
});

/* ---------- credential sources ---------- */

test('a file source reads and parses the credentials document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ub-cfg-'));
  const path = join(dir, '.credentials.json');
  await writeFile(path, creds());
  const r = await readCredentials({ source: 'file', path });
  assert.equal(r.ok, true);
  assert.equal(r.accessToken, 'sk-ant-oat01-test');
  assert.equal(r.rateLimitTier, 'default_claude_max_20x');
  assert.equal(r.origin, path);
});

test('auto names the source it will land on, not the file it will miss', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ub-cfg-'));
  const path = join(dir, '.credentials.json');

  // No file: on a Mac the keychain is where it will actually read from, so
  // naming the absent path would read as though auto had settled on the file.
  const missing = describeSource({ source: 'auto', path });
  if (platform() === 'darwin') assert.match(missing, /macOS keychain/);
  else assert.ok(missing.includes(path));

  await writeFile(path, creds());
  assert.ok(describeSource({ source: 'auto', path }).includes(path));
});

test('a missing file reports where it looked', async () => {
  const r = await readCredentials({ source: 'file', path: '/definitely/not/here.json' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-credentials');
  assert.ok(r.message.includes('/definitely/not/here.json'));
});

test('an expired token is reported as expired, not as missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ub-cfg-'));
  const path = join(dir, '.credentials.json');
  await writeFile(path, creds({ expiresAt: Date.now() - 1000 }));
  const r = await readCredentials({ source: 'file', path });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('malformed credentials are reported as malformed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ub-cfg-'));
  const path = join(dir, '.credentials.json');
  await writeFile(path, 'not json at all');
  const r = await readCredentials({ source: 'file', path });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed');
});

test('a bare sk-ant token is accepted from any source', async () => {
  const r = await readCredentials({ source: 'token', token: 'sk-ant-oat01-bare' });
  assert.equal(r.ok, true);
  assert.equal(r.accessToken, 'sk-ant-oat01-bare');
});

test('a credentials document without the oauth wrapper still parses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ub-cfg-'));
  const path = join(dir, '.credentials.json');
  await writeFile(path, JSON.stringify({ accessToken: 'sk-ant-oat01-flat', expiresAt: Date.now() + 1000 }));
  const r = await readCredentials({ source: 'file', path });
  assert.equal(r.ok, true);
  assert.equal(r.accessToken, 'sk-ant-oat01-flat');
});

test('the command source stays disabled unless opted in', async () => {
  const r = await readCredentials({ source: 'command', command: 'echo hi' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
});

test('the keychain source is refused off macOS', async (t) => {
  if (platform() === 'darwin') return t.skip('runs on macOS');
  const r = await readCredentials({ source: 'keychain', service: 'Claude Code-credentials' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unsupported');
});

test('describeSource names each source in a way a human can act on', () => {
  assert.match(describeSource({ source: 'file', path: '/a/b.json' }), /\/a\/b\.json/);
  assert.match(describeSource({ source: 'keychain', service: 'X' }), /keychain/);
  assert.match(describeSource({ source: 'token', token: 'x' }), /token/);
  assert.match(describeSource({ source: 'auto' }), /auto/);
});

test('every declared source is handled rather than silently ignored', async () => {
  for (const source of CREDENTIAL_SOURCES) {
    const r = await readCredentials({ source, path: '/nope', service: 'S', command: 'true', token: '' });
    assert.equal(typeof r.ok, 'boolean', `${source} returned no verdict`);
    if (!r.ok) assert.ok(r.message, `${source} failed without a message`);
  }
});

/* ---------- multi-root discovery ---------- */

test('the same directory reached two ways is only counted once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ub-tx-'));
  const proj = join(root, '-Users-me-code');
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, '61b249e2-657b-470f-9e42-9cd2d25eb2ef.jsonl'), '');

  const r = await discoverAll([root, `${root}/`, join(root, '.', '')]);
  assert.equal(r.files.length, 1);
  assert.equal(r.roots.length, 1);
});

test('a bad directory is reported, not thrown, and does not blind the others', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ub-tx-'));
  const proj = join(root, '-Users-me-code');
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, '61b249e2-657b-470f-9e42-9cd2d25eb2ef.jsonl'), '');

  const r = await discoverAll(['/no/such/dir', root]);
  assert.equal(r.files.length, 1);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].dir, '/no/such/dir');
});

test('two distinct roots both contribute', async () => {
  const roots = [];
  for (let i = 0; i < 2; i++) {
    const root = await mkdtemp(join(tmpdir(), 'ub-tx-'));
    const proj = join(root, `-Users-me-p${i}`);
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, `61b249e2-657b-470f-9e42-9cd2d25eb2e${i}.jsonl`), '');
    roots.push(root);
  }
  const r = await discoverAll(roots);
  assert.equal(r.files.length, 2);
  assert.equal(r.roots.length, 2);
});

/* The settings picker is the only way to enter a path without typing it, so a
   regression here silently forces users back to free text. */
test('browse lists directories, walks up, and reports bad paths', async () => {
  const { browseDir } = await import('../src/server/index.js');
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = await mkdtemp(join(tmpdir(), 'ub-browse-'));
  await mkdir(join(root, 'projects'));
  await mkdir(join(root, 'zeta'));
  await writeFile(join(root, '.credentials.json'), '{}');

  const dirs = await browseDir(root);
  assert.equal(dirs.ok, true);
  assert.deepEqual(dirs.entries.map((e) => e.name), ['projects', 'zeta'],
    'files must be hidden unless asked for, and directories sorted');
  assert.equal(dirs.parent, tmpdir().replace(/\/$/, ''));

  const withFiles = await browseDir(root, { files: true });
  assert.ok(withFiles.entries.some((e) => e.name === '.credentials.json' && e.kind === 'file'));
  // Directories sort ahead of files regardless of name.
  assert.equal(withFiles.entries[0].kind, 'dir');

  // Pointing at a file opens its folder and preselects it — otherwise typing a
  // known credentials path into the box would dead-end.
  const atFile = await browseDir(join(root, '.credentials.json'), { files: true });
  assert.equal(atFile.path, root);
  assert.equal(atFile.selected, join(root, '.credentials.json'));

  const missing = await browseDir(join(root, 'nope'));
  assert.equal(missing.ok, false);
  assert.match(missing.message, /No such directory/);

  // A relative path is not a traversal attempt, it is a typo; land somewhere sane.
  const relative = await browseDir('some/relative/path');
  assert.equal(relative.ok, true);
  assert.equal(relative.path, (await import('node:os')).homedir());
});

/* app.js dereferences elements at module scope, so one stale selector throws
   during load and takes every handler on the page down with it — including the
   ones that have nothing to do with the element that moved. */
test('every element app.js reaches for exists in the markup', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const web = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web');

  const js = await readFile(join(web, 'app.js'), 'utf8');
  const html = await readFile(join(web, 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

  const wanted = new Set([
    ...[...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]),
    ...[...js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]),
  ]);
  const missing = [...wanted].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `app.js references #${missing.join(', #')} which the markup does not define`);

  // The reverse direction is only a warning in spirit, but the settings form is
  // read wholesale by readForm, so a control it never reads is dead weight.
  for (const id of ['menubar-fill', 'menubar-severity', 'gauge-style', 'gauge-palette']) {
    assert.ok(ids.has(id), `the settings sheet is missing #${id}`);
    assert.ok(js.includes(`'#${id}'`), `app.js never reads #${id}`);
  }
});

/* The dashboard cannot import from src/core, so it carries its own copy of the
   gauge maths. Copies drift; this is the tripwire. */
test('the browser copy of the gauge maths matches the server', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { gaugeColor, readableInk, THEME_IDS, GAUGE_PALETTES } = await import('../src/core/themes.js');

  const web = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web');
  const js = await readFile(join(web, 'app.js'), 'utf8');

  // Run the browser implementations in isolation against the same inputs.
  const harness = `
    ${js.match(/const toRgb = \(hex\) => \{[\s\S]*?\};/)[0]}
    ${js.match(/function mixHex\(a, b, t\) \{[\s\S]*?\n\}/)[0]}
    ${js.match(/function readableInk\(background\) \{[\s\S]*?\n\}/)[0]}
    function clientGauge(p, paletteName, percent) {
      const pct = Math.min(100, Math.max(0, Number(percent) || 0));
      switch (paletteName) {
        case 'accent': return p.accent;
        case 'mono': return pct >= 90 ? p.ink : p.inkDim;
        case 'gradient': {
          const [from, to, t] = pct <= 75 ? [p.ok, p.warn, pct / 75] : [p.warn, p.crit, (pct - 75) / 25];
          return mixHex(from, to, t);
        }
        default: return pct >= 90 ? p.crit : pct >= 75 ? p.warn : p.ok;
      }
    }
    return { clientGauge, readableInk };
  `;
  // eslint-disable-next-line no-new-func
  const { clientGauge, readableInk: clientInk } = new Function(harness)();
  const { palette } = await import('../src/core/themes.js');

  for (const id of THEME_IDS) {
    for (const mode of ['light', 'dark']) {
      for (const pal of GAUGE_PALETTES) {
        for (const pct of [0, 12, 50, 74, 75, 76, 89, 90, 100]) {
          assert.equal(
            clientGauge(palette(id, mode), pal, pct),
            gaugeColor(id, mode, pal, pct),
            `${id}/${mode}/${pal} at ${pct}% diverged between browser and server`,
          );
        }
      }
      for (const key of ['bg', 'panel', 'accent', 'ok', 'warn', 'crit']) {
        assert.equal(clientInk(palette(id, mode)[key]), readableInk(palette(id, mode)[key]),
          `readableInk diverged on ${id}/${mode}/${key}`);
      }
    }
  }
});
