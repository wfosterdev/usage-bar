import { contentToText, proseOf, toolNames } from './transcripts.js';
import {
  costOf, uncachedCostOf, emptyTokens, addTokens, totalTokens,
  cacheHitRatio, contextWindowFor, normalizeModel, costSplit,
} from './pricing.js';
import { projectLabel, decodeProjectDir } from './paths.js';

const MAX_MESSAGES = 40;
const MAX_EVENTS = 25;
const MINUTE = 60_000;

function bucketOf(ts) { return Math.floor(new Date(ts).getTime() / MINUTE) * MINUTE; }

function newBreakdown() {
  return { tokens: emptyTokens(), cost: 0, calls: 0 };
}

function bump(map, key, model, usage, cost) {
  if (!key) return;
  let e = map.get(key);
  if (!e) { e = newBreakdown(); map.set(key, e); }
  addTokens(e.tokens, usage);
  e.cost += cost;
  e.calls += 1;
}

/**
 * The record for one subagent of `s`, created on first sight.
 *
 * Either end can be the first sight: the parent's launch record usually lands
 * before the agent writes anything, but transcript files are scanned in
 * directory order, so the agent's own usage can arrive first. Both paths widen
 * the same span rather than assuming they are opening it.
 */
function subagentFor(s, agentId, ts) {
  let sub = s.subagents.get(agentId);
  if (!sub) {
    sub = {
      agentId,
      agentType: null,
      description: null,
      skill: null,
      model: null,
      launchedAt: null,
      tokens: emptyTokens(),
      cost: 0,
      calls: 0,
      firstTs: null,
      lastTs: null,
      context: { tokens: 0, window: null, pct: 0 },
    };
    s.subagents.set(agentId, sub);
  }
  if (ts) {
    if (!sub.firstTs || ts < sub.firstTs) sub.firstTs = ts;
    if (!sub.lastTs || ts > sub.lastTs) sub.lastTs = ts;
  }
  return sub;
}

export function newSession(sessionId, project) {
  return {
    sessionId,
    project,
    projectLabel: projectLabel(project),
    cwd: decodeProjectDir(project),
    title: null,
    gitBranch: null,
    version: null,
    entrypoint: null,
    permissionMode: null,

    firstTs: null,
    lastTs: null,
    lastUserTs: null,

    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,

    tokens: emptyTokens(),
    cost: 0,
    uncachedCost: 0,

    currentModel: null,
    currentEffort: null,
    lastStopReason: null,
    activeTools: [],

    context: { tokens: 0, window: null, pct: 0, at: null },

    messages: [],
    compactions: [],
    errors: [],
    denials: [],
    queuedOps: 0,

    perModel: new Map(),
    perSkill: new Map(),
    perAgent: new Map(),
    subagents: new Map(),

    costSeries: new Map(), // minute bucket -> cost
  };
}

function touchTime(s, ts) {
  if (!ts) return;
  if (!s.firstTs || ts < s.firstTs) s.firstTs = ts;
  if (!s.lastTs || ts > s.lastTs) s.lastTs = ts;
}

function pushCapped(arr, item, cap) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

/**
 * Folds one transcript line into the session accumulator.
 * `source` is { isSubagent, agentId } — subagent lines roll up into the parent
 * session's totals but keep their own per-agent record.
 */
