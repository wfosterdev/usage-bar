import { EventEmitter } from 'node:events';
import { discoverAll, TailReader } from './transcripts.js';
import { newSession, applyLine, summarize, detail, isActive, pruneSeries } from './sessions.js';
import { History } from './history.js';
import { LimitProjector } from './projection.js';
import { ThresholdNotifier } from './notify.js';
import { fetchLimits, fetchProfile } from './limits.js';
import { describeSource } from './credentials.js';
import { DEFAULTS, resolveTranscriptDirs, validate } from './config.js';

/**
 * Owns all live state. Two independent cadences:
 *   - transcripts are polled fast (local files, tailed incrementally)
 *   - the usage endpoint is polled slowly (a network call to a shared service)
 *
 * Configuration is hot-swappable via applyConfig(), so the settings page can
 * repoint credentials or transcript directories without a restart.
 */
export class Store extends EventEmitter {
  /**
   * `deps` exists so tests can run without touching the network. Polling a
   * shared, rate-limited service from a test suite is antisocial and, on a
   * busy day, is enough on its own to earn a 429.
   */
  constructor(config = DEFAULTS, deps = {}) {
    super();
    this.config = validate(config).config;
    this.fetchLimits = deps.fetchLimits || fetchLimits;
    this.fetchProfile = deps.fetchProfile || fetchProfile;

    this.reader = new TailReader();
    this.history = new History();
    this.projector = new LimitProjector();
    this.notifier = this.#buildNotifier();

    this.sessions = new Map();
    this.limits = { ok: false, reason: 'pending', message: 'Not fetched yet.', limits: [] };
    this.profile = null;
    this.alerts = [];
    this.lastScanAt = null;
    this.scanProblems = [];
    this.transcriptRoots = [];
    this.primed = false;
    this.timers = [];
    this.started = false;

    // Backoff state. The usage endpoint is shared infrastructure and a limit
    // that resets in hours does not need polling every minute — so a failure
    // slows us down, and so does having nothing to watch.
    this.limitsError = null;
    this.limitsBackoffMs = 0;
    this.nextLimitsAt = 0;
    this.limitsInFlight = null;
    this.consecutiveLimitFailures = 0;
    this.lastLimitsAttemptAt = 0;
    this.wasActive = false;
  }

  /**
   * Longest we will ever sleep between usage polls.
   *
   * Ten minutes, not thirty. These 429s come from the edge and clear quickly,
   * so a long cap mostly punishes the user: the endpoint comes back and the app
   * sits there insisting it is rate limited. Worst case this is six requests an
   * hour during an outage, which is not the behaviour that gets anyone blocked.
   *
   * This bounds OUR OWN guess only. An explicit Retry-After is an instruction,
   * not an estimate, so a longer one is obeyed in full.
   */
  static MAX_BACKOFF_MS = 10 * 60 * 1000;

  /**
   * Sanity clamp on the idle pace. Separate from the backoff cap because they
   * answer different questions — this one is "how stale may a reading get while
   * nothing is happening", not "how hard did we just get pushed back".
   */
  static MAX_IDLE_MS = 30 * 60 * 1000;

  /**
   * Hard floor between usage requests, whatever asks for one.
   *
   * The endpoint publishes no quota: there are no `anthropic-ratelimit-*`
   * headers, and an observed 429 came back with `retry-after: 0`, which is no
   * guidance at all. With nothing to aim at, the only defensible policy is to
   * ask rarely and to make each request count.
   */
  static MIN_SPACING_MS = 30 * 1000;

  /** Floor for explicitly user-initiated refreshes. Stops click-spam, no more. */
  static MIN_MANUAL_SPACING_MS = 5 * 1000;

