import { emptyTokens, addTokens, totalTokens, costSplit } from './pricing.js';

const DAY = 'day';
const HOUR_MS = 3600_000;
const DAY_MS = 86400_000;

/**
 * Hour buckets are kept for a fortnight only. Day buckets follow `retainDays`.
 * Both bound how far back a series can meaningfully reach.
 */
const HOUR_RETAIN_DAYS = 14;

function dayKey(ts) { return new Date(ts).toISOString().slice(0, 10); }
function hourKey(ts) { return new Date(ts).toISOString().slice(0, 13); }

function newBucket() {
  return { cost: 0, tokens: emptyTokens(), byProject: new Map(), byModel: new Map(), bySkill: new Map() };
}

function bumpDim(map, key, cost, usage) {
  if (!key) return;
  let e = map.get(key);
  if (!e) { e = { cost: 0, tokens: emptyTokens() }; map.set(key, e); }
  e.cost += cost;
  addTokens(e.tokens, usage);
}

/**
 * Rolls every assistant message into day and hour buckets. Built by replaying
 * the whole transcript archive at startup — the transcripts are the durable
 * store, so there is nothing of our own to persist or keep in sync.
 */
export class History {
  constructor({ retainDays = 90 } = {}) {
    this.days = new Map();
    this.hours = new Map();
    this.retainDays = retainDays;
  }

  record({ ts, project, model, skill, cost, usage }) {
    for (const [map, key] of [[this.days, dayKey(ts)], [this.hours, hourKey(ts)]]) {
      let b = map.get(key);
      if (!b) { b = newBucket(); map.set(key, b); }
      b.cost += cost;
      addTokens(b.tokens, usage);
      bumpDim(b.byProject, project, cost, usage);
      bumpDim(b.byModel, model, cost, usage);
      bumpDim(b.bySkill, skill, cost, usage);
    }
  }

  /** Trim hour buckets beyond 14 days and day buckets beyond retainDays. */
  prune(now = Date.now()) {
    const dayCut = dayKey(now - this.retainDays * DAY_MS);
    const hourCut = hourKey(now - HOUR_RETAIN_DAYS * DAY_MS);
    for (const k of this.days.keys()) if (k < dayCut) this.days.delete(k);
    for (const k of this.hours.keys()) if (k < hourCut) this.hours.delete(k);
  }

  /**
   * Every slot key in a window of `span` day- or hour-slots ending now, quiet
   * ones included and in order.
   *
   * A window is calendar time, not a count of buckets that happen to have
   * something in them. Slicing the last N populated buckets means a quiet
   * fortnight silently widens the window, and — once the archive holds fewer
   * active days than the smallest choice — every choice returns the same set,
   * so the range selector appears to do nothing.
   *
   * Keys are built in UTC and stepped by a fixed slot size, which is the same
   * arithmetic `dayKey`/`hourKey` do, so daylight saving cannot skew or
   * duplicate a slot.
   */
  #windowSlots(granularity, span, now) {
    const size = granularity === DAY ? DAY_MS : HOUR_MS;
    const keyOf = granularity === DAY ? dayKey : hourKey;
    const slots = [];
    for (let i = this.#cappedSpan(granularity, span) - 1; i >= 0; i -= 1) slots.push(keyOf(now - i * size));
    return slots;
  }

  /** No point returning slots from before the point we stop retaining them. */
  #cappedSpan(granularity, span) {
    const max = granularity === DAY ? this.retainDays : HOUR_RETAIN_DAYS * 24;
    return Math.min(Math.max(1, Math.floor(span)), max);
  }

  /** The populated slot keys in that same window. */
  #windowKeys(map, granularity, span, now) {
    return this.#windowSlots(granularity, span, now).filter((k) => map.has(k));
  }

  #serializeDim(map, limit) {
    return [...map.entries()]
      .map(([key, v]) => ({ key, cost: v.cost, tokens: totalTokens(v.tokens) }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, limit);
  }

  /**
   * Series for charting. `granularity` is 'day' or 'hour', `span` the number of
   * slots of that size to look back over.
   *
   * Quiet slots are emitted as zeros rather than skipped: a chart drawn only
   * from the days that had traffic puts three weeks of scattered work
   * shoulder to shoulder and reads as three weeks of solid work.
   */
  series(granularity = DAY, span = 30, now = Date.now()) {
    const map = granularity === DAY ? this.days : this.hours;
    return this.#windowSlots(granularity, span, now).map((key) => {
      const b = map.get(key);
      if (!b) {
        return { key, cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, quiet: true };
      }
      return {
        key,
        cost: b.cost,
        tokens: totalTokens(b.tokens),
        input: b.tokens.input,
        output: b.tokens.output,
        cacheRead: b.tokens.cacheRead,
        cacheWrite: b.tokens.cacheWrite5m + b.tokens.cacheWrite1h,
        quiet: false,
      };
    });
  }

  /** Aggregate the last `days` calendar days, broken down by each dimension. */
  totals(days = 30, topN = 12, now = Date.now()) {
    const keys = this.#windowKeys(this.days, DAY, days, now);
    const agg = newBucket();
    for (const k of keys) {
      const b = this.days.get(k);
      agg.cost += b.cost;
      addTokens(agg.tokens, {
        input_tokens: b.tokens.input,
        output_tokens: b.tokens.output,
        cache_read_input_tokens: b.tokens.cacheRead,
        cache_creation: {
          ephemeral_5m_input_tokens: b.tokens.cacheWrite5m,
          ephemeral_1h_input_tokens: b.tokens.cacheWrite1h,
        },
      });
      for (const [dim, target] of [['byProject', agg.byProject], ['byModel', agg.byModel], ['bySkill', agg.bySkill]]) {
        for (const [key, v] of b[dim]) {
          let e = target.get(key);
          if (!e) { e = { cost: 0, tokens: emptyTokens() }; target.set(key, e); }
          e.cost += v.cost;
          for (const f of Object.keys(e.tokens)) e.tokens[f] += v.tokens[f];
        }
      }
    }
    return {
      // Days that actually saw traffic, and the window they were drawn from —
      // "8 days" next to a "30 days" selector is otherwise a puzzle.
      days: keys.length,
      window: days,
      cost: agg.cost,
      tokens: { ...agg.tokens, total: totalTokens(agg.tokens) },
      // The per-model dimension is already carried per bucket, so the same
      // exact split is available over a whole window.
      costSplit: costSplit(agg.byModel),
      byProject: this.#serializeDim(agg.byProject, topN),
      byModel: this.#serializeDim(agg.byModel, topN),
      bySkill: this.#serializeDim(agg.bySkill, topN),
    };
  }
}
