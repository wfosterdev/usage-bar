#!/usr/bin/env node
import { Store } from './core/store.js';
import { createApp, menubarView } from './server/index.js';
import { DEFAULT_THRESHOLDS, DEFAULT_COOLDOWN_MS } from './core/notify.js';
import {
  load as loadConfig, withOverrides, resolveTranscriptDirs, CONFIG_FILE, COMMAND_SOURCE_ALLOWED,
} from './core/config.js';
import { describeSource } from './core/credentials.js';
import { discoverAll } from './core/transcripts.js';
import { ABOUT } from './core/about.js';

const HELP = `usage-bar ${ABOUT.version} — live Claude usage and session monitor

  usage-bar serve [options]     Start the dashboard (default)
  usage-bar status              One-shot summary in the terminal
  usage-bar menubar             One-shot compact JSON (menu bar / scripts)
  usage-bar json                One-shot full state as JSON
  usage-bar statusline          Claude Code statusLine filter (reads stdin)
  usage-bar config              Show the resolved configuration and where it came from

Options
  --port <n>          HTTP port                 (default 4317)
  --host <addr>       Bind address              (default 127.0.0.1)
  --credentials <p>   Credentials file to use   (overrides saved settings)
  --projects <dir>    Transcript directory      (overrides saved settings)
  --interval <s>      Transcript scan interval  (default 3)
  --limits <s>        Usage endpoint poll       (default 60, minimum 15)
  --thresholds <a>    Alert percentages         (default ${DEFAULT_THRESHOLDS.join(',')})
  --quiet-for <m>     Minutes between pings     (default ${DEFAULT_COOLDOWN_MS / 60000}, 0 for none)
  --webhook <url>     POST alerts here as JSON
  --no-notify         Disable desktop notifications
  --open              Open the dashboard in a browser
  -h, --help
  -v, --version

Settings are edited in the dashboard (Settings, top right) and saved to
  ${CONFIG_FILE}
Flags above override the saved settings for one run without rewriting them.

Environment
  CLAUDE_CONFIG_DIR         Claude's directory, when it is not ~/.claude
  USAGE_BAR_CONFIG          Use a different config file
  USAGE_BAR_ALLOW_COMMAND=1 Permit the "command" credential source

${ABOUT.author} · ${ABOUT.homepage} · ${ABOUT.licence}
Not affiliated with or endorsed by Anthropic.
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-notify') args.notify = false;
    else if (a === '--open') args.open = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '-v' || a === '--version') args.version = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

/** Saved config, then one-run CLI overrides on top. */
async function configFrom(args) {
  const { config, errors } = await loadConfig();
  for (const e of errors) process.stderr.write(`usage-bar: config: ${e}\n`);
  return withOverrides(config, {
    credentialsPath: args.credentials || null,
    projectsDir: args.projects || null,
    scanIntervalMs: args.interval ? Number(args.interval) * 1000 : null,
    limitsIntervalMs: args.limits ? Number(args.limits) * 1000 : null,
    notify: args.notify === false ? false : null,
    webhook: args.webhook || null,
    thresholds: args.thresholds ? args.thresholds.split(',').map(Number).filter(Boolean) : null,
    // Not `|| null`: 0 is a meaningful value here, and means no quiet period.
    notifyCooldownMs: args['quiet-for'] != null ? Number(args['quiet-for']) * 60000 : null,
  });
}

/* ---------- terminal rendering ---------- */

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', b: '\x1b[1m', r: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', rd: '\x1b[31m', o: '\x1b[38;5;173m' }
  : { dim: '', b: '', r: '', g: '', y: '', rd: '', o: '' };

const money = (n) => `$${(n ?? 0).toFixed(2)}`;
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n ?? 0));
const dur = (ms) => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d`;
};

function bar(pct, width = 18) {
  const p = Math.max(0, Math.min(100, pct ?? 0));
  const filled = Math.round((p / 100) * width);
  const color = p >= 90 ? C.rd : p >= 75 ? C.y : C.g;
  return `${color}${'█'.repeat(filled)}${C.dim}${'░'.repeat(width - filled)}${C.r}`;
}

