import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { costOf, uncachedCostOf, normalizeModel, contextWindowFor, emptyTokens, addTokens, cacheHitRatio } from '../src/core/pricing.js';
import { TailReader, discover, contentToText, proseOf, toolNames } from '../src/core/transcripts.js';
import { newSession, applyLine, summarize, detail, isActive, burnRate, activeSubagents } from '../src/core/sessions.js';
import { normalizeUsage } from '../src/core/limits.js';
import { LimitProjector } from '../src/core/projection.js';
import { ThresholdNotifier } from '../src/core/notify.js';
import { History } from '../src/core/history.js';

const usage = (o = {}) => ({
  input_tokens: 100, output_tokens: 50,
  cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000,
  cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 },
  ...o,
});

const assistant = (o = {}) => ({
  type: 'assistant', timestamp: '2026-09-05T01:00:00.000Z', sessionId: 's1',
  message: { model: 'claude-opus-5', stop_reason: 'end_turn', usage: usage(), content: [{ type: 'text', text: 'hi' }] },
  ...o,
});

/* ---------- pricing ---------- */

test('cost applies the documented cache multipliers', () => {
  // opus-5: $5/MTok in, $25/MTok out. write5m = 1.25x in, read = 0.1x in.
  const c = costOf('claude-opus-5', usage());
  const expected = (100 * 5 + 50 * 25 + 1000 * 5 * 1.25 + 10000 * 5 * 0.1) / 1e6;
  assert.equal(c.toFixed(9), expected.toFixed(9));
});

test('1h cache writes cost double the input rate', () => {
  const u = usage({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } });
  const c = costOf('claude-opus-5', u);
  const expected = (100 * 5 + 50 * 25 + 1000 * 5 * 2 + 10000 * 5 * 0.1) / 1e6;
  assert.equal(c.toFixed(9), expected.toFixed(9));
});

test('a usage block without the 5m/1h split falls back to the flat total', () => {
  const u = usage({ cache_creation: undefined });
  assert.ok(costOf('claude-opus-5', u) > 0);
  assert.equal(costOf('claude-opus-5', u), costOf('claude-opus-5', usage()));
});

test('synthetic and missing models cost nothing', () => {
  assert.equal(costOf('<synthetic>', usage()), 0);
  assert.equal(costOf(null, usage()), 0);
  assert.equal(normalizeModel('<synthetic>'), null);
});

test('the [1m] context suffix resolves to the base model', () => {
  assert.equal(normalizeModel('claude-opus-5[1m]'), 'claude-opus-5');
  assert.equal(costOf('claude-opus-5[1m]', usage()), costOf('claude-opus-5', usage()));
});

test('uncached cost exceeds cached cost by the cache read discount', () => {
  const cached = costOf('claude-opus-5', usage());
  const raw = uncachedCostOf('claude-opus-5', usage());
  assert.equal((raw - cached).toFixed(9), ((10000 * 5 * 0.9) / 1e6).toFixed(9));
});

test('haiku has a 200K window, opus 1M', () => {
  assert.equal(contextWindowFor('claude-haiku-4-5'), 200_000);
  assert.equal(contextWindowFor('claude-opus-5'), 1_000_000);
});

test('cache hit ratio is reads over readable input', () => {
  const t = addTokens(emptyTokens(), usage());
  assert.equal(cacheHitRatio(t).toFixed(4), (10000 / 10100).toFixed(4));
  assert.equal(cacheHitRatio(emptyTokens()), 0);
});

/* ---------- transcripts ---------- */

test('TailReader returns only appended lines and survives a partial trailing line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ub-'));
  const f = join(dir, 't.jsonl');
  await writeFile(f, `${JSON.stringify({ a: 1 })}\n`);
  const r = new TailReader();

  assert.equal((await r.read(f)).lines.length, 1);
  assert.equal((await r.read(f)).lines.length, 0);

  // Writer is mid-line: the fragment must be withheld, not parsed as garbage.
  await appendFile(f, '{"a":2}\n{"a":3');
  const second = await r.read(f);
  assert.equal(second.lines.length, 1);
  assert.deepEqual(second.lines[0], { a: 2 });

  await appendFile(f, '}\n');
  const third = await r.read(f);
  assert.deepEqual(third.lines[0], { a: 3 });
});

