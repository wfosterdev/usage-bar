import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/core/store.js';
import { DEFAULTS } from '../src/core/config.js';
import { parseRetryAfter, normalizeUsage } from '../src/core/limits.js';
import {
  SAMPLE_PAYLOAD, fakeLimitsResult, scriptedLimits, rateLimited, fakeProfile, offlineDeps,
} from './helpers/fake-usage.js';

const cfg = { ...DEFAULTS, notify: false };

test('Retry-After is honoured in both of the forms servers send it', () => {
  assert.equal(parseRetryAfter('30'), 30000);
  assert.equal(parseRetryAfter('0'), 0);
  const inAMinute = new Date(Date.now() + 60000).toUTCString();
  const parsed = parseRetryAfter(inAMinute);
  assert.ok(parsed > 55000 && parsed <= 60000, `date form gave ${parsed}`);
  // Nonsense must not become a zero-length backoff, which would hammer harder.
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter(null), null);
});

test('a 429 keeps the last good reading instead of blanking the UI', async () => {
  const store = new Store(cfg, offlineDeps({
    fetchLimits: scriptedLimits(fakeLimitsResult(), rateLimited(30000)),
  }));

  await store.refreshLimits();
  const good = store.limitsView();
  assert.equal(good.ok, true);
  assert.equal(good.limits.find((l) => l.group === 'session').percent, 43);
  assert.ok(!good.stale);

  // Simulate the wait: both the backoff window and the request floor elapse.
  store.nextLimitsAt = 0;
  store.lastLimitsAttemptAt = 0;
  await store.refreshLimits({ force: true });

  const after = store.limitsView();
  assert.equal(after.ok, true, 'a transient 429 must not throw away usable data');
  assert.equal(after.limits.find((l) => l.group === 'session').percent, 43);
  assert.equal(after.stale, true, 'but it must admit the reading is not fresh');
  assert.equal(after.staleReason, 'rate-limited');
  assert.ok(after.retryAt, 'and say when it will try again');
});

test('backoff grows with repeated failures and never exceeds the cap', async () => {
  const store = new Store(cfg, offlineDeps({ fetchLimits: scriptedLimits(rateLimited()) }));

  const waits = [];
  for (let i = 0; i < 10; i += 1) {
    store.nextLimitsAt = 0;
    store.lastLimitsAttemptAt = 0;   // each iteration stands for a later attempt
    await store.refreshLimits({ force: true });
    waits.push(store.limitsBackoffMs);
  }

  assert.ok(waits[1] > waits[0], `backoff did not grow: ${waits.join(', ')}`);
  for (const w of waits) assert.ok(w <= Store.MAX_BACKOFF_MS, `${w}ms exceeds the cap`);
  assert.equal(waits.at(-1), Store.MAX_BACKOFF_MS, 'it should settle at the cap, not keep doubling');
  // Monotonic up to the cap, flat after — never decreasing, never overshooting.
  for (let i = 1; i < waits.length; i += 1) {
    assert.ok(waits[i] >= waits[i - 1], `backoff went backwards: ${waits.join(', ')}`);
  }
});

test('a server-specified Retry-After wins when it is longer than our guess', async () => {
  const long = 25 * 60 * 1000;
  const store = new Store(cfg, offlineDeps({ fetchLimits: scriptedLimits(rateLimited(long)) }));
  await store.refreshLimits({ force: true });
  assert.equal(store.limitsBackoffMs, long, 'the server told us how long; that beats our arithmetic');
  assert.ok(long > Store.MAX_BACKOFF_MS,
    'this test is only meaningful if the instruction exceeds our own cap');
});

test('the backoff window actually suppresses requests', async () => {
  const fetcher = scriptedLimits(rateLimited(60000));
  const store = new Store(cfg, offlineDeps({ fetchLimits: fetcher }));

  await store.refreshLimits({ force: true });
  assert.equal(fetcher.calls, 1);

  // Neither a scheduled poll nor an explicit refresh may ignore a 429.
  await store.refreshLimits();
  await store.refreshLimits({ force: true });
  assert.equal(fetcher.calls, 1, 'a rate-limit backoff must hold against every caller');

  assert.ok(store.nextLimitsDelay() > 1000, 'the next poll must be pushed out');
});