function renderStatus(store) {
  const lv = store.limitsView();
  const snap = store.snapshot();
  const out = [];

  out.push(`${C.b}Claude Usage${C.r}${lv.rateLimitTier ? ` ${C.dim}${lv.rateLimitTier}${C.r}` : ''}`);
  if (!lv.ok) {
    out.push(`  ${C.rd}${lv.message}${C.r}`);
  } else {
    for (const l of lv.limits) {
      const p = l.projection;
      let note = l.resetsAt ? `resets ${dur(new Date(l.resetsAt) - Date.now())}` : '';
      if (p?.minutesToExhaust != null && !p.beatsReset) {
        note += `  ${C.rd}exhausts ${dur(p.minutesToExhaust * 60000)}${C.r}`;
      } else if (p && p.percentPerHour > 0.05) {
        note += `  ${C.dim}${p.percentPerHour.toFixed(1)}%/h${C.r}`;
      }
      out.push(`  ${l.label.padEnd(22)} ${bar(l.percent)} ${String(l.percent ?? 0).padStart(3)}%  ${C.dim}${note}${C.r}`);
    }
  }

  out.push('');
  out.push(`${C.b}Active sessions${C.r} ${C.dim}${snap.counts.active} of ${snap.counts.total} · ${money(snap.totals.activeCost)} · ${money(snap.totals.activeCostPerMin * 60)}/h${C.r}`);
  if (!snap.active.length) {
    out.push(`  ${C.dim}none in the last 5 minutes${C.r}`);
  }
  for (const s of snap.active) {
    const busy = s.lastStopReason === 'tool_use';
    const mark = busy ? `${C.o}●${C.r}` : `${C.g}○${C.r}`;
    out.push(`  ${mark} ${C.b}${s.name.slice(0, 46).padEnd(46)}${C.r} ${(s.currentModel || '—').replace('claude-', '').padEnd(11)} ${tokens(s.tokens.total).padStart(6)} ${money(s.cost).padStart(8)}`);
    const bits = [s.projectLabel, s.gitBranch, `ctx ${s.context.pct.toFixed(0)}%`,
      s.subagentCount ? `${s.subagentCount} subagents` : null,
      busy ? `▶ ${s.activeTools[0]}` : `${dur(s.idleMs)} idle`,
      s.compactionCount ? `${s.compactionCount} compactions` : null].filter(Boolean);
    out.push(`    ${C.dim}${bits.join(' · ')}${C.r}`);
    // Cmd-clickable in most terminals, which is the whole point of printing it.
    out.push(`    ${C.dim}${s.claude ? s.claude.web : 'terminal session only'}${C.r}`);
  }

  const h = store.history.totals(7);
  out.push('');
  out.push(`${C.b}Last 7 days${C.r} ${C.dim}${money(h.cost)} equivalent · ${tokens(h.tokens.total)} tokens${C.r}`);
  for (const r of h.bySkill.slice(0, 3)) {
    out.push(`  ${C.dim}${String(r.key).padEnd(24)} ${money(r.cost).padStart(9)}${C.r}`);
  }
  out.push('');
  out.push(`${C.dim}Dollars are equivalent API cost, not billed on a subscription.${C.r}`);
  return out.join('\n');
}

/* ---------- Claude Code statusline ---------- */

async function statusline(store) {
  const input = await new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    setTimeout(() => resolve(buf), 400);
  });
  let ctx = {};
  try { ctx = JSON.parse(input || '{}'); } catch {}

  const lv = store.limitsView();
  const parts = [];
  const cwd = ctx.workspace?.current_dir || ctx.cwd;
  if (cwd) parts.push(cwd.split('/').slice(-1)[0]);
  if (ctx.model?.display_name) parts.push(ctx.model.display_name);

  for (const l of lv.limits.filter((x) => x.isActive || x.group === 'session')) {
    const short = l.group === 'session' ? '5h' : 'wk';
    parts.push(`${short} ${bar(l.percent, 8)} ${l.percent}%`);
  }

  const sid = ctx.session_id;
  const s = sid ? store.session(sid) : null;
  if (s) parts.push(`${tokens(s.tokens.total)} ${money(s.cost)} ctx ${s.context.pct.toFixed(0)}%`);
  process.stdout.write(parts.join(` ${C.dim}·${C.r} `));
}

/* ---------- main ---------- */

