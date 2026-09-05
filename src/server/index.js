import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, extname, normalize, resolve, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_FILE, DEFAULTS, CREDENTIAL_SOURCES, TRANSCRIPT_SOURCES, COMMAND_SOURCE_ALLOWED,
  discoverCandidates, save as saveConfig, validate as validateConfig,
  resolveTranscriptDirs, dirStatus,
} from '../core/config.js';
import { testCredentials } from '../core/limits.js';
import { Store } from '../core/store.js';
import { describeSource } from '../core/credentials.js';
import { discover } from '../core/transcripts.js';
import { ABOUT } from '../core/about.js';
import {
  themeCatalog, menubarCatalog, gaugeCatalog, menubarColors, menuColors, gaugeColor, palette,
  renderTextBar, THEME_IDS, APPEARANCES, MENUBAR_FILLS, MENUBAR_SCHEME_IDS,
  GAUGE_STYLES, GAUGE_PALETTES,
} from '../core/themes.js';

const MAX_BODY = 256 * 1024;
const TOKEN_MASK = '__unchanged__';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// Listing directories for the settings picker. A browser cannot show a native
// chooser for a path on the machine running the server — `webkitdirectory` hands
// back a sandboxed name, not a real path — so the server has to enumerate.
// Read-only: names and kinds, never contents.
const BROWSE_LIMIT = 750;

export async function browseDir(requested, { files = false } = {}) {
  const home = homedir();
  const raw = String(requested || '').trim();
  const expanded = raw.startsWith('~') ? join(home, raw.slice(1)) : raw;
  const target = expanded && isAbsolute(expanded) ? resolve(expanded) : home;

  let st;
  try {
    st = await stat(target);
  } catch (err) {
    const why = err.code === 'ENOENT' ? 'No such directory.'
      : err.code === 'EACCES' ? 'Permission denied.'
      : err.message;
    return { ok: false, path: target, home, message: why };
  }
  // Pointed at a file: show the folder that holds it, and preselect it.
  if (!st.isDirectory()) {
    const parent = dirname(target);
    const listing = await browseDir(parent, { files });
    return { ...listing, selected: target };
  }

  let names;
  try {
    names = await readdir(target, { withFileTypes: true });
  } catch (err) {
    return { ok: false, path: target, home, message: err.code === 'EACCES' ? 'Permission denied.' : err.message };
  }

  const entries = [];
  for (const d of names) {
    // A symlink's dirent reports neither, so resolve those specifically rather
    // than dropping them — ~/.claude is a symlink on plenty of setups.
    let isDir = d.isDirectory();
    let isFile = d.isFile();
    if (d.isSymbolicLink()) {
      try {
        const target2 = await stat(join(target, d.name));
        isDir = target2.isDirectory();
        isFile = target2.isFile();
      } catch { continue; }
    }
    if (isDir) entries.push({ name: d.name, path: join(target, d.name), kind: 'dir' });
    else if (files && isFile) entries.push({ name: d.name, path: join(target, d.name), kind: 'file' });
  }

  entries.sort((a, b) => (a.kind === b.kind
    ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    : a.kind === 'dir' ? -1 : 1));

  const parent = dirname(target);
  return {
    ok: true,
    path: target,
    parent: parent === target ? null : parent,
    home,
    name: basename(target) || target,
    truncated: entries.length > BROWSE_LIMIT,
    entries: entries.slice(0, BROWSE_LIMIT),
  };
}