test('TailReader signals a reset when the file shrinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ub-'));
  const f = join(dir, 't.jsonl');
  await writeFile(f, `${JSON.stringify({ a: 1 })}\n${JSON.stringify({ a: 2 })}\n`);
  const r = new TailReader();
  await r.read(f);
  await writeFile(f, `${JSON.stringify({ a: 9 })}\n`);
  const res = await r.read(f);
  assert.equal(res.reset, true);
  assert.deepEqual(res.lines[0], { a: 9 });
});

test('malformed lines are skipped, not fatal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ub-'));
  const f = join(dir, 't.jsonl');
  await writeFile(f, `{"a":1}\nNOT JSON\n{"a":2}\n`);
  const lines = (await new TailReader().read(f)).lines;
  assert.deepEqual(lines, [{ a: 1 }, { a: 2 }]);
});

test('discover finds sessions and their subagents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ub-'));
  const proj = join(root, '-Users-me-code');
  const sid = '61b249e2-657b-470f-9e42-9cd2d25eb2ef';
  await mkdir(join(proj, sid, 'subagents'), { recursive: true });
  await writeFile(join(proj, `${sid}.jsonl`), '');
  await writeFile(join(proj, sid, 'subagents', 'agent-abc123.jsonl'), '');

  const found = await discover(root);
  assert.equal(found.length, 2);
  const sub = found.find((f) => f.kind === 'subagent');
  assert.equal(sub.agentId, 'abc123');
  assert.equal(sub.sessionId, sid);
});

test('content blocks flatten to display text and tool names', () => {
  const content = [
    { type: 'thinking', thinking: 'x' },
    { type: 'text', text: 'hello' },
    { type: 'tool_use', name: 'Bash', input: {} },
  ];
  assert.equal(contentToText(content), '[thinking]\nhello\n[tool: Bash]');
  assert.deepEqual(toolNames(content), ['Bash']);
  assert.equal(contentToText('plain string'), 'plain string');
});

test('proseOf keeps only human-readable text', () => {
  const content = [
    { type: 'thinking', thinking: 'internal' },
    { type: 'text', text: 'Here is the answer.' },
    { type: 'tool_use', name: 'Bash', input: {} },
  ];
  assert.equal(proseOf(content), 'Here is the answer.');
  // A turn that is nothing but tool calls has no prose at all.
  assert.equal(proseOf([{ type: 'tool_use', name: 'Bash' }]), '');
  assert.equal(proseOf([{ type: 'tool_result', content: 'x' }]), '');
});

/* ---------- session aggregation ---------- */

test('assistant messages accumulate cost, tokens and context fill', () => {
  const s = newSession('s1', '-Users-me-code');
  applyLine(s, assistant());
  applyLine(s, assistant());
  assert.equal(s.assistantMessages, 2);
  assert.equal(s.cost.toFixed(6), (costOf('claude-opus-5', usage()) * 2).toFixed(6));
  // Context is the last request's size, not a running sum.
  assert.equal(s.context.tokens, 100 + 10000 + 1000);
  assert.equal(s.context.window, 1_000_000);
});

test('synthetic assistant messages never move cost or the model display', () => {
  const s = newSession('s1', 'p');
  applyLine(s, assistant());
  const before = s.cost;
  applyLine(s, assistant({ message: { model: '<synthetic>', usage: usage(), content: [] } }));
  assert.equal(s.cost, before);
  assert.equal(s.currentModel, 'claude-opus-5');
});

test('subagent usage rolls into session totals but keeps its own record', () => {
  const s = newSession('s1', 'p');
  applyLine(s, assistant());
  applyLine(s, assistant({ attributionAgent: 'l4-backend-engineer' }), { isSubagent: true, agentId: 'a1' });
  assert.equal(s.subagents.size, 1);
  assert.equal(s.subagents.get('a1').agentType, 'l4-backend-engineer');
  assert.equal(s.cost.toFixed(6), (costOf('claude-opus-5', usage()) * 2).toFixed(6));
  // A subagent must not overwrite the main conversation's context gauge.
  assert.equal(s.context.tokens, 11100);
});

test('an async launch registers a subagent before it has written anything', () => {
  const s = newSession('s1', 'p');
  applyLine(s, {
    type: 'user', timestamp: '2026-09-05T01:00:00.000Z',
    toolUseResult: {
      isAsync: true, status: 'async_launched', agentId: 'a1',
      description: 'Map the L4 tier', resolvedModel: 'claude-opus-5',
    },
  });
  const sub = s.subagents.get('a1');
  assert.equal(s.subagents.size, 1);
  assert.equal(sub.description, 'Map the L4 tier');
  assert.equal(sub.model, 'claude-opus-5');
  assert.equal(sub.calls, 0);
  assert.equal(sub.cost, 0);
  assert.equal(activeSubagents(s, Date.parse('2026-09-05T01:01:00.000Z')), 1);
});

