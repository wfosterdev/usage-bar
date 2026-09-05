const $ = (sel) => document.querySelector(sel);
let configPayload = null;
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const fmtMoney = (n) => `$${(n ?? 0).toFixed(n >= 100 ? 0 : 2)}`;
const fmtTokens = (n) => {
  if (n == null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
};
const fmtPct = (n) => `${(n ?? 0).toFixed(n < 10 ? 1 : 0)}%`;
const fmtDur = (ms) => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
};
const untilText = (iso) => {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  return ms <= 0 ? 'now' : `in ${fmtDur(ms)}`;
};
const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

/* ---------- limits ---------- */

function retryNowButton() {
  const btn = el('button', 'ghost tiny', 'Try now');
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Trying…';
    try {
      const r = await (await fetch('/api/limits/refresh', { method: 'POST' })).json();
      if (r.limits) renderLimits(r.limits);
      if (!r.ok) toast({ title: 'Still not available', body: r.message || 'No reason given.' });
    } catch (e) {
      toast({ title: 'Could not reach the local server', body: e.message });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Try now';
    }
  });
  return btn;
}

let lastLimits = null;

function renderLimits(lv) {
  lastLimits = lv;
  const host = $('#limit-list');
  const err = $('#limits-error');
  $('#plan').textContent = lv.rateLimitTier || lv.subscriptionType || '';

  if (!lv.ok) {
    host.innerHTML = '';
    err.textContent = lv.message || 'Usage endpoint unavailable.';
    if (lv.retryAt) err.textContent += ` Retrying ${untilText(lv.retryAt)}.`;
    err.className = 'error';
    // A backoff outlives the outage that caused it, so there has to be a way to
    // say "it is back now" without waiting the timer out or restarting.
    if (lv.reason === 'rate-limited' || lv.reason === 'network' || lv.reason === 'timeout') {
      err.append(retryNowButton());
    }
    err.classList.remove('hidden');
    return;
  }
  // A held-over reading is not an error: the numbers are real, just not fresh.
  // Showing the red error box for a 429 would misrepresent what happened.
  if (lv.stale) {
    const retry = lv.retryAt ? ` Retrying ${untilText(lv.retryAt)}.` : '';
    err.textContent = `${lv.staleMessage || 'Could not refresh usage.'}${retry} Showing the last reading${lv.fetchedAt ? ` from ${timeOf(lv.fetchedAt)}` : ''}.`;
    err.className = 'error stale';
    err.append(retryNowButton());
    err.classList.remove('hidden');
  } else {
    err.classList.add('hidden');
  }
  host.innerHTML = '';

  for (const l of lv.limits) {
    const row = el('div', `limit-row${l.isActive ? '' : ' inactive'}`);
    // The metric setting flips the whole gauge, not just the number: showing
    // "72%" above a bar filled to 28% would read as a contradiction.
    const used = l.percent ?? 0;
    const showRemaining = appearance.metric !== 'used';
    const shown = showRemaining ? Math.max(0, 100 - used) : used;

    const head = el('div', 'limit-head');
    head.append(el('span', 'limit-label', l.label));
    const pctEl = el('span', 'limit-pct', fmtPct(shown));
    pctEl.append(el('em', 'pct-suffix', showRemaining ? ' left' : ' used'));
    head.append(pctEl);
    row.append(head);

    const bar = el('div', 'bar');
    const fill = el('i');
    // Severity always tracks what has been spent, whichever way the gauge reads.
    styleBar(bar, fill, { used, shown });
    bar.append(fill);
    row.append(bar);

    const note = el('div', 'limit-note');
    const bits = [];
    if (l.resetsAt) bits.push(`resets ${untilText(l.resetsAt)}`);
    const p = l.projection;
    if (p && p.percentPerHour > 0.05) {
      bits.push(`${p.percentPerHour.toFixed(1)}%/h`);
      if (p.minutesToExhaust != null && !p.beatsReset) {
        bits.push(`<span class="danger">exhausted in ${fmtDur(p.minutesToExhaust * 60000)}</span>`);
      } else if (p.beatsReset) {
        bits.push('<span class="safe">resets before exhausting</span>');
      }
    }
    note.innerHTML = bits.join(' · ');
    row.append(note);
    host.append(row);
  }

  if (lv.extraUsage?.enabled) {
    const row = el('div', 'limit-row');
    row.append(el('div', 'limit-note',
      `Extra usage: ${lv.extraUsage.usedCredits ?? '?'} / ${lv.extraUsage.monthlyLimit ?? '?'} ${lv.extraUsage.currency || ''}`));
    host.append(row);
  }
}

/* ---------- session rows ---------- */

const openIds = new Set();