  #buildNotifier() {
    return new ThresholdNotifier({
      enabled: this.config.notify,
      thresholds: this.config.thresholds,
      webhook: this.config.webhook,
      onEvent: (e) => this.emit('alert', e),
    });
  }

  sessionFor(sessionId, project) {
    let s = this.sessions.get(sessionId);
    if (!s) { s = newSession(sessionId, project); this.sessions.set(sessionId, s); }
    return s;
  }

  /** Discard every derived fact and rebuild from disk on the next scan. */
  #resetDerivedState() {
    this.reader = new TailReader();
    this.sessions = new Map();
    this.history = new History();
  }

  async scan({ full = false } = {}) {
    const dirs = resolveTranscriptDirs(this.config);
    const { files, problems, roots } = await discoverAll(dirs);
    this.scanProblems = problems;
    this.transcriptRoots = roots;

    let newLines = 0;
    for (const f of files) {
      if (!full && !(await this.reader.changed(f.path))) continue;
      const { lines, reset } = await this.reader.read(f.path);
      if (reset) {
        // File was rewritten; rebuild it from scratch to avoid double-counting.
        this.sessions.delete(f.sessionId);
        const { lines: all } = await this.reader.read(f.path);
        lines.length = 0;
        lines.push(...all);
      }
      if (!lines.length) continue;
      newLines += lines.length;
      const s = this.sessionFor(f.sessionId, f.project);
      const source = { isSubagent: f.kind === 'subagent', agentId: f.agentId || null };
      for (const line of lines) applyLine(s, line, source, this.history);
    }

    const now = Date.now();
    for (const s of this.sessions.values()) pruneSeries(s, now);
    this.history.prune(now);
    this.lastScanAt = new Date(now).toISOString();

    // Wake on work, not on a clock. A usage limit only moves when you are
    // actually using Claude, and transcripts are scanned every few seconds — so
    // the moment a session goes live we take a fresh reading. That is what lets
    // the idle interval be long without the number ever being stale when it
    // matters: idle only applies while genuinely nothing is happening.
    const activeNow = this.#anyActive(now);
    if (activeNow && !this.wasActive && this.started) {
      this.refreshLimits().catch((e) => this.emit('error', e));
      this.#scheduleLimits();
    }
    this.wasActive = activeNow;

    if (newLines) this.emit('sessions', this.snapshot());
    return newLines;
  }

  /**
   * Fetches usage, unless we are inside a backoff window.
   *
   * `force` is for a user asking explicitly (a Refresh Now click) — even then a
   * rate-limit backoff is honoured, because ignoring a 429 is how a backoff
   * becomes an outage.
   */
  async refreshLimits({ force = false, override = false } = {}) {
    // Single-flight: overlapping refreshes double the request rate for no gain.
    if (this.limitsInFlight) return this.limitsInFlight;

    const now = Date.now();

    // Two floors, because the risk profiles differ. An automatic path can loop
    // and must be held well apart; a person clicking a button cannot loop, but
    // should not be able to spam either — and making them wait 30s after fixing
    // their credentials would be its own bug.
    const floor = force ? Store.MIN_MANUAL_SPACING_MS : Store.MIN_SPACING_MS;
    if (now - this.lastLimitsAttemptAt < floor) return this.limits;
    if (!force && this.nextLimitsAt > now) return this.limits;

    // A rate-limit backoff binds even a forced refresh — ignoring a 429 is how
    // a backoff becomes an outage. `override` is the single exception: a person
    // asking to try again after the endpoint has recovered.
    const rateLimited = this.limitsError?.reason === 'rate-limited' && this.nextLimitsAt > now;
    if (rateLimited && !override) return this.limits;

    this.lastLimitsAttemptAt = now;

    this.limitsInFlight = this.#doRefreshLimits().finally(() => { this.limitsInFlight = null; });
    return this.limitsInFlight;
  }

  async #doRefreshLimits() {
    const res = await this.fetchLimits({ credentials: this.config.credentials });

    if (res.ok) {
      this.limits = res;
      this.limitsError = null;
      this.limitsBackoffMs = 0;
      this.consecutiveLimitFailures = 0;
      // Clearing the counters is not enough: the deadline itself gates both
      // refreshLimits() and nextLimitsDelay(), so leaving it set means a
      // recovered store keeps suppressing its own polls until it expires.
      this.nextLimitsAt = 0;
      this.projector.sample(res.limits);
      if (!this.primed) { this.notifier.prime(res.limits); this.primed = true; }
      else {
        const fired = this.notifier.check(res.limits);
        if (fired.length) this.alerts = [...fired, ...this.alerts].slice(0, 20);
      }
    } else {
      this.consecutiveLimitFailures += 1;
      this.limitsError = res;
      // Keep the last good reading. Blanking the UI on a transient 429 throws
      // away data that is still perfectly usable — a 5h limit does not move
      // much in the time it takes to get back in.
      if (!this.limits.ok) this.limits = res;
      this.#backOff(res);
    }

    this.emit('limits', this.limitsView());
    return res;
  }

  /** Exponential backoff, floored by whatever the server asked for. */
  #backOff(res) {
    const base = this.config.limitsIntervalMs;
    const grown = Math.min(
      Store.MAX_BACKOFF_MS,
      base * 2 ** Math.min(6, this.consecutiveLimitFailures),
    );
    // A rate limit is a direct instruction; anything else is us guessing.
    const wait = res.reason === 'rate-limited'
      ? Math.max(res.retryAfterMs || 0, grown)
      : grown;
    // Deliberately not re-capped: `grown` is already bounded, and the only way
    // `wait` exceeds it is a Retry-After we were told to honour.
    this.limitsBackoffMs = wait;
    this.nextLimitsAt = Date.now() + wait;
  }

  /**
   * How long to wait before the next usage poll.
   *
   * Idle backs off hard: the 5h limit only moves when you are actually using
   * Claude, so polling every minute at 3am is pure waste — and waste is what
   * gets an endpoint to rate limit you.
   */
  nextLimitsDelay(now = Date.now()) {
    if (this.nextLimitsAt > now) return Math.max(1000, this.nextLimitsAt - now);
    const base = this.config.limitsIntervalMs;
    // A limit that has just rolled over reads zero until we look again, and the
    // reset time is known exactly — so this is a scheduled event, not a guess.
    if (this.#resetDue(now)) return Store.MIN_SPACING_MS;
    const anyActive = this.#anyActive(now);
    return anyActive ? base : Math.min(Store.MAX_IDLE_MS, base * this.config.idleLimitsFactor);
  }

  #anyActive(now = Date.now()) {
    for (const s of this.sessions.values()) if (isActive(s, now, this.config.idleMs)) return true;
    return false;
  }

  /** True when a limit has rolled over since the reading we are holding. */
  #resetDue(now) {
    if (!this.limits.ok || !this.limits.fetchedAt) return false;
    const fetched = Date.parse(this.limits.fetchedAt);
    return this.limits.limits.some((l) => {
      if (!l.resetsAt) return false;
      const resets = Date.parse(l.resetsAt);
      return resets <= now && fetched < resets;
    });
  }

  limitsView() {
    const source = this.limits.source || describeSource(this.config.credentials);
    if (!this.limits.ok) {
      // A cold start that is immediately rate limited has nothing to hold over,
      // so say when we will try again rather than leaving it looking wedged.
      return {
        ok: false,
        reason: this.limits.reason,
        message: this.limits.message,
        retryAt: this.nextLimitsAt ? new Date(this.nextLimitsAt).toISOString() : null,
        source,
        limits: [],
      };
    }
    // Good data that is a little old beats no data. Say so rather than
    // pretending the reading is fresh.
    const stale = this.limitsError
      ? {
        stale: true,
        staleReason: this.limitsError.reason,
        staleMessage: this.limitsError.message,
        retryAt: this.nextLimitsAt ? new Date(this.nextLimitsAt).toISOString() : null,
      }
      : {};
    return {
      ok: true,
      ...stale,
      fetchedAt: this.limits.fetchedAt,
      subscriptionType: this.limits.subscriptionType,
      rateLimitTier: this.limits.rateLimitTier,
      extraUsage: this.limits.extraUsage,
      source,
      limits: this.limits.limits.map((l) => ({ ...l, projection: this.projector.project(l) })),
    };
  }

  snapshot(now = Date.now()) {
    const all = [...this.sessions.values()];
    const summaries = all.map((s) => summarize(s, now, this.config.idleMs));
    const active = summaries.filter((s) => s.active);
    active.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
    const recent = summaries.filter((s) => !s.active).sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));

    return {
      generatedAt: new Date(now).toISOString(),
      lastScanAt: this.lastScanAt,
      counts: { total: summaries.length, active: active.length },
      active,
      recent: recent.slice(0, 40),
      sources: { roots: this.transcriptRoots, problems: this.scanProblems },
      totals: {
        activeCost: active.reduce((a, s) => a + s.cost, 0),
        activeCostPerMin: active.reduce((a, s) => a + s.costPerMin, 0),
        activeTokens: active.reduce((a, s) => a + s.tokens.total, 0),
      },
    };
  }

  session(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? detail(s, Date.now(), this.config.idleMs) : null;
  }

  state() {
    return {
      limits: this.limitsView(),
      sessions: this.snapshot(),
      profile: this.profile,
      alerts: this.alerts,
      costBasis: 'equivalent-api-cost',
    };
  }

  /**
   * Swap in a new configuration at runtime.
   *
   * Repointing the transcript directories invalidates every derived number, so
   * that case throws away sessions and history and re-reads from scratch. A
   * credentials-only change just needs a fresh usage fetch.
   */
  async applyConfig(next) {
    const { config, errors } = validate(next);
    const before = this.config;
    this.config = config;

    const dirsChanged =
      JSON.stringify(resolveTranscriptDirs(before)) !== JSON.stringify(resolveTranscriptDirs(config));
    const credsChanged = JSON.stringify(before.credentials) !== JSON.stringify(config.credentials);
    const timingChanged =
      before.scanIntervalMs !== config.scanIntervalMs || before.limitsIntervalMs !== config.limitsIntervalMs;
    const notifyChanged =
      before.notify !== config.notify ||
      before.webhook !== config.webhook ||
      JSON.stringify(before.thresholds) !== JSON.stringify(config.thresholds);

    if (notifyChanged) {
      this.notifier = this.#buildNotifier();
      this.primed = false;
    }
    if (dirsChanged) {
      this.#resetDerivedState();
      await this.scan({ full: true });
      this.emit('sessions', this.snapshot());
    }
    if (credsChanged) {
      this.primed = false;
      this.profile = await this.fetchProfile({ credentials: config.credentials })
        .then((p) => (p.ok ? p : null)).catch(() => null);
      this.#resetLimitsBackoff();
      await this.refreshLimits({ force: true });
    }
    if (timingChanged && this.started) this.#restartTimers();

    return { config, errors, applied: { dirsChanged, credsChanged, timingChanged, notifyChanged } };
  }

  #restartTimers() {
    this.#clearTimers();
    const scanTimer = setInterval(() => { this.scan().catch((e) => this.emit('error', e)); }, this.config.scanIntervalMs);
    scanTimer.unref?.();
    this.timers = [scanTimer];
    this.#scheduleLimits();
  }

  /**
   * Self-scheduling rather than setInterval, because the gap between polls is
   * not constant: it stretches when nothing is happening and stretches further
   * when the endpoint pushes back.
   */
  #scheduleLimits() {
    if (this.limitsPoll) clearTimeout(this.limitsPoll);
    const delay = this.nextLimitsDelay();
    this.limitsPoll = setTimeout(() => {
      this.refreshLimits()
        .catch((e) => this.emit('error', e))
        .finally(() => { if (this.started) this.#scheduleLimits(); });
    }, delay);
    this.limitsPoll.unref?.();
  }

  #clearTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.limitsPoll) { clearTimeout(this.limitsPoll); this.limitsPoll = null; }
  }

  /** New credentials mean the old rate-limit verdict no longer applies. */
  #resetLimitsBackoff() {
    this.limitsError = null;
    this.limitsBackoffMs = 0;
    this.nextLimitsAt = 0;
    this.consecutiveLimitFailures = 0;
  }

  async start() {
    this.profile = await this.fetchProfile({ credentials: this.config.credentials })
      .then((p) => (p.ok ? p : null)).catch(() => null);
    await this.scan({ full: true });
    await this.refreshLimits();
    this.started = true;
    this.#restartTimers();
    return this;
  }

  stop() {
    this.started = false;
    this.#clearTimers();
  }
}

export { isActive };
