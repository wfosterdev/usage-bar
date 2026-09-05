import { readCredentials, describeSource } from './credentials.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const BETA = 'oauth-2025-04-20';

/**
 * `Retry-After` is either a count of seconds or an HTTP date. Both are common;
 * ignoring the header and guessing is how a backoff turns into a hammering.
 */
export function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(String(value).trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(value);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

function headers(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'anthropic-beta': BETA,
    'User-Agent': 'usage-bar/0.1',
    'Accept': 'application/json',
  };
}

/** Human label for a limit entry, driven off the generic fields only. */
function labelFor(entry) {
  const scopedModel = entry.scope?.model?.display_name;
  const scopedSurface = entry.scope?.surface;
  switch (entry.kind) {
    case 'session': return 'Session (5h)';
    case 'weekly_all': return 'Weekly (all models)';
    case 'weekly_scoped': {
      const bits = [scopedModel, scopedSurface].filter(Boolean).join(' · ');
      return bits ? `Weekly · ${bits}` : 'Weekly (scoped)';
    }
    default:
      return entry.kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

/**
 * Normalises the usage response into a stable shape.
 *
 * We read the generic `limits[]` array rather than the flat top-level keys.
 * The flat keys include placeholders for products that are not released, and
 * hardcoding them would both break on rename and surface names that are not
 * ours to display. `limits[]` is self-describing and forward-compatible.
 */
export function normalizeUsage(payload) {
  const entries = Array.isArray(payload?.limits) ? payload.limits : [];
  const limits = entries.map((e) => ({
    kind: e.kind,
    group: e.group,
    label: labelFor(e),
    percent: typeof e.percent === 'number' ? e.percent : null,
    severity: e.severity || 'normal',
    resetsAt: e.resets_at || null,
    scope: e.scope || null,
    isActive: Boolean(e.is_active),
  }));

  const extra = payload?.extra_usage || {};
  return {
    limits,
    primary: limits.find((l) => l.group === 'session') || null,
    weekly: limits.filter((l) => l.group === 'weekly'),
    extraUsage: {
      enabled: Boolean(extra.is_enabled),
      utilization: extra.utilization ?? null,
      usedCredits: extra.used_credits ?? null,
      monthlyLimit: extra.monthly_limit ?? null,
      currency: extra.currency ?? null,
      spendLimitReached: Boolean(extra.spend_limit_reached),
    },
  };
}

/**
 * Serves a canned response instead of calling the endpoint.
 *
 * Purely for working on the UI: iterating on layout should not spend an
 * account's rate limit budget, which is exactly how we earned a 429 in the
 * first place. Opt-in, and the payload is labelled so it cannot be mistaken for
 * a real reading.
 */
export const FAKE_LIMITS = process.env.USAGE_BAR_FAKE_LIMITS === '1';

function fakeUsagePayload() {
  const in4h = new Date(Date.now() + 4 * 3600_000).toISOString();
  const in3d = new Date(Date.now() + 3 * 86400_000).toISOString();
  return {
    limits: [
      { kind: 'session', group: 'session', percent: 43, severity: 'normal', is_active: true, resets_at: in4h },
      { kind: 'weekly_all', group: 'weekly', percent: 8, severity: 'normal', is_active: false, resets_at: in3d },
      {
        kind: 'weekly_scoped', group: 'weekly', percent: 6, severity: 'normal', is_active: false,
        scope: { model: { id: null, display_name: 'Fable' }, surface: null }, resets_at: in3d,
      },
    ],
    extra_usage: { is_enabled: false, used_credits: 0, currency: 'USD' },
  };
}

export async function fetchLimits({ timeoutMs = 15000, credentials } = {}) {
  if (FAKE_LIMITS) {
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      subscriptionType: 'fake',
      rateLimitTier: 'FAKE DATA (USAGE_BAR_FAKE_LIMITS=1)',
      source: 'fake',
      ...normalizeUsage(fakeUsagePayload()),
    };
  }

  const creds = await readCredentials(credentials);
  if (!creds.ok) return { ok: false, reason: creds.reason, message: creds.message, source: describeSource(credentials) };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(USAGE_URL, { headers: headers(creds.accessToken), signal: ac.signal });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'unauthorized', message: 'Token rejected. Run any Claude Code command to refresh it.' };
    }
    if (res.status === 429) {
      // The server told us how long to wait; that beats any guess we make.
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      return {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs,
        message: retryAfterMs
          ? `Usage endpoint is rate limiting us. Backing off for ${Math.round(retryAfterMs / 1000)}s.`
          : 'Usage endpoint is rate limiting us. Backing off.',
      };
    }
    if (!res.ok) {
      return { ok: false, reason: 'http-error', message: `Usage endpoint returned HTTP ${res.status}.` };
    }
    const payload = await res.json();
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      subscriptionType: creds.subscriptionType,
      rateLimitTier: creds.rateLimitTier,
      source: creds.origin,
      ...normalizeUsage(payload),
    };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, reason: 'timeout', message: 'Usage endpoint timed out.' };
    return { ok: false, reason: 'network', message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Account/plan info. Fetched once at startup; changes rarely. */
export async function fetchProfile({ timeoutMs = 15000, credentials } = {}) {
  const creds = await readCredentials(credentials);
  if (!creds.ok) return { ok: false, reason: creds.reason, message: creds.message };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(PROFILE_URL, { headers: headers(creds.accessToken), signal: ac.signal });
    if (!res.ok) return { ok: false, reason: 'http-error', message: `Profile endpoint returned HTTP ${res.status}.` };
    const p = await res.json();
    return {
      ok: true,
      displayName: p.account?.display_name || null,
      email: p.account?.email || null,
      plan: p.organization?.organization_type || null,
      rateLimitTier: p.organization?.rate_limit_tier || null,
      subscriptionStatus: p.organization?.subscription_status || null,
    };
  } catch (err) {
    return { ok: false, reason: 'network', message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates a credentials configuration end to end without saving it: resolve
 * the source, then make one real call. The settings page uses this so a bad
 * path is caught before it becomes the live configuration.
 */
export async function testCredentials(credentialsConfig) {
  const creds = await readCredentials(credentialsConfig);
  if (!creds.ok) {
    return { ok: false, stage: 'resolve', reason: creds.reason, message: creds.message, source: describeSource(credentialsConfig) };
  }

  const res = await fetchLimits({ credentials: credentialsConfig });
  if (!res.ok) {
    return { ok: false, stage: 'request', reason: res.reason, message: res.message, source: creds.origin };
  }

  const profile = await fetchProfile({ credentials: credentialsConfig });
  const session = res.limits.find((l) => l.group === 'session');
  return {
    ok: true,
    source: creds.origin,
    expiresAt: creds.expiresAt || null,
    subscriptionType: creds.subscriptionType,
    rateLimitTier: res.rateLimitTier,
    account: profile.ok ? profile.email : null,
    plan: profile.ok ? profile.plan : null,
    sessionPercent: session ? session.percent : null,
    limitCount: res.limits.length,
    message: `Connected${profile.ok && profile.email ? ` as ${profile.email}` : ''}${session ? ` · session at ${session.percent}%` : ''}.`,
  };
}