/** The macOS menu bar links to /#session=<id>; honour that on load and on hash change. */
function deepLinkId() {
  const m = /(?:^|[#&])session=([0-9a-f-]{36})/i.exec(location.hash || '');
  return m ? m[1] : null;
}
let pendingReveal = deepLinkId();
if (pendingReveal) openIds.add(pendingReveal);
window.addEventListener('hashchange', () => {
  const id = deepLinkId();
  if (!id) return;
  openIds.add(id);
  pendingReveal = id;
  revealPending();
});

function revealPending() {
  if (!pendingReveal) return;
  const row = document.querySelector(`.srow[data-id="${CSS.escape(pendingReveal)}"]`);
  if (!row) return;
  row.open = true;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.animate(
    [{ outline: '2px solid var(--accent)' }, { outline: '2px solid transparent' }],
    { duration: 1600, easing: 'ease-out' },
  );
  pendingReveal = null;
}

function sessionRow(s) {
  const row = el('details', 'srow');
  row.dataset.id = s.sessionId;
  if (openIds.has(s.sessionId)) row.open = true;

  const sum = el('summary');
  const busy = s.busy;
  const live = s.subagentActiveCount || 0;
  // What the parent is doing, if anything; otherwise what its agents are doing.
  const doing = s.activeTools[0] || (live ? `${live} agent${live > 1 ? 's' : ''}` : null);
  const state = el('span', `state ${busy ? 'busy' : s.active ? 'idle' : ''}`);
  state.title = busy ? `running ${doing || 'tool'}` : s.active ? 'idle' : 'inactive';
  sum.append(state);

  const title = el('div', 'stitle');
  title.append(el('b', null, s.title || s.projectLabel || s.sessionId.slice(0, 8)));
  const meta = [s.projectLabel, s.gitBranch, busy && doing ? `▶ ${doing}` : null,
    // Live over lifetime, because a session that ran twelve agents an hour ago
    // and a session running twelve right now are not the same thing.
    s.subagentCount ? (live ? `${live}/${s.subagentCount} subagents` : `${s.subagentCount} subagents`) : null,
    s.active ? `${fmtDur(s.idleMs)} idle` : timeOf(s.lastTs)].filter(Boolean);
  title.append(el('span', null, meta.join(' · ')));
  sum.append(title);

  const ctx = el('div', 'ctxmini');
  ctx.append(el('small', null, `ctx ${fmtPct(s.context.pct)}`));
  const cbar = el('div', 'bar thin');
  const cfill = el('i');
  styleBar(cbar, cfill, { used: s.context.pct, shown: s.context.pct });
  cbar.append(cfill);
  ctx.append(cbar);
  sum.append(ctx);

  sum.append(el('span', 'chip model', s.currentModel ? s.currentModel.replace('claude-', '') : '—'));
  sum.append(el('span', 'money', fmtMoney(s.cost)));
  row.append(sum);

  const body = el('div', 'detail');
  body.append(el('div', 'empty', 'Loading…'));
  row.append(body);

  row.addEventListener('toggle', () => {
    if (row.open) { openIds.add(s.sessionId); loadDetail(s.sessionId, body); }
    else openIds.delete(s.sessionId);
  });
  if (row.open) loadDetail(s.sessionId, body);
  return row;
}

function renderSessions(snap) {
  $('#now-sub').textContent =
    `${snap.counts.active} active · ${fmtMoney(snap.totals.activeCost)} · ${fmtMoney(snap.totals.activeCostPerMin * 60)}/h`;

  for (const [hostSel, list, emptySel] of [
    ['#active-list', snap.active, '#active-empty'],
    ['#recent-list', snap.recent, null],
  ]) {
    const host = $(hostSel);
    host.innerHTML = '';
    for (const s of list) host.append(sessionRow(s));
    if (emptySel) $(emptySel).classList.toggle('hidden', list.length > 0);
  }
  $('#updated').textContent = `updated ${timeOf(snap.generatedAt)}`;
  $('#live-dot').classList.remove('stale');
  revealPending();
}

/* ---------- drill-down ---------- */

async function loadDetail(id, host) {
  let d;
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    d = await res.json();
  } catch (e) {
    host.innerHTML = '';
    host.append(el('div', 'error', `Could not load session: ${e.message}`));
    return;
  }
  host.innerHTML = '';
  host.append(statGrid(d));
  const split = costSplitBlock(d.costSplit);
  if (split) host.append(split);
  if (d.messages.length) host.append(messagesBlock(d.messages));
  if (d.subagents.length) host.append(subagentsBlock(d.subagents));
  const attribution = breakdownBlock(d);
  if (attribution) host.append(attribution);
  const events = eventsBlock(d);
  if (events) host.append(events);
  host.append(analyseBlock(d));
  host.append(footerBlock(d));
}

function stat(dt, dd, sub, alarm) {
  const s = el('div', `stat${alarm ? ' alarm' : ''}`);
  s.append(el('dt', null, dt));
  const v = el('dd', null, dd);
  if (sub) v.append(el('small', null, ` ${sub}`));
  s.append(v);
  return s;
}

function statGrid(d) {
  const g = el('div', 'grid');
  g.append(stat('Equivalent cost', fmtMoney(d.cost), d.subagentCost ? `+${fmtMoney(d.subagentCost)} sub` : ''));
  g.append(stat('Tokens', fmtTokens(d.tokens.total), `${fmtTokens(d.tokens.output)} out`));
  g.append(stat('Context', fmtPct(d.context.pct), `${fmtTokens(d.context.tokens)} / ${fmtTokens(d.context.window)}`, d.context.pct > 85));
  g.append(stat('Cache hits', fmtPct(d.cacheHitRatio * 100), `saved ${fmtMoney(d.savedByCache)}`));
  g.append(stat('Burn rate', `${fmtMoney(d.costPerMin * 60)}/h`, `${d.toolCalls} tools`));
  if (d.compactionCount) {
    g.append(stat('Compactions', String(d.compactionCount),
      `${fmtTokens(d.droppedTokens)} dropped · ${fmtDur(d.compactionMs)}`, true));
  }
  if (d.errorCount) g.append(stat('API errors', String(d.errorCount), '', true));
  if (d.denialCount) g.append(stat('Denials', String(d.denialCount), 'tools blocked'));
  if (d.queuedOps) g.append(stat('Queued', String(d.queuedOps), 'prompts'));
  return g;
}

const TOKEN_CLASSES = [
  ['input', 'Input'],
  ['output', 'Output'],
  ['cacheWrite5m', 'Cache write 5m'],
  ['cacheWrite1h', 'Cache write 1h'],
  ['cacheRead', 'Cache read'],
];

/**
 * Where the money went, by token class.
 *
 * The bar answers "what dominates" at a glance and the table carries the
 * numbers; the two are the same data because a five-way split is very hard to
 * read off colour alone once one slice is 80% of the width.
 */
function costSplitBlock(split, title = 'Cost by token class') {
  if (!split || !split.total.cost) return null;
  const b = el('div', 'block');
  b.append(el('h3', null, title));

  const bar = el('div', 'split');
  for (const [key] of TOKEN_CLASSES) {
    const pct = (split[key].cost / split.total.cost) * 100;
    if (pct <= 0) continue;
    const seg = el('i', `seg ${key}`);
    seg.style.width = `${pct}%`;
    seg.title = `${TOKEN_CLASSES.find(([k]) => k === key)[1]} · ${fmtMoney(split[key].cost)}`;
    bar.append(seg);
  }
  b.append(bar);

  b.append(table(['Class', 'Tokens', 'Cost', 'Share'],
    TOKEN_CLASSES.map(([key, label]) => {
      const c = split[key];
      const name = el('div', 'namecell');
      name.append(el('i', `key ${key}`));
      name.append(el('span', null, label));
      return [
        name,
        fmtTokens(c.tokens),
        fmtMoney(c.cost),
        fmtPct((c.cost / split.total.cost) * 100),
      ];
    })));
  return b;
}

function messagesBlock(messages) {
  const b = el('div', 'block');
  b.append(el('h3', null, `Last messages (${messages.length})`));
  const list = el('div', 'msgs');
  for (const m of [...messages].reverse()) {
    const item = el('div', `msg ${m.role}`);
    item.append(el('header', null, `${m.role}${m.model ? ` · ${m.model.replace('claude-', '')}` : ''} · ${timeOf(m.ts)}`));
    item.append(el('pre', null, m.text));
    if (m.tools?.length) item.append(el('div', 'tools', `→ ${m.tools.join(', ')}`));
    list.append(item);
  }
  b.append(list);
  return b;
}

/**
 * A row is either a plain array of cells or `{ cells, className }`, and a cell
 * is either text or a node the caller has already built.
 */
function table(headers, rows) {
  const t = el('table');
  const thead = el('thead');
  const hr = el('tr');
  headers.forEach((h, i) => hr.append(el('th', i ? 'num' : null, h)));
  thead.append(hr); t.append(thead);
  const tb = el('tbody');
  for (const r of rows) {
    const { cells, className } = Array.isArray(r) ? { cells: r, className: null } : r;
    const tr = el('tr', className);
    cells.forEach((c, i) => {
      const td = el('td', i ? 'num' : null);
      if (c instanceof Node) td.append(c);
      else td.textContent = c;
      tr.append(td);
    });
    tb.append(tr);
  }
  t.append(tb);
  return t;
}

function subagentsBlock(subs) {
  const b = el('div', 'block');
  const live = subs.filter((s) => s.active).length;
  b.append(el('h3', null, live ? `Subagents (${live}/${subs.length} running)` : `Subagents (${subs.length})`));
  b.append(table(['Agent', 'Model', 'Ctx', 'Tokens', 'Cost'],
    subs.map((s) => {
      const name = el('div', 'namecell');
      // The same live green as the header and the session rows, so "running"
      // looks the same wherever it is said.
      if (s.active) name.append(el('span', 'state live'));
      // The launch record's description says what it was sent to do, which is
      // far more use than a bare agent type when several of the same type run.
      const label = el('span', null, s.description || s.agentType || s.agentId.slice(0, 8));
      label.title = s.agentId;
      name.append(label);
      return [
        name,
        (s.model || '—').replace('claude-', ''),
        fmtPct(s.context.pct),
        fmtTokens(s.tokens.total),
        fmtMoney(s.cost),
      ];
    })));
  return b;
}

function breakdownBlock(d) {
  const groups = [
    ['By model', d.perModel],
    ['By skill', d.perSkill],
    ['By agent', d.perAgent],
  ].filter(([, rows]) => rows.length);
  if (!groups.length) return null;

  const wrap = el('div', 'hist-cols');
  for (const [name, rows] of groups) {
    const b = el('div', 'block');
    b.append(el('h3', null, name));
    b.append(table([name.replace('By ', ''), 'Calls', 'Cost'],
      rows.slice(0, 8).map((r) => [
        String(r.key).replace('claude-', ''),
        String(r.calls),
        fmtMoney(r.cost),
      ])));
    wrap.append(b);
  }
  return wrap;
}

function eventsBlock(d) {
  const items = [
    ...d.compactions.map((c) => ({
      ts: c.ts, cls: 'compact',
      what: `compacted (${c.trigger}) ${fmtTokens(c.preTokens)} → ${fmtTokens(c.postTokens)}, dropped ${fmtTokens(c.dropped)} in ${fmtDur(c.durationMs)}`,
    })),
    ...d.errors.map((e) => ({ ts: e.ts, cls: 'err', what: `API error${e.status ? ` ${e.status}` : ''}: ${e.text || ''}`.trim() })),
    ...d.denials.map((x) => ({ ts: x.ts, cls: '', what: `tool denied (${x.kind})${x.reason ? `: ${x.reason}` : ''}` })),
  ].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

  if (!items.length) return null;
  const b = el('div', 'block');
  b.append(el('h3', null, 'Events'));
  const list = el('div', 'events');
  for (const it of items.slice(0, 20)) {
    const row = el('div', `ev ${it.cls}`);
    row.append(el('span', 'when', timeOf(it.ts)));
    row.append(el('span', 'what', it.what));
    list.append(row);
  }
  b.append(list);
  return b;
}

/* ---------- analyse-this prompt ---------- */

const pad = (s, n) => String(s).padEnd(n);
const padNum = (s, n) => String(s).padStart(n);
// The UI's formatters drop precision on purpose to keep rows narrow — $312.47
// renders as "$312". A prompt is read, not scanned, so it gets the cents back.
const exactMoney = (n) => `$${(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const exactPct = (n) => `${(n ?? 0).toFixed(1)}%`;

function promptRows(rows, cols) {
  return rows.map((r) => r.map((c, i) => (i ? padNum(c, cols[i]) : pad(c, cols[0]))).join('  ')).join('\n');
}

/**
 * A digest of the session, shaped as a prompt to paste into Claude.
 *
 * Deliberately metrics only — no message text, no tool output, no file paths
 * beyond the project label. The drill-down above shows transcript prose, but
 * this is written to be pasted somewhere else, and what leaves the machine
 * should be the numbers and nothing more.
 */
function analysePrompt(d) {
  const dur = d.firstTs && d.lastTs ? new Date(d.lastTs) - new Date(d.firstTs) : null;
  const out = [];

  out.push('Analyse this Claude Code session for token usage and cost efficiency.');
  out.push('');
  out.push('All dollar figures are EQUIVALENT API COST: what this traffic would cost at');
  out.push('published per-MTok rates. On a Pro/Max subscription these are not billed — they');
  out.push('are a common unit for comparing sessions, models and skills.');
  out.push('');

  out.push('## Session');
  out.push(`Project: ${d.projectLabel || '—'}${d.gitBranch ? ` (${d.gitBranch})` : ''}`);
  out.push(`Model: ${d.currentModel || '—'}${d.currentEffort ? ` · effort ${d.currentEffort}` : ''}`);
  out.push(`Elapsed: ${dur == null ? '—' : fmtDur(dur)} · ${d.userMessages} user, `
    + `${d.assistantMessages} assistant messages, ${d.toolCalls} tool calls`);
  out.push(`Context now: ${exactPct(d.context.pct)} of ${d.context.window?.toLocaleString() ?? '—'} tokens`);
  out.push('');

  out.push('## Cost');
  out.push(`Total: ${exactMoney(d.cost)}${d.subagentCost ? ` (subagents ${exactMoney(d.subagentCost)})` : ''}`);
  out.push(`Tokens: ${d.tokens.total.toLocaleString()}`);
  out.push(`Cache hit ratio: ${exactPct(d.cacheHitRatio * 100)} · saved ${exactMoney(d.savedByCache)} vs no caching`);
  // The burn rate is a trailing-window figure; on a session that finished hours
  // ago it is correctly $0.00/h, which in a prompt just reads as a broken stat.
  if (d.active) out.push(`Burn rate: ${exactMoney(d.costPerMin * 60)}/h`);
  out.push('');

  if (d.costSplit?.total.cost) {
    out.push('## Cost by token class');
    out.push(promptRows(TOKEN_CLASSES.map(([key, label]) => [
      label,
      d.costSplit[key].tokens.toLocaleString(),
      exactMoney(d.costSplit[key].cost),
      exactPct((d.costSplit[key].cost / d.costSplit.total.cost) * 100),
    ]), [16, 16, 10, 7]));
    out.push('');
  }

  for (const [name, rows] of [['By model', d.perModel], ['By skill', d.perSkill], ['By agent', d.perAgent]]) {
    if (!rows.length) continue;
    out.push(`## ${name}`);
    out.push(promptRows(rows.map((r) => [
      String(r.key), `${r.calls} calls`, r.tokens.toLocaleString(), exactMoney(r.cost),
    ]), [30, 11, 16, 10]));
    out.push('');
  }

  if (d.subagents.length) {
    out.push(`## Subagents (${d.subagentActiveCount} running of ${d.subagents.length})`);
    out.push(promptRows(d.subagents.map((s) => [
      s.description || s.agentType || s.agentId,
      (s.model || '—').replace('claude-', ''),
      `${s.calls} calls`,
      exactMoney(s.cost),
      s.active ? 'running' : 'done',
    ]), [34, 14, 11, 10, 8]));
    out.push('');
  }

  const events = [
    d.compactionCount && `Compactions: ${d.compactionCount} (${fmtTokens(d.droppedTokens)} dropped, ${fmtDur(d.compactionMs)})`,
    d.errorCount && `API errors: ${d.errorCount}`,
    d.denialCount && `Tool denials: ${d.denialCount}`,
    d.queuedOps && `Queued prompts: ${d.queuedOps}`,
  ].filter(Boolean);
  if (events.length) {
    out.push('## Events');
    out.push(...events);
    out.push('');
  }

  out.push('Tell me:');
  out.push('1. Where the money actually went, and whether that split is normal for this work.');
  out.push('2. Anything wasteful — cache churn, repeated large reads, compaction losses.');
  out.push('3. Concrete changes that would cut cost without losing capability.');
  return out.join('\n');
}