test('overlapping refreshes collapse into one request', async () => {
  let resolve;
  let calls = 0;
  const fetchLimits = () => {
    calls += 1;
    return new Promise((r) => { resolve = r; });
  };
  const store = new Store(cfg, offlineDeps({ fetchLimits }));

  const a = store.refreshLimits();
  const b = store.refreshLimits();
  const c = store.refreshLimits({ force: true });
  assert.equal(calls, 1, 'three callers, one request');

  resolve(fakeLimitsResult());
  await Promise.all([a, b, c]);
  assert.equal(store.limitsView().ok, true);
});

test('a success clears the backoff completely', async () => {
  const store = new Store(cfg, offlineDeps({
    fetchLimits: scriptedLimits(rateLimited(60000), fakeLimitsResult()),
  }));

  await store.refreshLimits({ force: true });
  assert.ok(store.limitsBackoffMs > 0);
  assert.ok(store.nextLimitsAt > Date.now());

  // Only the attempt floor is waived here; the deadline must be cleared by the
  // success itself, not by the test tidying up after it.
  store.lastLimitsAttemptAt = 0;
  await store.refreshLimits({ force: true, override: true });
  assert.equal(store.limitsBackoffMs, 0);
  assert.equal(store.nextLimitsAt, 0);
  assert.equal(store.limitsError, null);
  assert.ok(!store.limitsView().stale, 'a fresh reading is not stale');
});

test('polling slows down when there is nothing to watch', async () => {
  const store = new Store(cfg, offlineDeps());
  // No sessions at all, so nothing can be moving the limit.
  const idle = store.nextLimitsDelay();
  assert.equal(idle, cfg.limitsIntervalMs * cfg.idleLimitsFactor,
    'an idle machine should not poll at the active rate');
  // The backoff cap must not leak into normal pacing — they are separate ideas.
  assert.ok(idle <= Store.MAX_IDLE_MS);
});

test('the fixture normalises to exactly what the real endpoint would', () => {
  // Guards the fixture itself: if it drifts from the real schema, every test
  // built on it is testing the wrong shape.
  const normalized = normalizeUsage(SAMPLE_PAYLOAD);
  assert.equal(normalized.limits.length, 3);
  assert.equal(normalized.primary.group, 'session');
  assert.equal(normalized.primary.percent, 43);
  assert.equal(normalized.weekly.length, 2);
  assert.equal(normalized.limits[0].label, 'Session (5h)');
  assert.equal(normalized.limits[2].label, 'Weekly · Fable');
  assert.equal(normalized.extraUsage.enabled, false);

  const fake = fakeLimitsResult();
  assert.deepEqual(
    fake.limits.map((l) => [l.group, l.percent, l.label]),
    normalized.limits.map((l) => [l.group, l.percent, l.label]),
    'the fixture result and the real normaliser disagree',
  );
});

test('the profile fixture matches what the store expects', async () => {
  const store = new Store(cfg, offlineDeps({ fetchProfile: fakeProfile }));
  await store.start();
  assert.equal(store.profile.plan, 'max');
  store.stop();
});

test('a stale reading reaches the menu bar as data, not as an error', async () => {
  const { menubarView } = await import('../src/server/index.js');
  const store = new Store(cfg, offlineDeps({
    fetchLimits: scriptedLimits(fakeLimitsResult(), rateLimited(120000)),
  }));

  await store.refreshLimits();
  const fresh = menubarView(store);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.glance.known, true);
  assert.equal(fresh.glance.used, 43);

  store.nextLimitsAt = 0;
  store.lastLimitsAttemptAt = 0;
  await store.refreshLimits({ force: true });

  const held = menubarView(store);
  assert.equal(held.ok, true, 'ok must stay true — the numbers below are real');
  assert.equal(held.message, null, 'no error message: nothing is broken');
  assert.equal(held.stale, true);
  assert.match(held.staleMessage, /rate limit/i);
  assert.ok(held.retryAt);
  // The glance must keep working: this is the entire point of holding the data.
  assert.equal(held.glance.known, true);
  assert.equal(held.glance.used, 43);
  assert.equal(held.glance.display, 57);
});