function json(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Compact projection for the macOS menu bar: everything it needs to draw the
 * glance, and nothing it doesn't. Keeping this shape stable means the Swift
 * side never has to parse the full state tree.
 */
/**
 * One limit, plus everything needed to draw it. Bar colours are resolved for
 * both appearances here rather than in Swift: a gradient palette cannot be
 * reconstructed from a handful of stops, and the maths belongs with the
 * palette definitions in any case.
 */
function limitView(l, app) {
  const pct = l.percent ?? 0;
  return {
    label: l.label,
    percent: l.percent,
    resetsAt: l.resetsAt,
    severity: l.severity,
    projection: l.projection,
    bar: renderTextBar(pct, app.gauge.style),
    color: {
      light: gaugeColor(app.theme, 'light', app.gauge.palette, pct),
      dark: gaugeColor(app.theme, 'dark', app.gauge.palette, pct),
    },
  };
}

export function menubarView(store) {
  const lv = store.limitsView();
  const snap = store.snapshot();
  const session = lv.limits.find((l) => l.group === 'session') || null;
  const weekly = lv.limits.filter((l) => l.group === 'weekly' && l.percent != null);
  const worstWeekly = weekly.sort((a, b) => b.percent - a.percent)[0] || null;

  const app = store.config.appearance;
  // Which limit the glance tracks. 'worst' is whichever is closest to biting,
  // which may be a weekly cap rather than the 5h session.
  const tracked = app.scope === 'worst'
    ? [session, worstWeekly].filter(Boolean).sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0] || session
    : session;

  // Before the first successful usage fetch there is no number to show; saying
  // "100% left" would be a confident lie during startup.
  const known = lv.ok && tracked && typeof tracked.percent === 'number';
  const used = known ? tracked.percent : 0;
  const remaining = Math.max(0, 100 - used);
  // Severity always follows how much is SPENT, whichever way the number reads:
  // 5% remaining and 95% used are the same emergency.
  const severity = used >= 90 ? 'critical' : used >= 75 ? 'warning' : 'normal';

  return {
    ok: lv.ok,
    message: lv.ok ? null : (lv.reason === 'pending' ? 'Starting…' : lv.message),
    ready: known,
    // A held-over reading is not an error — the numbers below are real, just a
    // little old. Reported separately so the UI can say that without shouting.
    stale: Boolean(lv.stale),
    staleMessage: lv.stale ? lv.staleMessage : null,
    // Present on both paths: held-over data and a cold start that never got any.
    retryAt: lv.retryAt || null,
    glance: {
      // `display` is the number to paint; `used`/`remaining` are both provided
      // so the client never has to know which way round the setting is.
      known,
      display: app.metric === 'used' ? used : remaining,
      used,
      remaining,
      metric: app.metric,
      scope: app.scope,
      label: tracked?.label ?? 'Session (5h)',
      suffix: app.metric === 'used' ? 'used' : 'left',
      severity,
    },
    session: session && limitView(session, app),
    weekly: weekly.map((l) => limitView(l, app)),
    plan: lv.rateLimitTier || lv.subscriptionType || null,
    // Resolved here rather than in Swift, so a new palette needs no recompile.
    // 'system' is reported as such: only the Mac knows its own current mode.
    theme: {
      id: app.theme,
      mode: app.mode,
      style: app.menubar.fill === 'none' ? 'plain' : app.menubar.fill,
      light: menubarColors(app.theme, 'light', app.menubar),
      dark: menubarColors(app.theme, 'dark', app.menubar),
      // The dropdown is a different surface with a predictable background, so
      // it gets its own resolved colours rather than reusing the bar's.
      menuLight: menuColors(app.theme, 'light', app.menubar),
      menuDark: menuColors(app.theme, 'dark', app.menubar),
    },
    activeSessions: snap.active.map((s) => ({
      sessionId: s.sessionId,
      title: s.title || s.projectLabel,
      project: s.projectLabel,
      branch: s.gitBranch,
      model: s.currentModel,
      cost: s.cost,
      tokens: s.tokens.total,
      contextPct: s.context.pct,
      subagents: s.subagentCount,
      subagentsActive: s.subagentActiveCount,
      busy: s.busy,
      tool: s.activeTools[0] || null,
      idleMs: s.idleMs,
    })),
    totals: snap.totals,
    costBasis: 'equivalent-api-cost',
  };
}

/**
 * Same-origin gate for mutating requests.
 *
 * The dashboard listens on loopback, but any page in the user's browser can
 * still POST to it. Browsers always attach Origin to a cross-origin POST, so
 * rejecting a mismatched Origin (and any cross-site Sec-Fetch-Site) stops a
 * hostile page from rewriting the credential location behind the user's back.
 * Non-browser clients (curl, the Swift app) send neither header and pass.
 */