test('a subagent seen before its launch record keeps the earlier start', () => {
  const s = newSession('s1', 'p');
  applyLine(s, assistant({ timestamp: '2026-09-05T01:05:00.000Z' }), { isSubagent: true, agentId: 'a1' });
  applyLine(s, {
    type: 'user', timestamp: '2026-09-05T01:00:00.000Z',
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1', description: 'Audit', resolvedModel: 'claude-opus-5' },
  });
  const sub = s.subagents.get('a1');
  assert.equal(s.subagents.size, 1);
  assert.equal(sub.firstTs, '2026-09-05T01:00:00.000Z');
  assert.equal(sub.lastTs, '2026-09-05T01:05:00.000Z');
  assert.equal(sub.description, 'Audit');
});

test('running subagents make a session busy even when the parent has stopped', () => {
  const s = newSession('s1', 'p');
  // Parent dispatches two agents and ends its own turn.
  applyLine(s, assistant({ message: { ...assistant().message, stop_reason: 'end_turn' } }));
  for (const [id, ts] of [['a1', '2026-09-05T01:00:10.000Z'], ['a2', '2026-09-05T01:00:20.000Z']]) {
    applyLine(s, assistant({ timestamp: ts }), { isSubagent: true, agentId: id });
  }
  const now = Date.parse('2026-09-05T01:01:00.000Z');
  const live = summarize(s, now);
  assert.equal(live.lastStopReason, 'end_turn');
  assert.equal(live.subagentActiveCount, 2);
  assert.equal(live.busy, true);

  // An hour on, nothing is running and the count reads zero of two.
  const later = Date.parse('2026-09-05T02:01:00.000Z');
  const cold = summarize(s, later);
  assert.equal(cold.active, false);
  assert.equal(cold.busy, false);
  assert.equal(cold.subagentActiveCount, 0);
  assert.equal(cold.subagentCount, 2);
  assert.equal(detail(s, later).subagents.every((x) => x.active === false), true);
});

test('skill and agent attribution are tracked separately', () => {
  const s = newSession('s1', 'p');
  applyLine(s, assistant({ attributionSkill: 'ol-l4-execute', attributionAgent: 'l4-tech-lead' }));
  const d = detail(s);
  assert.equal(d.perSkill[0].key, 'ol-l4-execute');
  assert.equal(d.perAgent[0].key, 'l4-tech-lead');
});

test('compaction metadata is captured with its dropped-token cost', () => {
  const s = newSession('s1', 'p');
  applyLine(s, assistant({
    compactMetadata: { trigger: 'auto', preTokens: 367349, postTokens: 15846, cumulativeDroppedTokens: 351503, durationMs: 177331 },
  }));
  const sum = summarize(s);
  assert.equal(sum.compactionCount, 1);
  assert.equal(sum.droppedTokens, 351503);
  assert.equal(sum.compactionMs, 177331);
});

test('api errors and tool denials are recorded', () => {
  const s = newSession('s1', 'p');
  applyLine(s, assistant({ isApiErrorMessage: true, apiErrorStatus: 429 }));
  applyLine(s, { type: 'user', timestamp: '2026-09-05T01:00:00.000Z', toolDenialKind: 'user_reject' });
  assert.equal(s.errors[0].status, 429);
  assert.equal(s.denials[0].kind, 'user_reject');
});

test('tool-only turns stay out of the message list but keep their tool names', () => {
  const s = newSession('s1', 'p');
  applyLine(s, assistant({
    message: { model: 'claude-opus-5', stop_reason: 'tool_use', usage: usage(),
               content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
  }));
  assert.equal(s.messages.length, 0);
  assert.deepEqual(s.activeTools, ['Bash']);
  assert.equal(s.toolCalls, 1);

  applyLine(s, assistant({
    message: { model: 'claude-opus-5', stop_reason: 'tool_use', usage: usage(),
               content: [{ type: 'text', text: 'Running it now.' }, { type: 'tool_use', name: 'Read' }] },
  }));
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].text, 'Running it now.');
  assert.deepEqual(s.messages[0].tools, ['Read']);
});

test('ai-title becomes the session name', () => {
  const s = newSession('s1', 'p');
  applyLine(s, { type: 'ai-title', aiTitle: 'Fixing the parser' });
  assert.equal(s.title, 'Fixing the parser');
});

