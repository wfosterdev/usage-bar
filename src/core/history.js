import { emptyTokens, addTokens, totalTokens } from './pricing.js';

const DAY = 'day';

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
    const dayCut = dayKey(now - this.retainDays * 86400_000);
    const hourCut = hourKey(now - 14 * 86400_000);
    for (const k of this.days.keys()) if (k < dayCut) this.days.delete(k);
    for (const k of this.hours.keys()) if (k < hourCut) this.hours.delete(k);
  }

  #serializeDim(map, limit) {
    return [...map.entries()]
      .map(([key, v]) => ({ key, cost: v.cost, tokens: totalTokens(v.tokens) }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, limit);
  }

  /** Series for charting. `granularity` is 'day' or 'hour'. */
  series(granularity = DAY, limit = 30) {
    const map = granularity === DAY ? this.days : this.hours;
    return [...map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(-limit)
      .map(([key, b]) => ({
        key,
        cost: b.cost,
        tokens: totalTokens(b.tokens),
        input: b.tokens.input,
        output: b.tokens.output,
        cacheRead: b.tokens.cacheRead,
        cacheWrite: b.tokens.cacheWrite5m + b.tokens.cacheWrite1h,
      }));
  }

  /** Aggregate the last `days` day-buckets, broken down by each dimension. */
  totals(days = 30, topN = 12) {
    const keys = [...this.days.keys()].sort().slice(-days);
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
      days: keys.length,
      cost: agg.cost,
      tokens: { ...agg.tokens, total: totalTokens(agg.tokens) },
      byProject: this.#serializeDim(agg.byProject, topN),
      byModel: this.#serializeDim(agg.byModel, topN),
      bySkill: this.#serializeDim(agg.bySkill, topN),
    };
  }
}
