import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import {
  THEME_IDS, DEFAULT_THEME, APPEARANCES, METRICS, SCOPES,
  MENUBAR_SCHEME_IDS, MENUBAR_FILLS, GAUGE_STYLES, GAUGE_PALETTES,
} from './themes.js';

/**
 * The config file must not live under the Claude directory, because the whole
 * point of it is to relocate that directory. It gets its own home.
 */
export const CONFIG_FILE = process.env.USAGE_BAR_CONFIG
  || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'usage-bar', 'config.json');

/** Running an arbitrary command is opt-in: it is reachable from a browser page. */
export const COMMAND_SOURCE_ALLOWED =
  process.env.USAGE_BAR_ALLOW_COMMAND === '1' || process.env.USAGE_BAR_ALLOW_COMMAND === 'true';

export const CREDENTIAL_SOURCES = ['auto', 'file', 'keychain', 'command', 'token'];
export const TRANSCRIPT_SOURCES = ['auto', 'dir'];

export const DEFAULTS = Object.freeze({
  credentials: { source: 'auto', path: null, service: 'Claude Code-credentials', account: null, command: null, token: null },
  transcripts: { source: 'auto', dir: null, extraDirs: [] },
  appearance: {
    theme: DEFAULT_THEME, mode: 'system',
    metric: 'remaining', scope: 'session',
    // The menu bar is configured separately from the dashboard because it is a
    // different surface with a background we do not own. Defaults to no chip,
    // which is the least surprising thing for a menu bar item to look like.
    menubar: { scheme: 'neutral', fill: 'none', severity: true },
    gauge: { style: 'blocks', palette: 'severity' },
  },
  scanIntervalMs: 3000,
  // Three minutes, not one. The 5h limit moves slowly and the usage endpoint is
  // shared infrastructure — polling it harder buys nothing and earns 429s.
  limitsIntervalMs: 180000,
  /**
   * Multiplier applied to the usage poll when no session is active.
   *
   * Only a safety net. A session starting here triggers an immediate reading,
   * and a limit rolling over schedules its own, so the idle gap governs exactly
   * one thing: how quickly usage incurred somewhere else — another machine, the
   * web app — shows up. Twelve minutes is a fair answer to that, and it is the
   * single biggest lever on the daily request count, since most hours are idle.
   */
  idleLimitsFactor: 4,
  idleMs: 300000,
  notify: true,
  thresholds: [50, 75, 90, 95],
  webhook: null,
});

/* ---------- candidate discovery ---------- */

/** Claude's own directory, honouring the same env var Claude Code uses. */
export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * Likely credential and transcript locations on this machine, so the settings
 * page can offer a pick-list instead of demanding a typed path.
 */
export function discoverCandidates() {
  const home = homedir();
  const credDirs = [
    process.env.CLAUDE_CONFIG_DIR,
    process.env.CLAUDE_CODE_DIR,
    join(home, '.claude'),
    join(home, '.config', 'claude'),
  ].filter(Boolean);

  const credentials = [];
  const seenCred = new Set();
  for (const d of credDirs) {
    const p = join(d, '.credentials.json');
    if (!seenCred.has(p) && existsSync(p)) { seenCred.add(p); credentials.push({ path: p, origin: 'standard' }); }
  }

  const transcripts = [];
  const seenTx = new Set();
  for (const d of credDirs) {
    const p = join(d, 'projects');
    if (!seenTx.has(p) && existsSync(p)) { seenTx.add(p); transcripts.push({ path: p, origin: 'standard' }); }
  }

  return { credentials, transcripts, keychainAvailable: platform() === 'darwin' };
}