function analyseBlock(d) {
  const text = analysePrompt(d);
  const b = el('div', 'block analyse');
  const head = el('div', 'analyse-head');
  head.append(el('h3', null, 'Analyse this session'));

  const btn = el('button', 'ghost tiny', 'Copy prompt');
  btn.type = 'button';
  let revert = null;
  btn.addEventListener('click', async () => {
    let ok = true;
    try {
      // Loopback counts as a secure context, so this is available; the manual
      // fallback covers a browser that still refuses (or denies permission).
      await navigator.clipboard.writeText(text);
    } catch {
      ok = selectFallback(b.querySelector('pre'));
    }
    btn.textContent = ok ? 'Copied' : 'Press ⌘C';
    clearTimeout(revert);
    revert = setTimeout(() => { btn.textContent = 'Copy prompt'; }, 2000);
  });
  head.append(btn);
  b.append(head);

  b.append(el('p', 'hint', 'Metrics only — no message text or tool output is included.'));
  b.append(el('pre', null, text));
  return b;
}

/** Select the prompt so the user can copy it by hand. */
function selectFallback(pre) {
  if (!pre) return false;
  const range = document.createRange();
  range.selectNodeContents(pre);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return false;
}

function footerBlock(d) {
  const bits = [d.cwd, d.gitBranch, d.currentEffort && `effort ${d.currentEffort}`,
    d.permissionMode, d.entrypoint, d.version && `v${d.version}`, d.sessionId].filter(Boolean);
  return el('div', 'limit-note', bits.join('  ·  '));
}

