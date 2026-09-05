/**
 * Published Anthropic first-party rates, USD per million tokens.
 *
 * IMPORTANT: on a Claude Pro/Max subscription these dollars are NOT billed to you.
 * They are the equivalent API cost of the same traffic, which is the only
 * meaningful common unit for comparing sessions, models and skills. The UI
 * labels every figure accordingly.
 */
const RATES = {
  'claude-fable-5':    { in: 10, out: 50, ctx: 1_000_000 },
  'claude-mythos-5':   { in: 10, out: 50, ctx: 1_000_000 },
  'claude-opus-5':     { in: 5,  out: 25, ctx: 1_000_000 },
  'claude-opus-4-8':   { in: 5,  out: 25, ctx: 1_000_000 },
  'claude-opus-4-7':   { in: 5,  out: 25, ctx: 1_000_000 },
  'claude-opus-4-6':   { in: 5,  out: 25, ctx: 1_000_000 },
  'claude-sonnet-5':   { in: 2,  out: 10, ctx: 1_000_000 },
  'claude-sonnet-4-6': { in: 3,  out: 15, ctx: 1_000_000 },
  'claude-haiku-4-5':  { in: 1,  out: 5,  ctx:   200_000 },
};

/** Cache multipliers applied to the model's input rate. */
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.0;
const CACHE_READ = 0.1;

const UNKNOWN = { in: 5, out: 25, ctx: 1_000_000 };

/** Strip the [1m] context suffix and any date suffix Claude Code may append. */
export function normalizeModel(model) {
  if (!model || model === '<synthetic>') return null;
  return model.replace(/\[1m\]$/, '').trim();
}

export function rateFor(model) {
  const id = normalizeModel(model);
  if (!id) return null;
  return RATES[id] || UNKNOWN;
}

export function contextWindowFor(model) {
  const r = rateFor(model);
  return r ? r.ctx : UNKNOWN.ctx;
}

export function isKnownModel(model) {
  const id = normalizeModel(model);
  return Boolean(id && RATES[id]);
}

/**
 * Cost of a single usage block, in USD.
 * `usage` is the raw `message.usage` object from a transcript line.
 */
export function costOf(model, usage) {
  const r = rateFor(model);
  if (!r || !usage) return 0;
  const M = 1_000_000;
  const creation = usage.cache_creation || {};
  // Prefer the explicit 5m/1h split when present; fall back to the flat total at 5m rates.
  const has5m = typeof creation.ephemeral_5m_input_tokens === 'number';
  const w5 = has5m ? creation.ephemeral_5m_input_tokens : (usage.cache_creation_input_tokens || 0);
  const w1 = has5m ? (creation.ephemeral_1h_input_tokens || 0) : 0;

  return (
    (usage.input_tokens || 0)             * r.in  / M +
    (usage.output_tokens || 0)            * r.out / M +
    w5                                    * r.in * CACHE_WRITE_5M / M +
    w1                                    * r.in * CACHE_WRITE_1H / M +
    (usage.cache_read_input_tokens || 0)  * r.in * CACHE_READ / M
  );
}

/**
 * What the same traffic would have cost with no cache reads at all
 * (every cache_read billed as a fresh input token). The difference is the saving.
 */
export function uncachedCostOf(model, usage) {
  const r = rateFor(model);
  if (!r || !usage) return 0;
  const M = 1_000_000;
  const reads = usage.cache_read_input_tokens || 0;
  return costOf(model, usage) + reads * r.in * (1 - CACHE_READ) / M;
}

export function emptyTokens() {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

export function addTokens(acc, usage) {
  if (!usage) return acc;
  const creation = usage.cache_creation || {};
  const has5m = typeof creation.ephemeral_5m_input_tokens === 'number';
  acc.input += usage.input_tokens || 0;
  acc.output += usage.output_tokens || 0;
  acc.cacheWrite5m += has5m ? creation.ephemeral_5m_input_tokens : (usage.cache_creation_input_tokens || 0);
  acc.cacheWrite1h += has5m ? (creation.ephemeral_1h_input_tokens || 0) : 0;
  acc.cacheRead += usage.cache_read_input_tokens || 0;
  return acc;
}

export function totalTokens(t) {
  return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
}

/** Billable-input tokens the cache saved us from re-sending at full price. */
export function cacheHitRatio(t) {
  const readable = t.cacheRead + t.input;
  return readable > 0 ? t.cacheRead / readable : 0;
}

/**
 * The five classes of token, in the order they are worth reading: what was
 * sent, what came back, then the three cache lines.
 */
export const TOKEN_CLASSES = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'];

/** Per-MTok rate for one class under one model's rate card. */
function classRate(r, cls) {
  switch (cls) {
    case 'input': return r.in;
    case 'output': return r.out;
    case 'cacheWrite5m': return r.in * CACHE_WRITE_5M;
    case 'cacheWrite1h': return r.in * CACHE_WRITE_1H;
    case 'cacheRead': return r.in * CACHE_READ;
    default: return 0;
  }
}

/**
 * Splits spend across the five token classes.
 *
 * Takes per-model entries — `[model, { tokens }]`, as held by a session's
 * `perModel` or a history bucket's `byModel` — because every multiplier keys
 * off that model's input rate. Summing tokens across models first and applying
 * a blended rate afterwards would only ever be an approximation; done this way
 * the parts add up to exactly the cost recorded elsewhere.
 */
export function costSplit(perModel) {
  const out = { total: { tokens: 0, cost: 0 } };
  for (const c of TOKEN_CLASSES) out[c] = { tokens: 0, cost: 0 };

  for (const [model, entry] of perModel) {
    const r = rateFor(model);
    if (!r || !entry?.tokens) continue;
    for (const c of TOKEN_CLASSES) {
      const n = entry.tokens[c] || 0;
      if (!n) continue;
      const cost = n * classRate(r, c) / 1_000_000;
      out[c].tokens += n;
      out[c].cost += cost;
      out.total.tokens += n;
      out.total.cost += cost;
    }
  }
  return out;
}

export { RATES, CACHE_WRITE_5M, CACHE_WRITE_1H, CACHE_READ };
