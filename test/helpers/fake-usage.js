/**
 * A stand-in for https://api.anthropic.com/api/oauth/usage.
 *
 * The real endpoint is shared, rate-limited infrastructure attached to a real
 * account. A test suite that polls it is antisocial, is slow, fails whenever the
 * network does, and — as we found out — is enough on its own to earn a 429. So
 * the suite runs against this, and exactly one opt-in test talks to the real
 * thing to catch schema drift.
 *
 * The shape here is copied from a real response, including the parts we
 * deliberately ignore (the unreleased top-level keys), so a test that passes
 * here is testing the same normalisation the live code does.
 */

export const SAMPLE_PAYLOAD = {
  five_hour: { utilization: 43, resets_at: '2026-09-05T05:20:00.444140+00:00' },
  seven_day: { utilization: 8, resets_at: '2026-09-07T03:00:00.444158+00:00' },
  limits: [
    {
      kind: 'session', group: 'session', percent: 43, severity: 'normal',
      is_active: true, scope: null, resets_at: '2026-09-05T05:20:00.444140+00:00',
    },
    {
      kind: 'weekly_all', group: 'weekly', percent: 8, severity: 'normal',
      is_active: false, scope: null, resets_at: '2026-09-07T03:00:00.444158+00:00',
    },
    {
      kind: 'weekly_scoped', group: 'weekly', percent: 6, severity: 'normal',
      is_active: false,
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      resets_at: '2026-09-07T03:00:00.444324+00:00',
    },
  ],
  extra_usage: {
    is_enabled: false, utilization: null, used_credits: 0,
    monthly_limit: null, currency: 'USD', spend_limit_reached: false,
  },
  member_dashboard_available: false,
};

/** The normalised result a successful fetchLimits() returns. */
export function fakeLimitsResult(overrides = {}) {
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    subscriptionType: 'max',
    rateLimitTier: 'max_20x',
    source: 'fake',
    limits: SAMPLE_PAYLOAD.limits.map((e) => ({
      kind: e.kind,
      group: e.group,
      label: e.kind === 'session' ? 'Session (5h)'
        : e.kind === 'weekly_all' ? 'Weekly (all models)'
          : `Weekly · ${e.scope?.model?.display_name ?? 'scoped'}`,
      percent: e.percent,
      severity: e.severity,
      resetsAt: e.resets_at,
      scope: e.scope,
      isActive: e.is_active,
    })),
    extraUsage: {
      enabled: false, utilization: null, usedCredits: 0,
      monthlyLimit: null, currency: 'USD', spendLimitReached: false,
    },
    ...overrides,
  };
}

/**
 * A scripted fetchLimits. Pass results in order; the last one repeats, so a
 * test can say "fail twice then recover" without counting calls itself.
 */
export function scriptedLimits(...results) {
  const script = results.length ? results : [fakeLimitsResult()];
  const fetcher = async () => {
    fetcher.calls += 1;
    return script[Math.min(fetcher.calls - 1, script.length - 1)];
  };
  fetcher.calls = 0;
  return fetcher;
}

/** The shape fetchLimits returns for an HTTP 429. */
export function rateLimited(retryAfterMs = null) {
  return {
    ok: false,
    reason: 'rate-limited',
    retryAfterMs,
    message: retryAfterMs
      ? `Usage endpoint is rate limiting us. Backing off for ${Math.round(retryAfterMs / 1000)}s.`
      : 'Usage endpoint is rate limiting us. Backing off.',
  };
}

export const fakeProfile = async () => ({
  ok: true,
  displayName: 'Test Account',
  email: 'test@example.com',
  plan: 'max',
  rateLimitTier: 'max_20x',
  subscriptionStatus: 'active',
});

/** Everything Store needs to run without a network. */
export function offlineDeps(overrides = {}) {
  return { fetchLimits: scriptedLimits(), fetchProfile: fakeProfile, ...overrides };
}