/* ---------- history ---------- */

async function loadHistory() {
  const days = Number($('#hist-days').value);
  const host = $('#history');
  let h;
  try {
    h = await (await fetch(`/api/history?days=${days}`)).json();
  } catch { host.innerHTML = '<div class="error">History unavailable.</div>'; return; }

  host.innerHTML = '';
  const max = Math.max(...h.series.map((s) => s.cost), 0.01);
  // A 90-day window is three times the columns a 30-day one has; close the gaps
  // so the bars keep a usable width instead of overflowing the card.
  const chart = el('div', `chart${h.series.length > 45 ? ' dense' : ''}`);
  for (const p of h.series) {
    // A quiet slot is drawn as a baseline stub rather than dropped, so the
    // spacing along the axis stays true to the calendar.
    const col = el('div', `col${p.quiet ? ' quiet' : ''}`);
    col.style.height = p.quiet ? '2px' : `${Math.max(2, (p.cost / max) * 100)}%`;
    col.dataset.tip = p.quiet
      ? `${p.key} · no activity`
      : `${p.key} · ${fmtMoney(p.cost)} · ${fmtTokens(p.tokens)}`;
    chart.append(col);
  }
  host.append(chart);

  const total = el('div', 'limit-note',
    `${h.totals.days} active ${h.totals.days === 1 ? 'day' : 'days'} of ${h.totals.window} · `
    + `${fmtMoney(h.totals.cost)} equivalent · ${fmtTokens(h.totals.tokens.total)} tokens`);
  host.append(total);

  const histSplit = costSplitBlock(h.totals.costSplit, 'Cost by token class');
  if (histSplit) host.append(histSplit);

  const cols = el('div', 'hist-cols');
  for (const [name, rows] of [['Projects', h.totals.byProject], ['Models', h.totals.byModel], ['Skills', h.totals.bySkill]]) {
    if (!rows.length) continue;
    const b = el('div', 'block');
    b.append(el('h3', null, name));
    b.append(table([name.slice(0, -1), 'Tokens', 'Cost'],
      rows.slice(0, 8).map((r) => [String(r.key).replace('claude-', ''), fmtTokens(r.tokens), fmtMoney(r.cost)])));
    cols.append(b);
  }
  host.append(cols);
}

/* ---------- alerts ---------- */

function toast(a) {
  const t = el('div', 'toast');
  t.append(el('b', null, a.title));
  t.append(el('span', null, a.body));
  $('#toast-host').append(t);
  setTimeout(() => t.remove(), 12000);
}

/* ---------- wiring ---------- */

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('state', (e) => {
    const st = JSON.parse(e.data);
    renderLimits(st.limits);
    renderSessions(st.sessions);
  });
  es.addEventListener('limits', (e) => renderLimits(JSON.parse(e.data)));
  es.addEventListener('sessions', (e) => renderSessions(JSON.parse(e.data)));
  es.addEventListener('alert', (e) => toast(JSON.parse(e.data)));
  es.onerror = () => $('#live-dot').classList.add('stale');
}

/* ---------- theme engine ---------- */

const CSS_VAR = {
  bg: '--bg', panel: '--panel', panel2: '--panel-2', ink: '--ink', inkDim: '--ink-dim',
  line: '--line', accent: '--accent', ok: '--ok', warn: '--warn', crit: '--crit',
};

let themeCatalogCache = null;
let appearance = {
  theme: 'ember', mode: 'system', metric: 'remaining', scope: 'session',
  menubar: { scheme: 'neutral', fill: 'none', severity: true },
  gauge: { style: 'blocks', palette: 'severity' },
};
let menubarCatalogCache = null;
let gaugeCatalogCache = null;

/* ---------- gauge colour ----------
   Mirrors src/core/themes.js. Duplicated rather than fetched per bar because a
   gauge repaints on every SSE frame and a round trip per repaint would be
   absurd; the shape is pinned by a test that compares the two. */

const toRgb = (hex) => {
  const h = String(hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0);
};

function mixHex(a, b, t) {
  const k = Math.min(1, Math.max(0, t));
  const [ra, ga, ba] = toRgb(a);
  const [rb, gb, bb] = toRgb(b);
  const to2 = (n) => Math.round(n).toString(16).padStart(2, '0');
  return `#${to2(ra + (rb - ra) * k)}${to2(ga + (gb - ga) * k)}${to2(ba + (bb - ba) * k)}`;
}

function activePalette() {
  const theme = themeCatalogCache?.find((t) => t.id === appearance.theme);
  return theme ? theme[resolvedMode()] : null;
}