export function applyLine(s, line, source = {}, history = null) {
  const { isSubagent = false, agentId = null } = source;
  const ts = line.timestamp || null;
  touchTime(s, ts);

  if (line.cwd && !isSubagent) s.cwd = line.cwd;
  if (line.gitBranch) s.gitBranch = line.gitBranch;
  if (line.version) s.version = line.version;
  if (line.entrypoint) s.entrypoint = line.entrypoint;
  if (line.permissionMode) s.permissionMode = line.permissionMode;

  switch (line.type) {
    case 'ai-title':
      if (line.aiTitle) s.title = line.aiTitle;
      return;

    case 'queue-operation':
      s.queuedOps += 1;
      return;

    case 'user': {
      if (!isSubagent) {
        s.userMessages += 1;
        if (ts) s.lastUserTs = ts;
      }
      if (line.toolDenialKind) {
        pushCapped(s.denials, { ts, kind: line.toolDenialKind, reason: line.reason || null }, MAX_EVENTS);
      }
      // An async subagent announces itself in the PARENT transcript, and does so
      // before it has written a line of its own. Registering it here is what
      // lets a dispatched agent appear while it is still thinking, rather than
      // popping into existence only once it has spent something.
      const launch = line.toolUseResult;
      if (!isSubagent && launch?.agentId && launch.status === 'async_launched') {
        const sub = subagentFor(s, launch.agentId, ts);
        sub.launchedAt = ts || sub.launchedAt;
        sub.description = launch.description || sub.description;
        // The resolved model is what it was dispatched with; a usage line will
        // overwrite it with what actually answered.
        sub.model = sub.model || normalizeModel(launch.resolvedModel);
      }
      if (!isSubagent && line.message && !line.isMeta) {
        const text = proseOf(line.message.content);
        if (text) pushCapped(s.messages, { ts, role: 'user', text, tools: [], agentId: null }, MAX_MESSAGES);
      }
      return;
    }

    case 'assistant': {
      const msg = line.message || {};
      const model = normalizeModel(msg.model);
      const usage = msg.usage;

      if (line.isApiErrorMessage) {
        pushCapped(s.errors, {
          ts,
          status: line.apiErrorStatus ?? null,
          text: contentToText(msg.content, { maxLen: 300 }),
        }, MAX_EVENTS);
      }

      if (line.compactMetadata) {
        const c = line.compactMetadata;
        pushCapped(s.compactions, {
          ts,
          trigger: c.trigger || 'unknown',
          preTokens: c.preTokens ?? 0,
          postTokens: c.postTokens ?? 0,
          dropped: c.cumulativeDroppedTokens ?? Math.max(0, (c.preTokens ?? 0) - (c.postTokens ?? 0)),
          durationMs: c.durationMs ?? 0,
        }, MAX_EVENTS);
      }

      // `<synthetic>` messages are locally generated (errors, notices) and carry
      // no real usage — they must not contribute cost or move the model display.
      if (!model || !usage) return;

      const cost = costOf(model, usage);
      const uncached = uncachedCostOf(model, usage);

      s.assistantMessages += 1;
      addTokens(s.tokens, usage);
      s.cost += cost;
      s.uncachedCost += uncached;

      bump(s.perModel, model, model, usage, cost);
      bump(s.perSkill, line.attributionSkill || line.slug || null, model, usage, cost);
      bump(s.perAgent, line.attributionAgent || null, model, usage, cost);

      if (ts) {
        const b = bucketOf(ts);
        s.costSeries.set(b, (s.costSeries.get(b) || 0) + cost);
      }

      if (isSubagent && agentId) {
        const sub = subagentFor(s, agentId, ts);
        sub.agentType = line.attributionAgent || sub.agentType;
        sub.skill = line.attributionSkill || sub.skill;
        sub.model = model;
        addTokens(sub.tokens, usage);
        sub.cost += cost;
        sub.calls += 1;
        const ctx = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
        const win = contextWindowFor(model);
        sub.context = { tokens: ctx, window: win, pct: win ? (ctx / win) * 100 : 0 };
      } else {
        // Context fill is a property of the main conversation: the tokens the
        // model saw on its most recent request. Subagents have their own.
        s.currentModel = model;
        s.currentEffort = line.effort || s.currentEffort;
        s.lastStopReason = msg.stop_reason || null;
        const tools = toolNames(msg.content);
        s.toolCalls += tools.length;
        s.activeTools = msg.stop_reason === 'tool_use' ? tools : [];

        const ctx = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
        const win = contextWindowFor(model);
        s.context = { tokens: ctx, window: win, pct: win ? (ctx / win) * 100 : 0, at: ts };

        const text = proseOf(msg.content);
        if (text) {
          pushCapped(s.messages, { ts, role: 'assistant', text, tools, model, agentId: null }, MAX_MESSAGES);
        }
      }

      if (history && ts) {
        history.record({
          ts,
          project: s.project,
          model,
          skill: line.attributionSkill || null,
          agent: line.attributionAgent || null,
          usage,
          cost,
        });
      }
      return;
    }

    default:
      return;
  }
}

/** True if the session saw activity within `idleMs`. */
export function isActive(s, now = Date.now(), idleMs = 5 * MINUTE) {
  if (!s.lastTs) return false;
  return now - new Date(s.lastTs).getTime() <= idleMs;
}

/**
 * How many subagents are still working.
 *
 * Nothing in the transcripts marks an agent as finished — the parent records
 * the launch and the agent's own file simply stops growing — so liveness is the
 * same idle window the sessions use. An agent dispatched a moment ago but yet
 * to write counts as live on its launch time.
 */
export function activeSubagents(s, now = Date.now(), idleMs = 5 * MINUTE) {
  let n = 0;
  for (const sub of s.subagents.values()) {
    const at = sub.lastTs || sub.launchedAt;
    if (at && now - new Date(at).getTime() <= idleMs) n += 1;
  }
  return n;
}