test('activity is judged on the idle window', () => {
  const now = Date.parse('2026-09-05T01:00:00.000Z');
  const s = newSession('s1', 'p');
  applyLine(s, assistant());
  assert.equal(isActive(s, now + 60_000), true);
  assert.equal(isActive(s, now + 10 * 60_000), false);
});

test('burn rate only counts the trailing window', () => {
  const s = newSession('s1', 'p');
  applyLine(s, assistant({ timestamp: '2026-09-05T00:00:00.000Z' }));
  applyLine(s, assistant({ timestamp: '2026-09-05T01:00:00.000Z' }));
  const now = Date.parse('2026-09-05T01:01:00.000Z');
  const r = burnRate(s, now, 10);
  assert.equal(r.windowCost.toFixed(6), costOf('claude-opus-5', usage()).toFixed(6));
});

/* ---------- limits ---------- */

test('usage payload normalises off the generic limits array', () => {
  const n = normalizeUsage({
    limits: [
      { kind: 'session', group: 'session', percent: 21, severity: 'normal', resets_at: 'X', is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 4, severity: 'normal', resets_at: 'Y', is_active: false,
        scope: { model: { display_name: 'Opus' } } },
    ],
    extra_usage: { is_enabled: false },
    some_unreleased_field: { utilization: 99 },
  });
  assert.equal(n.limits.length, 2);
  assert.equal(n.primary.label, 'Session (5h)');
  assert.equal(n.limits[1].label, 'Weekly · Opus');
  // Unknown top-level keys must not leak into the rendered set.
  assert.equal(n.limits.some((l) => l.percent === 99), false);
});

test('an empty limits array normalises to no rows rather than throwing', () => {
  const n = normalizeUsage({});
  assert.deepEqual(n.limits, []);
  assert.equal(n.primary, null);
});

/* ---------- projection ---------- */

test('projection extrapolates a rising percentage to exhaustion', () => {
  const p = new LimitProjector({ minSamples: 3 });
  const t0 = Date.now();
  // Realistic cadence: a 60s poll rising at 10%/h, sampled across 40 minutes.
  let last = 0;
  for (let i = 0; i <= 40; i++) {
    last = 20 + (i / 60) * 10;
    p.sample([{ kind: 'session', percent: last, resetsAt: null, scope: null }], t0 + i * 60_000);
  }
  const now = t0 + 40 * 60_000;
  const res = p.project({ kind: 'session', percent: last, resetsAt: null, scope: null }, now);
  assert.ok(Math.abs(res.percentPerHour - 10) < 0.01, `got ${res.percentPerHour}`);
  // (100 - 26.67) remaining at 10%/h => ~440 minutes.
  assert.ok(Math.abs(res.minutesToExhaust - ((100 - last) / 10) * 60) < 1);
});

test('samples older than the projector window are discarded', () => {
  const p = new LimitProjector({ windowMs: 45 * 60_000, minSamples: 3 });
  const t0 = Date.now();
  // Three samples spaced an hour apart: only the newest survives the window.
  for (let i = 0; i < 3; i++) {
    p.sample([{ kind: 'session', percent: 10 + i * 10, resetsAt: null, scope: null }], t0 + i * 3600_000);
  }
  assert.equal(p.project({ kind: 'session', percent: 30, resetsAt: null, scope: null }), null);
});

test('a limit that resets before exhausting is flagged as safe', () => {
  const p = new LimitProjector({ minSamples: 3 });
  const t0 = Date.now();
  const resetsAt = new Date(t0 + 30 * 60_000).toISOString();
  let last = 0;
  for (let i = 0; i <= 20; i++) {
    last = 10 + (i / 60) * 6;              // 6%/h — nowhere near 100% in 30 min
    p.sample([{ kind: 'session', percent: last, resetsAt, scope: null }], t0 + i * 60_000);
  }
  const res = p.project({ kind: 'session', percent: last, resetsAt, scope: null }, t0 + 20 * 60_000);
  assert.equal(res.beatsReset, true);
});

test('a flat percentage projects no exhaustion', () => {
  const p = new LimitProjector({ minSamples: 3 });
  const t0 = Date.now();
  for (let i = 0; i < 4; i++) p.sample([{ kind: 'session', percent: 40, resetsAt: null, scope: null }], t0 + i * 60_000);
  const res = p.project({ kind: 'session', percent: 40, resetsAt: null, scope: null }, t0);
  assert.equal(res.minutesToExhaust, null);
  assert.equal(res.beatsReset, true);
});