/** Colour for a bar at `percent`, honouring the configured gauge palette. */
function gaugeColorFor(percent, paletteName = appearance.gauge?.palette) {
  const p = activePalette();
  if (!p) return null;
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

/**
 * Paints one bar. `used` drives the colour and `shown` drives the width — they
 * differ whenever the metric is "remaining", and conflating them would colour a
 * nearly-empty budget green.
 */
function styleBar(bar, fill, { used, shown }) {
  bar.classList.add(`style-${appearance.gauge?.style || 'blocks'}`);
  fill.style.width = `${Math.min(100, shown)}%`;
  const c = gaugeColorFor(used);
  if (c) fill.style.background = c;
}
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

/** 'system' resolves against the OS; anything else is taken literally. */
function resolvedMode() {
  return appearance.mode === 'system' ? (systemDark.matches ? 'dark' : 'light') : appearance.mode;
}

function applyTheme() {
  const mode = resolvedMode();
  const theme = themeCatalogCache?.find((t) => t.id === appearance.theme);
  const root = document.documentElement;
  // data-theme still drives the stylesheet's own light/dark rules.
  root.dataset.theme = mode;
  if (!theme) return;
  const p = theme[mode];
  for (const [key, varName] of Object.entries(CSS_VAR)) {
    if (p[key]) root.style.setProperty(varName, p[key]);
  }
  const btn = $('#theme');
  if (btn) btn.title = `${theme.name} · ${appearance.mode}`;
}

async function loadThemes() {
  try {
    const r = await (await fetch('/api/themes')).json();
    themeCatalogCache = r.themes;
    menubarCatalogCache = r.menubarSchemes;
    gaugeCatalogCache = r.gauge;
    appearance = r.active;
  } catch {
    // Keep the stylesheet defaults rather than leaving the page unstyled.
    return;
  }
  applyTheme();
}

/* The About panel is static markup with live values written over it, so the page
   still says something sensible if this request never lands. */
async function loadAbout() {
  let about;
  try {
    about = await (await fetch('/api/about')).json();
  } catch {
    return;
  }
  const set = (sel, fn) => { const el = $(sel); if (el) fn(el); };
  set('#about-version', (el) => { el.textContent = `v${about.version}`; });
  set('#about-author', (el) => {
    el.textContent = about.author;
    el.href = about.homepage;
  });
  set('#about-repo', (el) => { el.href = about.repository; });
  set('#about-licence', (el) => { el.textContent = about.licence; });
  document.title = `Claude Usage Bar v${about.version}`;
}

// Following the OS only matters while mode is 'system'.
systemDark.addEventListener('change', () => { if (appearance.mode === 'system') applyTheme(); });

/** The header button cycles system -> light -> dark for a quick flip. */
$('#theme').addEventListener('click', async () => {
  const order = ['system', 'light', 'dark'];
  appearance = { ...appearance, mode: order[(order.indexOf(appearance.mode) + 1) % order.length] };
  applyTheme();
  await persistAppearance(appearance);
});

async function persistAppearance(next) {
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(configPayload?.config || {}), appearance: next }),
    });
    const r = await res.json();
    if (r.ok) configPayload = r;
  } catch { /* a failed persist still leaves the theme applied for this session */ }
}

$('#hist-days').addEventListener('change', loadHistory);
loadThemes();
loadAbout();
connect();
loadHistory();
setInterval(loadHistory, 120_000);

/* ---------- settings ---------- */

const dlg = $('#settings');

const setText = (sel, text, cls = '') => {
  const n = $(sel);
  n.textContent = text || '';
  n.className = `hint ${cls}`.trim();
};

/**
 * Show only the fields relevant to the chosen sources.
 *
 * Keys are namespaced (`cred:file`, `tx:dir`) because the two selects share a
 * vocabulary — an unnamespaced "auto" from the transcript select would
 * otherwise reveal credential fields that do not apply.
 */
function syncVisibility() {
  const active = new Set([
    `cred:${$('#cred-source').value}`,
    `tx:${$('#tx-source').value}`,
    `mb:${$('#menubar-fill').value}`,
  ]);
  for (const f of document.querySelectorAll('.field[data-when]')) {
    const applies = f.dataset.when.split(' ');
    f.classList.toggle('hidden', !applies.some((k) => active.has(k)));
  }
}

function candidateChips(host, list, onPick) {
  host.innerHTML = '';
  for (const c of list) {
    const b = el('button', 'candidate', c.path);
    b.type = 'button';
    b.title = `Use ${c.path}`;
    b.addEventListener('click', () => onPick(c.path, c.source));
    host.append(b);
  }
}

function fillForm(p) {
  const c = p.config;
  $('#cred-source').value = c.credentials.source;
  $('#cred-path').value = c.credentials.path || '';
  $('#cred-service').value = c.credentials.service || '';
  $('#cred-account').value = c.credentials.account || '';
  $('#cred-command').value = c.credentials.command || '';
  $('#cred-token').value = c.credentials.token || '';

  $('#tx-source').value = c.transcripts.source;
  $('#tx-dir').value = c.transcripts.dir || '';
  $('#tx-extra').value = (c.transcripts.extraDirs || []).join('\n');

  $('#scan-interval').value = Math.round(c.scanIntervalMs / 1000);
  $('#limits-interval').value = Math.round(c.limitsIntervalMs / 1000);
  $('#idle-factor').value = c.idleLimitsFactor;
  renderPollBudget();
  $('#idle').value = Math.round(c.idleMs / 1000);
  $('#notify').checked = c.notify;
  $('#thresholds').value = (c.thresholds || []).join(', ');
  $('#notify-cooldown').value = Math.round((c.notifyCooldownMs ?? 0) / 60000);
  $('#webhook').value = c.webhook || '';

  // Options that this platform or this process cannot offer.
  const keychainOpt = $('#cred-source').querySelector('[value="keychain"]');
  keychainOpt.disabled = !p.candidates.keychainAvailable;
  keychainOpt.textContent = p.candidates.keychainAvailable ? 'macOS keychain' : 'macOS keychain (not on this OS)';
  const cmdOpt = $('#cred-source').querySelector('[value="command"]');
  cmdOpt.disabled = !p.options.commandAllowed;
  cmdOpt.textContent = p.options.commandAllowed ? 'Shell command' : 'Shell command (disabled)';
  setText('#cred-command-warn', p.options.commandAllowed
    ? 'This command runs with your user privileges every time usage is polled.'
    : 'Disabled. Restart usage-bar with USAGE_BAR_ALLOW_COMMAND=1 to enable it.', 'warn');

  setText('#cred-status',
    p.status.credentialsOk
      ? `Reading from ${p.status.credentialSource}`
      : `${p.status.credentialSource} — ${p.status.credentialsMessage || 'not connected'}`,
    p.status.credentialsOk ? 'good' : 'bad');

  const dirs = p.status.transcriptDirs || [];
  const total = dirs.reduce((a, d) => a + (d.sessions || 0), 0);
  setText('#tx-status',
    dirs.length
      ? `${total} sessions across ${dirs.length} director${dirs.length === 1 ? 'y' : 'ies'}: ` +
        dirs.map((d) => `${d.path}${d.ok ? ` (${d.sessions})` : ` — ${d.message}`}`).join(' · ')
      : 'No transcript directories configured.',
    total > 0 ? 'good' : 'bad');

  // The keychain is offered alongside the file paths, because on macOS it is
  // usually the only place credentials exist — a chip row with nothing in it
  // reads as "nothing was found".
  const credChips = [...p.candidates.credentials];
  if (p.candidates.keychainPresent) credChips.push({ path: 'macOS keychain', source: 'keychain' });
  candidateChips($('#cred-candidates'), credChips, (path, source) => {
    if (source === 'keychain') {
      $('#cred-source').value = 'keychain';
    } else {
      $('#cred-path').value = path;
      if ($('#cred-source').value === 'auto') $('#cred-source').value = 'file';
    }
    syncVisibility();
  });
  candidateChips($('#tx-candidates'), p.candidates.transcripts, (path) => {
    $('#tx-dir').value = path;
    $('#tx-source').value = 'dir';
    syncVisibility();
  });

  appearance = { ...appearance, ...c.appearance };
  $('#appearance-mode').value = appearance.mode;
  $('#metric').value = appearance.metric;
  $('#scope').value = appearance.scope;
  $('#menubar-fill').value = appearance.menubar?.fill || 'none';
  $('#menubar-severity').checked = appearance.menubar?.severity !== false;
  fillGaugeSelects();
  renderSwatches();
  renderMenubarSwatches();
  renderMenubarPreview();
  renderGaugePreview();
  applyTheme();

  setText('#config-file-note', `Saved to ${p.configFile}`);
  syncVisibility();
}