test('a useless retry-after does not become a zero-length backoff', async () => {
  // Observed in the wild: the endpoint returned HTTP 429 with `retry-after: 0`.
  // Taken literally that says "retry immediately", which would hammer a service
  // that has just asked us to stop. Our own backoff has to win.
  assert.equal(parseRetryAfter('0'), 0, 'zero must parse as zero, not as absent');

  const store = new Store(cfg, offlineDeps({ fetchLimits: scriptedLimits(rateLimited(0)) }));
  await store.refreshLimits({ force: true });
  assert.ok(store.limitsBackoffMs >= cfg.limitsIntervalMs,
    `retry-after: 0 produced a ${store.limitsBackoffMs}ms backoff`);
});

test('nothing can push requests closer together than the floor', async () => {
  const fetcher = scriptedLimits(fakeLimitsResult());
  const store = new Store(cfg, offlineDeps({ fetchLimits: fetcher }));

  await store.refreshLimits();
  assert.equal(fetcher.calls, 1);

  // Repeated triggers — an activity wake, a scheduled poll — must coalesce.
  for (let i = 0; i < 5; i += 1) await store.refreshLimits();
  assert.equal(fetcher.calls, 1, 'the 30s floor did not hold');

  store.lastLimitsAttemptAt = Date.now() - Store.MIN_SPACING_MS - 1;
  await store.refreshLimits();
  assert.equal(fetcher.calls, 2, 'past the floor it must be allowed through');
});

test('a session going live takes a fresh reading immediately', async () => {
  const fetcher = scriptedLimits(fakeLimitsResult());
  const store = new Store(cfg, offlineDeps({ fetchLimits: fetcher }));
  store.started = true;
  store.lastLimitsAttemptAt = Date.now() - Store.MIN_SPACING_MS - 1;

  // Idle: the poll is deliberately slow, because nothing can be moving.
  const idleDelay = store.nextLimitsDelay();
  assert.equal(idleDelay, cfg.limitsIntervalMs * cfg.idleLimitsFactor);

  // A live session appears between scans.
  store.sessions.set('s1', {
    sessionId: 's1', lastTs: new Date().toISOString(), lastStopReason: 'tool_use',
  });
  assert.equal(store.nextLimitsDelay(), cfg.limitsIntervalMs,
    'work in progress must restore the active cadence');
});

test('a limit rolling over schedules a prompt re-read', async () => {
  const store = new Store(cfg, offlineDeps());
  const justPast = new Date(Date.now() - 60_000).toISOString();

  // A reading taken before a reset that has since happened is known to be wrong
  // — the reset time is exact, so this is a scheduled event, not a guess.
  store.limits = {
    ok: true,
    fetchedAt: new Date(Date.now() - 120_000).toISOString(),
    limits: [{ kind: 'session', group: 'session', percent: 43, resetsAt: justPast }],
  };
  assert.equal(store.nextLimitsDelay(), Store.MIN_SPACING_MS,
    'a rolled-over limit should be re-read promptly, not on the idle schedule');

  // A reading taken after the reset is current; back to normal pacing.
  store.limits.fetchedAt = new Date().toISOString();
  assert.ok(store.nextLimitsDelay() > Store.MIN_SPACING_MS);
});