/* ---------- load / save ---------- */

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function mergeDefaults(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlainObject(v) && isPlainObject(base[k])) out[k] = mergeDefaults(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Validates and normalises a config patch. Returns { config, errors } — never
 * throws, because this runs on user input from the settings page.
 */
export function validate(patch) {
  const errors = [];
  const clean = structuredClone(DEFAULTS);
  const merged = mergeDefaults(clean, patch);

  const c = merged.credentials;
  if (!CREDENTIAL_SOURCES.includes(c.source)) {
    errors.push(`credentials.source must be one of ${CREDENTIAL_SOURCES.join(', ')}`);
    c.source = 'auto';
  }
  if (c.source === 'file' && !c.path) errors.push('credentials.path is required when source is "file"');
  if (c.source === 'keychain') {
    if (platform() !== 'darwin') errors.push('credentials.source "keychain" is only available on macOS');
    if (!c.service) errors.push('credentials.service is required when source is "keychain"');
  }
  if (c.source === 'command') {
    if (!c.command) errors.push('credentials.command is required when source is "command"');
    if (!COMMAND_SOURCE_ALLOWED) {
      errors.push('credentials.source "command" is disabled. Restart with USAGE_BAR_ALLOW_COMMAND=1 to enable it.');
    }
  }
  if (c.source === 'token' && !c.token) errors.push('credentials.token is required when source is "token"');

  const t = merged.transcripts;
  if (!TRANSCRIPT_SOURCES.includes(t.source)) {
    errors.push(`transcripts.source must be one of ${TRANSCRIPT_SOURCES.join(', ')}`);
    t.source = 'auto';
  }
  if (t.source === 'dir' && !t.dir) errors.push('transcripts.dir is required when source is "dir"');
  if (!Array.isArray(t.extraDirs)) { t.extraDirs = []; errors.push('transcripts.extraDirs must be a list of paths'); }
  else t.extraDirs = t.extraDirs.filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim());

  const a = merged.appearance;
  if (!THEME_IDS.includes(a.theme)) {
    errors.push(`appearance.theme must be one of ${THEME_IDS.join(', ')}`);
    a.theme = DEFAULT_THEME;
  }
  if (!APPEARANCES.includes(a.mode)) {
    errors.push(`appearance.mode must be one of ${APPEARANCES.join(', ')}`);
    a.mode = 'system';
  }
  // Superseded by appearance.menubar. Carried across rather than dropped, so an
  // existing config keeps the intent behind the old setting.
  if (a.menubarStyle) {
    if (a.menubarStyle === 'mono') a.menubar = { ...a.menubar, severity: false };
    delete a.menubarStyle;
  }

  const mb = { ...DEFAULTS.appearance.menubar, ...(a.menubar || {}) };
  if (!MENUBAR_SCHEME_IDS.includes(mb.scheme)) {
    errors.push(`appearance.menubar.scheme must be one of ${MENUBAR_SCHEME_IDS.join(', ')}`);
    mb.scheme = DEFAULTS.appearance.menubar.scheme;
  }
  if (!MENUBAR_FILLS.includes(mb.fill)) {
    errors.push(`appearance.menubar.fill must be one of ${MENUBAR_FILLS.join(', ')}`);
    mb.fill = 'none';
  }
  mb.severity = mb.severity !== false;
  a.menubar = mb;

  const g = { ...DEFAULTS.appearance.gauge, ...(a.gauge || {}) };
  if (!GAUGE_STYLES.includes(g.style)) {
    errors.push(`appearance.gauge.style must be one of ${GAUGE_STYLES.join(', ')}`);
    g.style = 'blocks';
  }
  if (!GAUGE_PALETTES.includes(g.palette)) {
    errors.push(`appearance.gauge.palette must be one of ${GAUGE_PALETTES.join(', ')}`);
    g.palette = 'severity';
  }
  a.gauge = g;
  if (!METRICS.includes(a.metric)) {
    errors.push(`appearance.metric must be one of ${METRICS.join(', ')}`);
    a.metric = 'remaining';
  }
  if (!SCOPES.includes(a.scope)) {
    errors.push(`appearance.scope must be one of ${SCOPES.join(', ')}`);
    a.scope = 'session';
  }

  for (const key of ['scanIntervalMs', 'limitsIntervalMs', 'idleMs']) {
    const n = Number(merged[key]);
    if (!Number.isFinite(n) || n < 500) { errors.push(`${key} must be a number of at least 500`); merged[key] = DEFAULTS[key]; }
    else merged[key] = n;
  }
  const factor = Number(merged.idleLimitsFactor);
  if (!Number.isFinite(factor) || factor < 1 || factor > 60) {
    errors.push('idleLimitsFactor must be a number between 1 and 60');
    merged.idleLimitsFactor = DEFAULTS.idleLimitsFactor;
  } else {
    merged.idleLimitsFactor = factor;
  }

  // Polling the shared usage endpoint faster than every 30s is antisocial, and
  // it is the fastest route to being rate limited.
  if (merged.limitsIntervalMs < 30000) {
    errors.push('limitsIntervalMs must be at least 30000 (30s) to avoid hammering the usage endpoint');
    merged.limitsIntervalMs = 30000;
  }

  merged.notify = Boolean(merged.notify);
  if (!Array.isArray(merged.thresholds)) merged.thresholds = [...DEFAULTS.thresholds];
  merged.thresholds = [...new Set(merged.thresholds.map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 100))]
    .sort((a, b) => a - b);
  if (!merged.thresholds.length) merged.thresholds = [...DEFAULTS.thresholds];

  if (merged.webhook != null) {
    const w = String(merged.webhook).trim();
    if (!w) merged.webhook = null;
    else if (!/^https?:\/\//i.test(w)) { errors.push('webhook must be an http(s) URL'); merged.webhook = null; }
    else merged.webhook = w;
  }

  return { config: merged, errors };
}