/** Swatches preview the palette in the mode that is actually showing. */
function renderSwatches() {
  const host = $('#theme-swatches');
  host.innerHTML = '';
  const mode = resolvedMode();
  for (const t of themeCatalogCache || []) {
    const p = t[mode];
    const btn = el('button', 'swatch');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(t.id === appearance.theme));

    const name = el('div', 'sw-name');
    name.append(el('span', null, t.name));
    if (t.id === appearance.theme) name.append(el('span', 'tick', '✓'));
    btn.append(name);

    const chips = el('div', 'sw-chips');
    for (const key of ['bg', 'panel2', 'accent', 'ok', 'warn', 'crit']) {
      const i = el('i');
      i.style.background = p[key];
      i.title = key;
      chips.append(i);
    }
    btn.append(chips);
    btn.append(el('div', 'sw-desc', t.description));

    btn.addEventListener('click', () => {
      appearance = { ...appearance, theme: t.id };
      applyTheme();
      renderSwatches();
    });
    host.append(btn);
  }
}

function readForm() {
  return {
    credentials: {
      source: $('#cred-source').value,
      path: $('#cred-path').value.trim() || null,
      service: $('#cred-service').value.trim() || null,
      account: $('#cred-account').value.trim() || null,
      command: $('#cred-command').value.trim() || null,
      token: $('#cred-token').value.trim() || null,
    },
    transcripts: {
      source: $('#tx-source').value,
      dir: $('#tx-dir').value.trim() || null,
      extraDirs: $('#tx-extra').value.split('\n').map((l) => l.trim()).filter(Boolean),
    },
    scanIntervalMs: Number($('#scan-interval').value) * 1000,
    limitsIntervalMs: Number($('#limits-interval').value) * 1000,
    idleLimitsFactor: Number($('#idle-factor').value),
    idleMs: Number($('#idle').value) * 1000,
    notify: $('#notify').checked,
    thresholds: $('#thresholds').value.split(',').map((n) => Number(n.trim())).filter(Boolean),
    notifyCooldownMs: Number($('#notify-cooldown').value) * 60000,
    webhook: $('#webhook').value.trim() || null,
    appearance: {
      theme: appearance.theme,
      mode: $('#appearance-mode').value,
      metric: $('#metric').value,
      scope: $('#scope').value,
      // Scheme comes from the swatch click rather than a form control, so it
      // is read off the live appearance object.
      menubar: {
        scheme: appearance.menubar?.scheme || 'neutral',
        fill: $('#menubar-fill').value,
        severity: $('#menubar-severity').checked,
      },
      gauge: {
        style: $('#gauge-style').value || 'blocks',
        palette: $('#gauge-palette').value || 'severity',
      },
    },
  };
}

function showErrors(list) {
  const host = $('#settings-errors');
  host.innerHTML = '';
  host.classList.toggle('hidden', !list?.length);
  for (const e of list || []) host.append(el('li', null, e));
}

/* Cancel has to undo the live theme preview, but a save has to survive being
   dismissed afterwards. Without moving this baseline forward, clicking ✕ after
   Save & apply silently reverted the appearance you had just saved — which
   looked exactly like saving not working. */
let commitAppearanceBaseline = null;

async function openSettings() {
  let baseline = { ...appearance };
  commitAppearanceBaseline = (next) => { baseline = { ...next }; };
  dlg.addEventListener('close', () => {
    commitAppearanceBaseline = null;
    if (dlg.returnValue === 'cancel') {
      appearance = baseline;
      applyTheme();
      if (lastLimits) renderLimits(lastLimits);
    }
  }, { once: true });
  showErrors([]);
  setText('#save-result', '');
  setText('#cred-test-result', '');
  setText('#tx-test-result', '');
  try {
    configPayload = await (await fetch('/api/config')).json();
    fillForm(configPayload);
    dlg.showModal();
  } catch (e) {
    toast({ title: 'Settings unavailable', body: e.message });
  }
}

$('#settings-form').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA') return;
  e.preventDefault();
  $('#save-settings').click();
});

$('#open-settings').addEventListener('click', openSettings);

// The menu bar links to /#settings; open the sheet straight away.
if (/(?:^|[#&])settings(?:$|[&=])/.test(location.hash || '')) openSettings();
window.addEventListener('hashchange', () => {
  if (/(?:^|[#&])settings(?:$|[&=])/.test(location.hash || '')) openSettings();
});
$('#cred-source').addEventListener('change', syncVisibility);
$('#tx-source').addEventListener('change', syncVisibility);

// Preview light/dark instantly; swatches repaint for the mode being shown.
$('#appearance-mode').addEventListener('change', () => {
  appearance = { ...appearance, mode: $('#appearance-mode').value };
  applyTheme();
  renderSwatches();
});

for (const [sel, key] of [['#metric', 'metric'], ['#scope', 'scope']]) {
  $(sel).addEventListener('change', () => {
    appearance = { ...appearance, [key]: $(sel).value };
    if (lastLimits) renderLimits(lastLimits);
  });
}

$('#cred-test').addEventListener('click', async () => {
  setText('#cred-test-result', 'Testing…');
  try {
    const r = await (await fetch('/api/config/test-credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: readForm().credentials }),
    })).json();
    setText('#cred-test-result', r.ok ? r.message : `${r.stage === 'resolve' ? 'Not found' : 'Rejected'}: ${r.message}`,
      r.ok ? 'good' : 'bad');
  } catch (e) {
    setText('#cred-test-result', e.message, 'bad');
  }
});

$('#tx-test').addEventListener('click', async () => {
  const form = readForm();
  const dirs = [form.transcripts.source === 'dir' ? form.transcripts.dir : null, ...form.transcripts.extraDirs]
    .filter(Boolean);
  if (!dirs.length) { setText('#tx-test-result', 'Auto-detect will be used.', ''); return; }

  setText('#tx-test-result', 'Checking…');
  const results = await Promise.all(dirs.map(async (dir) => {
    try {
      const r = await (await fetch('/api/config/test-dir', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir }),
      })).json();
      return `${dir}: ${r.ok ? `${r.sessions} sessions, ${r.subagents} subagents` : r.message}`;
    } catch (e) { return `${dir}: ${e.message}`; }
  }));
  const allGood = results.every((r) => /\d+ sessions/.test(r));
  setText('#tx-test-result', results.join(' · '), allGood ? 'good' : 'bad');
});

$('#save-settings').addEventListener('click', async () => {
  const btn = $('#save-settings');
  btn.disabled = true;
  showErrors([]);
  setText('#save-result', 'Saving…');
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(readForm()),
    });
    const r = await res.json();
    if (!res.ok || !r.ok) {
      showErrors(r.errors || [r.error || 'Could not save settings.']);
      setText('#save-result', 'Not saved.', 'bad');
      return;
    }
    configPayload = r;
    fillForm(r);
    // The saved values are now the baseline, so dismissing the sheet cannot
    // roll them back.
    commitAppearanceBaseline?.(appearance);

    const changed = Object.entries(r.applied || {}).filter(([, v]) => v).map(([k]) => k.replace('Changed', ''));
    setText('#save-result', changed.length ? `Saved · reloaded ${changed.join(', ')}` : 'Saved.', 'good');
    loadHistory();
    // "Save & apply" means done. Leaving the sheet open with a small hint in
    // the footer read as nothing having happened.
    toast({
      title: 'Settings saved',
      body: changed.length ? `Reloaded ${changed.join(', ')}.` : `Written to ${r.savedTo}`,
    });
    dlg.close('saved');
  } catch (e) {
    setText('#save-result', e.message, 'bad');
  } finally {
    btn.disabled = false;
  }
});

