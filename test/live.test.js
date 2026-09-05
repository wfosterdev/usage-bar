import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchLimits } from '../src/core/limits.js';
import { SAMPLE_PAYLOAD } from './helpers/fake-usage.js';

/**
 * The one test that talks to the real usage endpoint.
 *
 * Everything else runs against test/helpers/fake-usage.js. That keeps the suite
 * fast, offline and — the reason this split exists — stops a test run from
 * spending an account's rate limit budget. But a fixture can only ever prove we
 * are consistent with ourselves, so exactly one test checks that the shape we
 * normalise is still the shape the endpoint sends.
 *
 * Off by default. Run it deliberately:
 *   USAGE_BAR_LIVE=1 node --test test/live.test.js
 *
 * It makes a single request. Do not put it in a loop, and do not add a second
 * live test — add to this one instead.
 */
const LIVE = process.env.USAGE_BAR_LIVE === '1';
const why = 'set USAGE_BAR_LIVE=1 to check the real endpoint (makes one request)';

test('the live usage endpoint still matches the shape we normalise', { skip: !LIVE && why }, async () => {
  const res = await fetchLimits({ timeoutMs: 20000 });

  if (!res.ok && res.reason === 'rate-limited') {
    // Failing the suite for this would be perverse: it is the very condition
    // the offline fixture exists to avoid provoking.
    assert.ok(true, 'rate limited — the backoff path is what protects us here');
    return;
  }
  assert.equal(res.ok, true, `live fetch failed: ${res.reason} — ${res.message}`);

  assert.ok(Array.isArray(res.limits) && res.limits.length > 0, 'limits[] is gone or empty');

  const session = res.limits.find((l) => l.group === 'session');
  assert.ok(session, 'no limit in the "session" group — the glance depends on this');
  assert.equal(typeof session.percent, 'number');
  assert.ok(session.percent >= 0 && session.percent <= 100, `percent out of range: ${session.percent}`);
  assert.equal(session.label, 'Session (5h)');
  assert.ok(session.resetsAt, 'session limit has no reset time');
  assert.ok(!Number.isNaN(Date.parse(session.resetsAt)), 'resetsAt is not a parseable date');

  // Every field the fixture asserts must exist on the real thing too.
  for (const l of res.limits) {
    for (const key of ['kind', 'group', 'label', 'percent', 'severity', 'resetsAt', 'isActive']) {
      assert.ok(key in l, `live limit ${l.kind} is missing ${key}`);
    }
  }

  const liveGroups = new Set(res.limits.map((l) => l.group));
  const fixtureGroups = new Set(SAMPLE_PAYLOAD.limits.map((l) => l.group));
  for (const g of fixtureGroups) {
    assert.ok(liveGroups.has(g), `the fixture models a "${g}" group the endpoint no longer sends`);
  }

  assert.ok(res.extraUsage, 'extra_usage disappeared');
  assert.equal(typeof res.extraUsage.enabled, 'boolean');
});