test('the poll rate is bounded at both ends', () => {
  // Two-sided on purpose. Too eager gets us rate limited by an endpoint that
  // publishes no quota; too lazy makes the number wrong. Neither failure is
  // acceptable, so both are pinned.
  const store = new Store(cfg, offlineDeps());
  const active = cfg.limitsIntervalMs;
  const idle = cfg.limitsIntervalMs * cfg.idleLimitsFactor;

  assert.ok(active >= 60_000, `active poll of ${active}ms is too eager`);
  assert.ok(active <= 300_000, `active poll of ${active}ms is too slow while you are working`);
  // Idle governs only how fast usage from another machine shows up, because a
  // local session starting refreshes immediately.
  assert.ok(idle <= 15 * 60_000, `idle poll of ${idle / 60_000}min is too slow`);
  assert.ok(idle > active, 'idle must be slower than active or the setting is pointless');

  // Four hours of work, twenty idle, twenty session starts — a generous day.
  const perDay = (4 * 3600_000) / active + (20 * 3600_000) / idle + 20;
  assert.ok(perDay < 300, `${Math.round(perDay)} requests/day is too eager`);
  assert.ok(store.nextLimitsDelay() >= Store.MIN_SPACING_MS);
});

test('a user can recover from a backoff that outlived the outage', async () => {
  // The failure this exists for: the endpoint 429s, we back off for minutes,
  // the endpoint recovers, and the app keeps insisting it is rate limited
  // because its own timer has not expired. Waiting it out is not an answer.
  const store = new Store(cfg, offlineDeps({
    fetchLimits: scriptedLimits(rateLimited(10 * 60_000), fakeLimitsResult()),
  }));

  await store.refreshLimits({ force: true });
  assert.equal(store.limitsView().ok, false);
  const backoffEnd = store.nextLimitsAt;
  assert.ok(backoffEnd > Date.now() + 60_000, 'should be sitting on a long backoff');

  // A normal poll, and even a forced one, must respect it.
  store.lastLimitsAttemptAt = 0;
  await store.refreshLimits();
  assert.equal(store.limitsView().ok, false);
  store.lastLimitsAttemptAt = 0;
  await store.refreshLimits({ force: true });
  assert.equal(store.limitsView().ok, false, 'force alone must not defeat a 429 backoff');

  // The explicit override does, and it recovers.
  store.lastLimitsAttemptAt = 0;
  const res = await store.refreshLimits({ force: true, override: true });
  assert.equal(res.ok, true);
  assert.equal(store.limitsView().ok, true);
  assert.equal(store.nextLimitsAt, 0, 'a success must clear the backoff outright');
});

test('the override still cannot be used as a retry loop', async () => {
  const fetcher = scriptedLimits(rateLimited(10 * 60_000));
  const store = new Store(cfg, offlineDeps({ fetchLimits: fetcher }));
  await store.refreshLimits({ force: true });
  assert.equal(fetcher.calls, 1);

  // Click-spam: every one of these is an explicit override.
  for (let i = 0; i < 20; i += 1) await store.refreshLimits({ force: true, override: true });
  assert.equal(fetcher.calls, 1, 'the manual floor must hold against repeated clicking');

  store.lastLimitsAttemptAt = Date.now() - Store.MIN_MANUAL_SPACING_MS - 1;
  await store.refreshLimits({ force: true, override: true });
  assert.equal(fetcher.calls, 2, 'but a genuine second attempt must get through');
});

test('an explicit Retry-After longer than our cap is obeyed in full', async () => {
  // Our cap bounds our own guessing. It must not be used to second-guess an
  // instruction — waiting less than we were told is how a block gets extended.
  const told = 45 * 60_000;
  const store = new Store(cfg, offlineDeps({ fetchLimits: scriptedLimits(rateLimited(told)) }));
  await store.refreshLimits({ force: true });
  assert.equal(store.limitsBackoffMs, told);
  assert.ok(told > Store.MAX_BACKOFF_MS);
  // The idle pace is a separate concern and must not inherit the backoff cap.
  assert.notEqual(Store.MAX_IDLE_MS, Store.MAX_BACKOFF_MS);
});