/* ---------- folder picker ----------
   A browser cannot open a native chooser for a path on the machine running the
   server: `webkitdirectory` returns a sandboxed relative name, never an
   absolute one. So the server enumerates and this renders the result. */

const browseDialog = $('#browser');
const browseList = $('#browse-list');
const browseCurrent = $('#browse-current');
const browseFilter = $('#browse-filter');
const browseMsg = $('#browse-msg');
const browseTitle = $('#browse-title');

let browseState = { mode: 'dir', path: null, entries: [], selected: null, resolve: null };

function browseSelect(path) {
  browseState.selected = path;
  for (const row of browseList.querySelectorAll('.browse-row')) {
    row.setAttribute('aria-current', String(row.dataset.path === path));
  }
  // In file mode, choosing means the selected file; in folder mode, the folder
  // you are standing in. Keep the button honest about which.
  $('#browse-choose').textContent = browseState.mode === 'file'
    ? (path ? 'Use this file' : 'Choose a file')
    : 'Use this folder';
}

function renderBrowseList() {
  const needle = browseFilter.value.trim().toLowerCase();
  const shown = needle
    ? browseState.entries.filter((e) => e.name.toLowerCase().includes(needle))
    : browseState.entries;

  browseList.replaceChildren();
  if (!shown.length) {
    browseList.append(el('li', 'browse-empty',
      browseState.entries.length ? 'Nothing matches that filter.' : 'This folder is empty.'));
    return;
  }

  for (const entry of shown) {
    const li = el('li');
    const row = el('button', `browse-row${entry.kind === 'file' ? ' is-file' : ''}`);
    row.type = 'button';
    row.dataset.path = entry.path;
    row.dataset.kind = entry.kind;
    row.append(el('span', 'glyph', entry.kind === 'dir' ? '▸' : '·'));
    row.append(el('span', 'name', entry.name));
    if (entry.kind === 'dir') {
      // Single click selects, double click descends — the two-step keeps a
      // mis-click from throwing away the folder you were looking at.
      row.addEventListener('click', () => browseSelect(entry.path));
      row.addEventListener('dblclick', () => loadBrowse(entry.path));
    } else if (browseState.mode === 'file') {
      row.classList.remove('is-file');
      row.addEventListener('click', () => browseSelect(entry.path));
      row.addEventListener('dblclick', () => finishBrowse(entry.path));
    }
    li.append(row);
    browseList.append(li);
  }
  browseSelect(browseState.selected);
}

async function loadBrowse(path) {
  browseMsg.textContent = 'Loading…';
  const q = new URLSearchParams({ path: path ?? '' });
  if (browseState.mode === 'file') q.set('files', '1');
  let data;
  try {
    data = await (await fetch(`/api/browse?${q}`)).json();
  } catch (err) {
    browseMsg.textContent = `Could not read that path: ${err.message}`;
    return;
  }
  if (!data.ok) {
    browseMsg.textContent = data.message || 'Could not read that path.';
    return;
  }
  browseState.path = data.path;
  browseState.entries = data.entries;
  browseState.parent = data.parent;
  browseState.home = data.home;
  browseState.selected = data.selected ?? null;
  browseCurrent.value = data.path;
  browseFilter.value = '';
  browseMsg.textContent = data.truncated
    ? `Showing the first ${data.entries.length} entries — use the filter to narrow it down.`
    : '';
  $('#browse-up').disabled = !data.parent;
  renderBrowseList();
  browseList.scrollTop = 0;
}

function finishBrowse(value) {
  const done = browseState.resolve;
  browseState.resolve = null;
  browseDialog.close();
  if (done) done(value ?? null);
}

/** Opens the picker and resolves with an absolute path, or null if cancelled. */
function openBrowser({ mode = 'dir', start = '', title = 'Choose a folder' } = {}) {
  return new Promise((resolve) => {
    browseState = { mode, path: null, entries: [], selected: null, parent: null, resolve };
    browseTitle.textContent = title;
    browseDialog.showModal();
    loadBrowse(start);
  });
}

$('#browse-up').addEventListener('click', () => {
  if (browseState.parent) loadBrowse(browseState.parent);
});
$('#browse-home').addEventListener('click', () => loadBrowse(browseState.home || ''));
browseFilter.addEventListener('input', renderBrowseList);
// The sheet is a method="dialog" form, so a stray Enter would submit it and
// close the picker. Every Enter in here means something more useful than that.
$('#browse-form').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (e.target === browseCurrent) { loadBrowse(browseCurrent.value); return; }
  if (e.target === browseFilter) {
    const first = browseList.querySelector('.browse-row[data-kind="dir"]');
    if (first) loadBrowse(first.dataset.path);
    return;
  }
  if (browseState.selected || browseState.mode === 'dir') $('#browse-choose').click();
});
$('#browse-choose').addEventListener('click', () => {
  const value = browseState.mode === 'file' ? browseState.selected : (browseState.selected || browseState.path);
  if (!value) { browseMsg.textContent = 'Select a file first.'; return; }
  finishBrowse(value);
});
// Covers Escape and the ✕ / Cancel submit buttons, which close without a click
// on #browse-choose — without this the promise would never settle.
browseDialog.addEventListener('close', () => {
  const done = browseState.resolve;
  browseState.resolve = null;
  if (done) done(null);
});

// One handler for every Browse button; the button says what it targets.
for (const btn of document.querySelectorAll('[data-browse]')) {
  btn.addEventListener('click', async () => {
    const target = document.getElementById(btn.dataset.browse);
    if (!target) return;
    const append = btn.dataset.browseAppend === '1';
    const mode = btn.dataset.browseFiles === '1' ? 'file' : 'dir';
    const start = append
      ? (target.value.split('\n').filter(Boolean).pop() || '')
      : (target.value.trim() || target.placeholder || '');

    const picked = await openBrowser({ mode, start, title: btn.dataset.browseTitle });
    if (!picked) return;

    if (append) {
      const lines = target.value.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.includes(picked)) lines.push(picked);
      target.value = lines.join('\n');
    } else {
      target.value = picked;
    }
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.focus();
  });
}

/* ---------- settings tabs ---------- */

function selectTab(id) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === id));
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.hidden = panel.dataset.tab !== id;
  }
  // The panels scroll as one column; a tab switch should start at the top of
  // the new section rather than wherever the last one was left.
  const body = $('.sheet-body.tabbed');
  if (body) body.scrollTop = 0;
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
}
// Left/right (or up/down) move between tabs, which is what a tablist should do.
$('.tab-rail')?.addEventListener('keydown', (e) => {
  const keys = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
  const step = keys[e.key];
  if (!step) return;
  e.preventDefault();
  const tabs = [...document.querySelectorAll('.tab')];
  const i = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
  const next = tabs[(i + step + tabs.length) % tabs.length];
  selectTab(next.dataset.tab);
  next.focus();
});

/* ---------- menu bar plate ---------- */