export async function load() {
  let raw;
  try {
    raw = await readFile(CONFIG_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { config: structuredClone(DEFAULTS), errors: [], existed: false };
    return { config: structuredClone(DEFAULTS), errors: [`Could not read ${CONFIG_FILE}: ${err.message}`], existed: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: structuredClone(DEFAULTS), errors: [`${CONFIG_FILE} is not valid JSON; using defaults.`], existed: true };
  }
  const { config, errors } = validate(parsed);
  return { config, errors, existed: true };
}

export async function save(config) {
  const { config: clean, errors } = validate(config);
  if (errors.length) return { ok: false, errors, config: clean };
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  // The file can hold a pasted token; keep it owner-only.
  await writeFile(CONFIG_FILE, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  return { ok: true, errors: [], config: clean, path: CONFIG_FILE };
}

/**
 * Layers CLI/env overrides on top of the saved config. Explicit flags win, so a
 * one-off `--interval 1` never rewrites what the settings page saved.
 */
export function withOverrides(config, overrides = {}) {
  const out = structuredClone(config);
  const O = overrides;

  if (O.credentialsPath) { out.credentials.source = 'file'; out.credentials.path = O.credentialsPath; }
  if (O.projectsDir) { out.transcripts.source = 'dir'; out.transcripts.dir = O.projectsDir; }
  if (O.scanIntervalMs != null) out.scanIntervalMs = O.scanIntervalMs;
  if (O.limitsIntervalMs != null) out.limitsIntervalMs = O.limitsIntervalMs;
  if (O.notify != null) out.notify = O.notify;
  if (O.webhook) out.webhook = O.webhook;
  if (O.thresholds?.length) out.thresholds = O.thresholds;
  return validate(out).config;
}

/** Where transcripts will actually be read from, in scan order. */
export function resolveTranscriptDirs(config) {
  const dirs = [];
  if (config.transcripts.source === 'dir' && config.transcripts.dir) dirs.push(config.transcripts.dir);
  else dirs.push(join(claudeHome(), 'projects'));
  for (const d of config.transcripts.extraDirs || []) if (!dirs.includes(d)) dirs.push(d);
  return dirs;
}

export async function dirStatus(path) {
  try {
    const s = await stat(path);
    return s.isDirectory() ? { ok: true, path } : { ok: false, path, message: 'Not a directory' };
  } catch (err) {
    return { ok: false, path, message: err.code === 'ENOENT' ? 'Does not exist' : err.message };
  }
}