/**
 * Tokens/min and USD/min over the trailing `windowMin` minutes, from the
 * per-minute cost series. Uses elapsed wall-clock in the window, so a session
 * that has been idle for 8 of the last 10 minutes reports a low rate.
 */
export function burnRate(s, now = Date.now(), windowMin = 10) {
  const cutoff = now - windowMin * MINUTE;
  let cost = 0;
  for (const [bucket, c] of s.costSeries) {
    if (bucket >= cutoff) cost += c;
  }
  const elapsedMin = Math.min(windowMin, s.firstTs ? (now - new Date(s.firstTs).getTime()) / MINUTE : windowMin);
  const mins = Math.max(1, elapsedMin);
  return { costPerMin: cost / mins, windowCost: cost, windowMin };
}

/** Drop cost-series buckets older than `keepMin` to bound memory. */
export function pruneSeries(s, now = Date.now(), keepMin = 180) {
  const cutoff = now - keepMin * MINUTE;
  for (const b of s.costSeries.keys()) {
    if (b < cutoff) s.costSeries.delete(b);
  }
}

function mapToSorted(map) {
  return [...map.entries()]
    .map(([key, v]) => ({ key, cost: v.cost, calls: v.calls, tokens: totalTokens(v.tokens) }))
    .sort((a, b) => b.cost - a.cost);
}

/** Compact summary for list views. */
export function summarize(s, now = Date.now(), idleMs = 5 * MINUTE) {
  const rate = burnRate(s, now);
  const subCost = [...s.subagents.values()].reduce((a, x) => a + x.cost, 0);
  const subActive = activeSubagents(s, now, idleMs);
  const active = isActive(s, now, idleMs);
  return {
    sessionId: s.sessionId,
    title: s.title,
    project: s.project,
    projectLabel: s.projectLabel,
    cwd: s.cwd,
    gitBranch: s.gitBranch,
    entrypoint: s.entrypoint,
    active,
    // Working, not merely recent. A session that dispatched async agents and
    // ended its own turn reads `end_turn`, so the parent's stop reason alone
    // would call a fleet of running subagents idle.
    busy: active && (s.lastStopReason === 'tool_use' || subActive > 0),
    idleMs: s.lastTs ? now - new Date(s.lastTs).getTime() : null,
    firstTs: s.firstTs,
    lastTs: s.lastTs,
    currentModel: s.currentModel,
    currentEffort: s.currentEffort,
    lastStopReason: s.lastStopReason,
    activeTools: s.activeTools,
    tokens: { ...s.tokens, total: totalTokens(s.tokens) },
    cost: s.cost,
    savedByCache: Math.max(0, s.uncachedCost - s.cost),
    cacheHitRatio: cacheHitRatio(s.tokens),
    context: s.context,
    subagentCount: s.subagents.size,
    subagentActiveCount: subActive,
    subagentCost: subCost,
    compactionCount: s.compactions.length,
    droppedTokens: s.compactions.reduce((a, c) => a + c.dropped, 0),
    compactionMs: s.compactions.reduce((a, c) => a + c.durationMs, 0),
    errorCount: s.errors.length,
    denialCount: s.denials.length,
    queuedOps: s.queuedOps,
    userMessages: s.userMessages,
    assistantMessages: s.assistantMessages,
    toolCalls: s.toolCalls,
    costPerMin: rate.costPerMin,
  };
}

/** Full record for the drill-down view. */
export function detail(s, now = Date.now(), idleMs = 5 * MINUTE) {
  return {
    ...summarize(s, now, idleMs),
    messages: s.messages,
    compactions: s.compactions,
    errors: s.errors,
    denials: s.denials,
    permissionMode: s.permissionMode,
    version: s.version,
    // Where the money went, by token class. Exact rather than apportioned:
    // computed per model before summing, so it reconciles with `cost`.
    costSplit: costSplit(s.perModel),
    perModel: mapToSorted(s.perModel),
    perSkill: mapToSorted(s.perSkill),
    perAgent: mapToSorted(s.perAgent),
    subagents: [...s.subagents.values()]
      .map((x) => ({
        ...x,
        tokens: { ...x.tokens, total: totalTokens(x.tokens) },
        active: Boolean((x.lastTs || x.launchedAt)
          && now - new Date(x.lastTs || x.launchedAt).getTime() <= idleMs),
      }))
      .sort((a, b) => b.cost - a.cost),
  };
}
