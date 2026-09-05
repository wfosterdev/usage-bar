const MINUTE = 60_000;

/**
 * Projects when a rate limit will be exhausted.
 *
 * The API gives us a percentage snapshot, not a rate, so we sample it over time
 * and fit a slope. That is more honest than inferring from local token counts:
 * the server's percentage is the number that actually gates you, and it already
 * accounts for traffic this machine never saw (claude.ai, other devices).
 */
export class LimitProjector {
  constructor({ windowMs = 45 * MINUTE, minSamples = 3 } = {}) {
    /** @type {Map<string, {resetsAt: string|null, samples: Array<{t:number,p:number}>}>} */
    this.tracks = new Map();
    this.windowMs = windowMs;
    this.minSamples = minSamples;
  }

  sample(limits, now = Date.now()) {
    for (const l of limits) {
      if (typeof l.percent !== 'number') continue;
      const key = trackKey(l);
      let tr = this.tracks.get(key);
      // A new reset window means the old samples describe a different budget.
      if (!tr || tr.resetsAt !== l.resetsAt) {
        tr = { resetsAt: l.resetsAt, samples: [] };
        this.tracks.set(key, tr);
      }
      const last = tr.samples[tr.samples.length - 1];
      if (last && last.p > l.percent) tr.samples = []; // reset mid-window
      tr.samples.push({ t: now, p: l.percent });
      const cutoff = now - this.windowMs;
      tr.samples = tr.samples.filter((s) => s.t >= cutoff);
    }
  }

  /**
   * Returns { percentPerHour, exhaustsAt, minutesToExhaust, beatsReset } or null.
   * `beatsReset` true means the window resets before you run out — you're fine.
   */
  project(limit, now = Date.now()) {
    const tr = this.tracks.get(trackKey(limit));
    if (!tr || tr.samples.length < this.minSamples) return null;

    const slope = leastSquaresSlope(tr.samples); // percent per ms
    const perHour = slope * 3600_000;
    const resetMs = limit.resetsAt ? new Date(limit.resetsAt).getTime() : null;

    if (!(slope > 0)) {
      return { percentPerHour: Math.max(0, perHour), exhaustsAt: null, minutesToExhaust: null, beatsReset: true };
    }

    const remaining = Math.max(0, 100 - limit.percent);
    const msToExhaust = remaining / slope;
    const exhaustsAt = new Date(now + msToExhaust).toISOString();
    return {
      percentPerHour: perHour,
      exhaustsAt,
      minutesToExhaust: msToExhaust / MINUTE,
      beatsReset: resetMs != null && now + msToExhaust > resetMs,
    };
  }
}

function trackKey(l) {
  const scope = l.scope?.model?.display_name || l.scope?.surface || '';
  return `${l.kind}:${scope}`;
}

function leastSquaresSlope(samples) {
  const n = samples.length;
  const t0 = samples[0].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const { t, p } of samples) {
    const x = t - t0;
    sx += x; sy += p; sxx += x * x; sxy += x * p;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}