function sameOrigin(req, host, port) {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;

  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const allowed = new Set([`${host}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    return allowed.has(u.host);
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

/** Never send a stored token back to the browser; report only that one is set. */
function redactConfig(config) {
  const out = structuredClone(config);
  if (out.credentials.token) out.credentials.token = TOKEN_MASK;
  return out;
}

/** Re-attach the stored token when the browser echoes the mask back unchanged. */
function unredactConfig(incoming, current) {
  const out = structuredClone(incoming);
  if (out?.credentials?.token === TOKEN_MASK) out.credentials.token = current.credentials.token;
  return out;
}

async function configPayload(store) {
  const dirs = resolveTranscriptDirs(store.config);
  const dirStatuses = await Promise.all(dirs.map(async (d) => {
    const st = await dirStatus(d);
    if (!st.ok) return { ...st, sessions: 0 };
    const found = await discover(d).catch(() => []);
    return { ...st, sessions: found.filter((f) => f.kind === 'session').length };
  }));

  return {
    config: redactConfig(store.config),
    defaults: DEFAULTS,
    configFile: CONFIG_FILE,
    candidates: discoverCandidates(),
    options: {
      credentialSources: CREDENTIAL_SOURCES,
      transcriptSources: TRANSCRIPT_SOURCES,
      commandAllowed: COMMAND_SOURCE_ALLOWED,
      platform: process.platform,
    },
    status: {
      credentialSource: describeSource(store.config.credentials),
      credentialsOk: store.limits.ok === true,
      credentialsMessage: store.limits.ok ? null : store.limits.message,
      transcriptDirs: dirStatuses,
      scanProblems: store.scanProblems,
    },
  };
}

export function createApp(store, { port = 4317, host = '127.0.0.1' } = {}) {
  const clients = new Set();

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  };

  store.on('sessions', (snap) => broadcast('sessions', snap));
  store.on('limits', (lv) => broadcast('limits', lv));
  store.on('alert', (a) => broadcast('alert', a));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    try {
      if (path === '/api/state') return json(res, store.state());
      if (path === '/api/menubar') return json(res, menubarView(store));

      if (path === '/api/about') return json(res, ABOUT);

      if (path === '/api/themes') {
        return json(res, {
          themes: themeCatalog(),
          appearances: APPEARANCES,
          menubarSchemes: menubarCatalog(),
          menubarFills: MENUBAR_FILLS,
          menubarSchemeIds: MENUBAR_SCHEME_IDS,
          gauge: gaugeCatalog(),
          gaugeStyles: GAUGE_STYLES,
          gaugePalettes: GAUGE_PALETTES,
          active: store.config.appearance,
        });
      }

      if (path === '/api/config' && req.method === 'GET') {
        return json(res, await configPayload(store));
      }

      if (path === '/api/browse') {
        // A GET, but it enumerates the filesystem — gate it like a write.
        if (!sameOrigin(req, host, port)) {
          return json(res, { ok: false, message: 'Cross-origin requests are not allowed on this endpoint.' }, 403);
        }
        const listing = await browseDir(url.searchParams.get('path'),
                                        { files: url.searchParams.get('files') === '1' });
        // A bad path is a normal answer the picker renders inline, not an
        // HTTP error — the user is mid-typing.
        return json(res, listing);
      }

      if ((path.startsWith('/api/config') || path === '/api/limits/refresh') && req.method !== 'GET') {
        if (!sameOrigin(req, host, port)) {
          return json(res, { error: 'Cross-origin requests are not allowed on this endpoint.' }, 403);
        }
        let body;
        try { body = await readBody(req); } catch (e) { return json(res, { error: e.message }, 400); }

        if (path === '/api/config' && (req.method === 'PUT' || req.method === 'POST')) {
          const merged = unredactConfig(body, store.config);
          const { errors } = validateConfig(merged);
          if (errors.length) return json(res, { ok: false, errors }, 400);

          const saved = await saveConfig(merged);
          if (!saved.ok) return json(res, { ok: false, errors: saved.errors }, 400);

          const applied = await store.applyConfig(saved.config);
          broadcast('limits', store.limitsView());
          broadcast('sessions', store.snapshot());
          return json(res, {
            ok: true,
            savedTo: saved.path,
            applied: applied.applied,
            ...(await configPayload(store)),
          });
        }

        if (path === '/api/limits/refresh' && req.method === 'POST') {
          // Explicit user action, so it may step over a backoff the endpoint
          // has since stopped needing. Still floored at 30s by the store.
          const attemptedAt = store.lastLimitsAttemptAt;
          const result = await store.refreshLimits({ force: true, override: true });
          const attempted = store.lastLimitsAttemptAt !== attemptedAt;
          broadcast('limits', store.limitsView());
          return json(res, {
            ok: Boolean(result.ok),
            attempted,
            reason: result.reason || null,
            message: attempted
              ? (result.ok ? 'Usage refreshed.' : result.message)
              : `Just checked — requests are spaced at least ${Store.MIN_MANUAL_SPACING_MS / 1000}s apart.`,
            limits: store.limitsView(),
          });
        }

        if (path === '/api/config/test-credentials' && req.method === 'POST') {
          const creds = unredactConfig({ credentials: body.credentials || {} }, store.config).credentials;
          return json(res, await testCredentials(creds));
        }

        if (path === '/api/config/test-dir' && req.method === 'POST') {
          const dir = String(body.dir || '').trim();
          if (!dir) return json(res, { ok: false, message: 'No directory given.' }, 400);
          const st = await dirStatus(dir);
          if (!st.ok) return json(res, st);
          const found = await discover(dir).catch(() => []);
          const sessions = found.filter((f) => f.kind === 'session').length;
          const subagents = found.filter((f) => f.kind === 'subagent').length;
          return json(res, {
            ok: true, path: dir, sessions, subagents,
            message: sessions
              ? `Found ${sessions} sessions and ${subagents} subagent transcripts.`
              : 'Directory exists but contains no session transcripts.',
          });
        }

        return json(res, { error: 'not found' }, 404);
      }

      if (path.startsWith('/api/session/')) {
        const id = decodeURIComponent(path.slice('/api/session/'.length));
        const d = store.session(id);
        return d ? json(res, d) : json(res, { error: 'not found' }, 404);
      }

      if (path === '/api/history') {
        const granularity = url.searchParams.get('granularity') === 'hour' ? 'hour' : 'day';
        const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
        return json(res, {
          granularity,
          series: store.history.series(granularity, granularity === 'hour' ? days * 24 : days),
          totals: store.history.totals(days),
        });
      }

      if (path === '/api/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          'connection': 'keep-alive',
        });
        res.write(`event: state\ndata: ${JSON.stringify(store.state())}\n\n`);
        clients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);
        ping.unref?.();
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }

      // Static assets. Paths are normalised and confined to the web directory.
      const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      const target = normalize(join(WEB_DIR, rel));
      if (!target.startsWith(WEB_DIR)) return json(res, { error: 'forbidden' }, 403);
      const body = await readFile(target);
      res.writeHead(200, {
        'content-type': MIME[extname(target)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      return res.end(body);
    } catch (err) {
      if (err.code === 'ENOENT') return json(res, { error: 'not found' }, 404);
      return json(res, { error: err.message }, 500);
    }
  });

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE') {
          const e = new Error(`Port ${port} is already in use — another usage-bar may be running. Try --port ${port + 1}.`);
          e.code = err.code;
          return reject(e);
        }
        if (err.code === 'EACCES') {
          const e = new Error(`Not permitted to bind ${host}:${port}. Try a port above 1024.`);
          e.code = err.code;
          return reject(e);
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        // Once bound, a later socket error must not take the whole process down.
        server.on('error', (e) => process.stderr.write(`usage-bar: server error: ${e.message}\n`));
        resolve(`http://${host}:${port}`);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    }),
    close: () => { for (const c of clients) c.end(); server.close(); },
  };
}