test('a new reset window discards the previous window samples', () => {
  const p = new LimitProjector({ minSamples: 3 });
  const t0 = Date.now();
  for (let i = 0; i < 4; i++) p.sample([{ kind: 'session', percent: 20 + i * 10, resetsAt: 'A', scope: null }], t0 + i * 3600_000);
  p.sample([{ kind: 'session', percent: 1, resetsAt: 'B', scope: null }], t0 + 5 * 3600_000);
  assert.equal(p.project({ kind: 'session', percent: 1, resetsAt: 'B', scope: null }), null);
});

/* ---------- notifier ---------- */

test('each threshold fires once per reset window', () => {
  const fired = [];
  const n = new ThresholdNotifier({ thresholds: [50, 75], deliver: () => {}, onEvent: (e) => fired.push(e.threshold) });
  const at = (percent, resetsAt = 'A') => [{ kind: 'session', percent, resetsAt, label: 'Session (5h)', scope: null }];

  n.check(at(60));
  n.check(at(65));           // still one side of 75 — no new alert
  n.check(at(80));
  assert.deepEqual(fired, [50, 75]);
  fired.length = 0;

  n.check(at(90));           // both already fired this window
  assert.deepEqual(fired, []);

  n.check(at(60, 'B'));      // window rolled over — 50 re-arms
  assert.deepEqual(fired, [50]);
});

test('a jump past several thresholds is one alert, not one each', () => {
  const fired = [];
  const n = new ThresholdNotifier({ thresholds: [50, 75, 90, 95], deliver: () => {}, onEvent: (e) => fired.push(e.threshold) });
  const at = (percent) => [{ kind: 'session', percent, resetsAt: 'A', label: 'Session (5h)', scope: null }];

  n.check(at(40));
  n.check(at(92));           // crossed 50, 75 and 90 at once
  assert.deepEqual(fired, [90]);
  n.check(at(96));           // the skipped ones stay armed
  assert.deepEqual(fired, [90, 95]);
});

test('limits sharing a kind keep separate state', () => {
  const fired = [];
  const n = new ThresholdNotifier({ thresholds: [50], deliver: () => {}, onEvent: (e) => fired.push(e.label) });
  // Same kind, no model — the old key collided these, and their differing
  // reset times then re-armed each other on every single poll.
  const limits = [
    { kind: 'weekly_scoped', percent: 10, resetsAt: '2026-09-08T00:00:00Z', label: 'Weekly · code', scope: { surface: 'code' } },
    { kind: 'weekly_scoped', percent: 80, resetsAt: '2026-09-12T00:00:00Z', label: 'Weekly · api', scope: { surface: 'api' } },
  ];
  n.check(limits);
  n.check(limits);
  n.check(limits);
  assert.deepEqual(fired, ['Weekly · api']);
});

test('a stale reading of an older window does not re-arm', () => {
  const fired = [];
  const n = new ThresholdNotifier({ thresholds: [50], deliver: () => {}, onEvent: (e) => fired.push(e.threshold) });
  const at = (resetsAt) => [{ kind: 'session', percent: 60, resetsAt, label: 'Session (5h)', scope: null }];

  n.check(at('2026-09-05T12:00:00Z'));
  n.check(at('2026-09-05T07:00:00Z'));   // out of order — not a rollover
  assert.deepEqual(fired, [50]);
  n.check(at('2026-09-05T17:00:00Z'));   // genuinely later — re-arms
  assert.deepEqual(fired, [50, 50]);
});

test('the quiet period rations pings but never swallows an escalation', () => {
  const pings = [];
  let clock = 0;
  const n = new ThresholdNotifier({
    thresholds: [50, 75, 90],
    cooldownMs: 15 * 60 * 1000,
    deliver: (title) => pings.push(title),
    now: () => clock,
  });
  const at = (percent) => [{ kind: 'session', percent, resetsAt: 'A', label: 'Session (5h)', scope: null }];

  n.check(at(55));
  assert.equal(pings.length, 1);

  clock += 60 * 1000;
  n.check(at(76));                    // inside the quiet period
  assert.equal(pings.length, 1);

  clock += 60 * 1000;
  n.check(at(91));                    // still quiet, but 90 is the last rung
  assert.equal(pings.length, 2);

  clock += 20 * 60 * 1000;            // quiet period has passed
  n.check([{ kind: 'session', percent: 55, resetsAt: 'B', label: 'Session (5h)', scope: null }]);
  assert.equal(pings.length, 3);
});