function renderConfig(config) {
  const out = [];
  out.push(`${C.b}Configuration${C.r} ${C.dim}${CONFIG_FILE}${C.r}`);
  out.push(`  credentials   ${describeSource(config.credentials)}`);
  out.push(`  transcripts   ${resolveTranscriptDirs(config).join('\n                ')}`);
  const mb = config.appearance.menubar;
  out.push(`  theme         ${config.appearance.theme} · ${config.appearance.mode}`);
  out.push(`  menu bar      ${mb.scheme} · fill ${mb.fill} · severity ${mb.severity ? 'on' : 'off'}`);
  out.push(`  gauge         % ${config.appearance.metric} · tracking ${config.appearance.scope}`);
  out.push(`  scan every    ${config.scanIntervalMs / 1000}s`);
  out.push(`  usage poll    ${config.limitsIntervalMs / 1000}s`);
  out.push(`  idle after    ${config.idleMs / 1000}s`);
  out.push(`  notify        ${config.notify ? `on · ${config.thresholds.join(', ')}%` : 'off'}`);
  out.push(`  quiet period  ${config.notifyCooldownMs ? `${config.notifyCooldownMs / 60000}m between pings` : 'none'}`);
  out.push(`  webhook       ${config.webhook || '—'}`);
  out.push(`  command src   ${COMMAND_SOURCE_ALLOWED ? 'enabled' : 'disabled (set USAGE_BAR_ALLOW_COMMAND=1)'}`);
  return out.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'serve';
  if (args.version) { process.stdout.write(`${ABOUT.version}\n`); return; }
  if (args.help) { process.stdout.write(HELP); return; }

  const config = await configFrom(args);

  if (cmd === 'config') {
    process.stdout.write(`${renderConfig(config)}\n\n`);
    const { problems, roots } = await discoverAll(resolveTranscriptDirs(config));
    process.stdout.write(`${C.b}Transcript roots${C.r}\n`);
    for (const r of roots) process.stdout.write(`  ${C.g}\u2713${C.r} ${r}\n`);
    for (const p of problems) process.stdout.write(`  ${C.y}!${C.r} ${p.dir} \u2014 ${p.message}\n`);
    return;
  }

  // Only `serve` runs long enough for notifications to make sense.
  if (cmd !== 'serve') config.notify = false;

  // A missing transcript directory is a warning, not a stop: the limit gauges
  // still work, and the dashboard is where the user fixes the path.
  const { roots, problems } = await discoverAll(resolveTranscriptDirs(config));
  if (!roots.length) {
    for (const p of problems) process.stderr.write(`usage-bar: ${p.dir} — ${p.message}\n`);
    process.stderr.write('usage-bar: no transcripts found. Set a directory in Settings, or pass --projects <dir>.\n');
    if (cmd !== 'serve') { process.exitCode = 1; return; }
  }

  const store = new Store(config);

  if (cmd !== 'serve') {
    await store.scan({ full: true });
    await store.refreshLimits();
    if (cmd === 'status') process.stdout.write(`${renderStatus(store)}\n`);
    else if (cmd === 'menubar') process.stdout.write(`${JSON.stringify(menubarView(store), null, 2)}\n`);
    else if (cmd === 'json') process.stdout.write(`${JSON.stringify(store.state(), null, 2)}\n`);
    else if (cmd === 'statusline') await statusline(store);
    else { process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`); process.exitCode = 1; }
    store.stop();
    return;
  }

  const port = Number(args.port) || 4317;
  const host = args.host || '127.0.0.1';
  process.stderr.write(`usage-bar: credentials ${describeSource(config.credentials)}\n`);

  // Bind BEFORE indexing. Startup does a full archive scan and two network
  // calls, and on macOS the first credential read can sit behind a keychain
  // prompt — so doing that first leaves the port closed for tens of seconds,
  // which every client correctly reports as "server not reachable". The API
  // serves a 'starting' state until the first scan lands.
  const app = createApp(store, { port, host });
  let url;
  try {
    url = await app.listen();
  } catch (err) {
    process.stderr.write(`usage-bar: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`usage-bar: ${url} (listening)\n`);
  process.stderr.write(`usage-bar: indexing ${resolveTranscriptDirs(config).join(', ')}…\n`);

  try {
    await store.start();
  } catch (err) {
    // A failed index must not take the server down: the dashboard is where the
    // user fixes a bad path, so it has to stay up to be fixable.
    process.stderr.write(`usage-bar: startup problem: ${err.message}\n`);
  }
  const snap = store.snapshot();
  process.stderr.write(`usage-bar: ready (${snap.counts.total} sessions, ${snap.counts.active} active)\n`);

  if (args.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    (await import('node:child_process')).execFile(opener, [url], () => {});
  }

  const shutdown = () => { store.stop(); app.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => { process.stderr.write(`usage-bar: ${err.stack}\n`); process.exitCode = 1; });