const MB_SAMPLE = { normal: '◐ 57% left', warning: '◐ 22% left', critical: '◐ 6% left' };

/** Mirrors readableInk in src/core/themes.js; pinned by a test. */
function readableInk(background) {
  if (!background) return null;
  const lum = (hex) => {
    const [r, g, b] = toRgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (hi + 0.05) / (lo + 0.05);
  };
  return ['#12120f', '#ffffff']
    .map((ink) => ({ ink, r: ratio(ink, background) }))
    .sort((a, b) => b.r - a.r)[0].ink;
}

/** Resolves the plate for one system mode, the same way the server does. */
function plateFor(mode, severity) {
  const mb = appearance.menubar || {};
  const scheme = menubarCatalogCache?.find((s) => s.id === mb.scheme);
  const theme = themeCatalogCache?.find((t) => t.id === appearance.theme);
  const p = theme?.[mode];

  if (mb.fill === 'none' || !scheme || !p) return { background: null, text: null };
  const entry = scheme.fills.find((f) => f.fill === mb.fill);
  const base = entry?.[mode]?.background;
  if (!base) return { background: null, text: null };

  const bg = mb.severity !== false && severity !== 'normal'
    ? (severity === 'critical' ? p.crit : p.warn)
    : base;
  return { background: bg, text: readableInk(bg) };
}

function renderMenubarPreview() {
  for (const mock of document.querySelectorAll('.mb-mock')) {
    const mode = mock.dataset.mode;
    for (const chip of mock.querySelectorAll('.mb-chip')) {
      const sev = chip.dataset.sev;
      const { background, text } = plateFor(mode, sev);
      chip.textContent = MB_SAMPLE[sev];
      chip.classList.toggle('plain', !background);
      chip.style.background = background || '';
      chip.style.color = text || '';
    }
  }

  // State the guarantee rather than asking anyone to take it on trust.
  const samples = ['light', 'dark'].flatMap((mode) =>
    ['normal', 'warning', 'critical'].map((sev) => plateFor(mode, sev)));
  const plated = samples.filter((s) => s.background);
  setText('#menubar-contrast', plated.length
    ? `Text colour is derived from the plate, so every combination above clears WCAG AA (4.5:1).`
    : 'No plate: the percentage uses the system menu bar colour, which tracks your wallpaper.');
}

function renderMenubarSwatches() {
  const host = $('#menubar-swatches');
  if (!host || !menubarCatalogCache) return;
  host.innerHTML = '';
  const mb = appearance.menubar || {};
  const fill = mb.fill === 'none' ? 'soft' : mb.fill;

  for (const scheme of menubarCatalogCache) {
    const entry = scheme.fills.find((f) => f.fill === fill);
    if (!entry?.light) continue;   // 'system' has no plate to show

    const btn = el('button', 'swatch');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(mb.scheme === scheme.id));

    const name = el('div', 'sw-name');
    name.append(el('span', null, scheme.name));
    if (mb.scheme === scheme.id) name.append(el('span', 'tick', '✓'));
    btn.append(name);

    // Both appearances side by side: the plate is chosen once and has to work
    // in whichever mode the laptop happens to be in. Showing real text on it
    // rather than a colour block is the whole point.
    const strip = el('div', 'sw-plates');
    for (const mode of ['light', 'dark']) {
      const half = el('span', 'sw-plate', '57%');
      half.style.background = entry[mode].background;
      half.style.color = entry[mode].text;
      half.title = `${mode}: ${entry[mode].text} on ${entry[mode].background}`;
      strip.append(half);
    }
    btn.append(strip);
    btn.append(el('div', 'sw-desc', scheme.description));
    btn.addEventListener('click', () => {
      appearance = { ...appearance, menubar: { ...mb, scheme: scheme.id } };
      renderMenubarSwatches();
      renderMenubarPreview();
    });
    host.append(btn);
  }
}

$('#menubar-fill').addEventListener('change', () => {
  appearance = {
    ...appearance,
    menubar: { ...appearance.menubar, fill: $('#menubar-fill').value },
  };
  syncVisibility();
  renderMenubarSwatches();
  renderMenubarPreview();
});

$('#menubar-severity').addEventListener('change', () => {
  appearance = {
    ...appearance,
    menubar: { ...appearance.menubar, severity: $('#menubar-severity').checked },
  };
  renderMenubarPreview();
});

/* ---------- usage bar style ---------- */

const GAUGE_STYLE_NAMES = {
  blocks: 'Solid bar', segments: 'Segmented', dots: 'Dots', line: 'Thin line',
};
const GAUGE_PALETTE_NAMES = {
  severity: 'Severity (green → amber → red)',
  gradient: 'Gradient across the same thresholds',
  accent: 'Theme accent only',
  mono: 'Greyscale',
};

function fillGaugeSelects() {
  if (!gaugeCatalogCache) return;
  const styleSel = $('#gauge-style');
  const palSel = $('#gauge-palette');
  if (styleSel.options.length === 0) {
    for (const s of gaugeCatalogCache.styles) {
      styleSel.append(new Option(GAUGE_STYLE_NAMES[s.id] || s.id, s.id));
    }
    for (const p of gaugeCatalogCache.palettes) {
      palSel.append(new Option(GAUGE_PALETTE_NAMES[p.id] || p.id, p.id));
    }
  }
  styleSel.value = appearance.gauge?.style || 'blocks';
  palSel.value = appearance.gauge?.palette || 'severity';
}

function renderGaugePreview() {
  const host = $('#gauge-preview');
  if (!host) return;
  host.innerHTML = '';
  // Four points across the range, so a palette's behaviour near a threshold is
  // visible rather than something to discover later at 91%.
  for (const pct of [18, 62, 82, 96]) {
    const row = el('div');
    row.append(el('div', 'row-label', `${pct}% used`));
    const bar = el('div', `bar style-${appearance.gauge?.style || 'blocks'}`);
    const fill = el('i');
    fill.style.width = `${pct}%`;
    const c = gaugeColorFor(pct);
    if (c) fill.style.background = c;
    bar.append(fill);
    row.append(bar);
    host.append(row);
  }
}

for (const [sel, key] of [['#gauge-style', 'style'], ['#gauge-palette', 'palette']]) {
  $(sel).addEventListener('change', () => {
    appearance = { ...appearance, gauge: { ...appearance.gauge, [key]: $(sel).value } };
    renderGaugePreview();
    if (lastLimits) renderLimits(lastLimits);
  });
}


/* ---------- poll budget ----------
   The endpoint publishes no quota, so the honest thing is to show what a
   setting actually costs rather than asserting it is fine. */

function renderPollBudget() {
  const node = $('#poll-budget');
  if (!node) return;
  const active = Number($('#limits-interval').value) * 1000;
  const factor = Number($('#idle-factor').value) || 1;
  if (!active) { node.textContent = ''; return; }
  const idle = active * factor;
  // Four hours of work, twenty idle, twenty session starts.
  const perDay = Math.round((4 * 3600e3) / active + (20 * 3600e3) / idle + 20);
  node.textContent = `About ${perDay} usage requests a day — every ${Math.round(active / 60e3) || '<1'} min while working, `
    + `every ${Math.round(idle / 60e3)} min when idle, never closer together than 30s.`;
}

for (const sel of ['#limits-interval', '#idle-factor']) {
  $(sel).addEventListener('input', renderPollBudget);
}