test('limits crossing together are one combined ping', () => {
  const pings = [];
  const n = new ThresholdNotifier({ thresholds: [50], deliver: (title, body) => pings.push({ title, body }) });
  const events = n.check([
    { kind: 'session', percent: 60, resetsAt: 'A', label: 'Session (5h)', scope: null },
    { kind: 'weekly_all', percent: 70, resetsAt: 'B', label: 'Weekly (all models)', scope: null },
  ]);

  assert.equal(events.length, 2, 'both crossings are still recorded');
  assert.equal(pings.length, 1, 'but only one notification is shown');
  assert.match(pings[0].title, /2 limits past 50%/);
  assert.match(pings[0].body, /Session \(5h\) 60%/);
  assert.match(pings[0].body, /Weekly \(all models\) 70%/);
});

test('priming suppresses alerts for thresholds already crossed at startup', () => {
  const fired = [];
  const n = new ThresholdNotifier({ thresholds: [50, 75, 90], deliver: () => {}, onEvent: (e) => fired.push(e.threshold) });
  const limits = [{ kind: 'session', percent: 80, resetsAt: 'A', label: 'Session (5h)', scope: null }];
  n.prime(limits);
  n.check(limits);
  assert.deepEqual(fired, []);
  n.check([{ ...limits[0], percent: 95 }]);
  assert.deepEqual(fired, [90]);
});

/* ---------- history ---------- */

test('history rolls up by day and by dimension', () => {
  const h = new History();
  h.record({ ts: '2026-09-04T10:00:00Z', project: 'p1', model: 'claude-opus-5', skill: 'ol-l4-execute', cost: 2, usage: usage() });
  h.record({ ts: '2026-09-04T11:00:00Z', project: 'p1', model: 'claude-sonnet-5', skill: null, cost: 1, usage: usage() });
  h.record({ ts: '2026-09-05T10:00:00Z', project: 'p2', model: 'claude-opus-5', skill: 'ol-l4-execute', cost: 4, usage: usage() });

  const series = h.series('day');
  assert.equal(series.length, 2);
  assert.equal(series[0].cost, 3);
  assert.equal(series[1].cost, 4);

  const t = h.totals(30);
  assert.equal(t.cost, 7);
  assert.equal(t.byProject[0].key, 'p2');
  assert.equal(t.bySkill[0].key, 'ol-l4-execute');
  assert.equal(t.bySkill[0].cost, 6);
  // A null skill is not a bucket.
  assert.equal(t.bySkill.some((r) => r.key === 'null'), false);
});

/* The glance tracks ONE limit. It looked like it was summing session+weekly
   because 43+8+6 and 100-43 both happen to be 57 — pin the arithmetic so the
   next person does not have to rule that out by hand. */
test('the glance reflects one limit and never aggregates them', async () => {
  const { menubarView } = await import('../src/server/index.js');
  const { DEFAULTS } = await import('../src/core/config.js');

  const limits = [
    { kind: 'session', group: 'session', label: 'Session (5h)', percent: 43, severity: 'normal', resetsAt: null },
    { kind: 'weekly_all', group: 'weekly', label: 'Weekly (all models)', percent: 8, severity: 'normal', resetsAt: null },
    { kind: 'weekly_scoped', group: 'weekly', label: 'Weekly · Fable', percent: 6, severity: 'normal', resetsAt: null },
  ];
  const stub = (appearance) => ({
    config: { ...DEFAULTS, appearance: { ...DEFAULTS.appearance, ...appearance } },
    limitsView: () => ({ ok: true, limits }),
    snapshot: () => ({ active: [], totals: { activeCost: 0, activeCostPerMin: 0 } }),
  });

  const remaining = menubarView(stub({ metric: 'remaining', scope: 'session' })).glance;
  assert.equal(remaining.used, 43, 'used must be the session limit alone');
  assert.equal(remaining.remaining, 57);
  assert.equal(remaining.display, 57);
  assert.equal(remaining.suffix, 'left', 'the number is meaningless without its unit');

  const used = menubarView(stub({ metric: 'used', scope: 'session' })).glance;
  assert.equal(used.display, 43);
  assert.equal(used.suffix, 'used');

  // 'worst' picks the highest single limit, it does not add them up.
  const worst = menubarView(stub({ metric: 'used', scope: 'worst' })).glance;
  assert.equal(worst.display, 43, 'worst is the max of the limits, never their sum');
  assert.notEqual(worst.display, 43 + 8 + 6);
});
