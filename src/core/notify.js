import { execFile } from 'node:child_process';
import { platform } from 'node:os';

const DEFAULT_THRESHOLDS = [50, 75, 90, 95];

/**
 * Quiet period between desktop notifications. Fifteen minutes, because the
 * limits these watch move over hours: two pings inside one quarter of an hour
 * are telling you something you already knew and just looked at.
 *
 * It gates the desktop ping only. The alerts list, the web UI and the webhook
 * still see every event — this is about how loudly they arrive, not whether
 * they are recorded.
 */
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * How far usage must fall back below a threshold before that threshold can
 * fire again. Weekly limits are rolling windows: the percentage drifts down as
 * old usage ages out, so a reading that wobbles across 75% must not be read as
 * a fresh crossing every time it wobbles. A genuine window reset drops usage to
 * near zero, which clears this by a mile.
 */
const REARM_MARGIN = 5;

/**
 * Fires once per threshold, and does not fire again until usage has genuinely
 * fallen back below it.
 *
 * The re-arm signal is the percentage itself, not the limit's `resets_at`. A
 * reset time is a poor proxy for a new window: it creeps, it arrives stale or
 * out of order, it is sometimes absent, and every one of those looked like a
 * rollover — which re-armed the whole ladder and pinged on the next poll, once
 * a minute, forever. Usage falling back is unambiguous, and a real reset
 * produces it anyway by dropping the percentage to nearly nothing.
 *
 * Three further things keep the volume down, because usage moves in jumps and
 * an account reports several limits at once:
 *
 *   - a jump past more than one threshold notifies for the HIGHEST only, and
 *     silently arms the rest — 40% to 92% is one event, not three;
 *   - several limits crossing in the same poll produce one combined desktop
 *     notification rather than one each;
 *   - a cooldown suppresses the desktop ping entirely for a while afterwards,
 *     unless the new crossing is higher than the one that started it. An
 *     escalation is the one thing a quiet period must never swallow.
 */
export class ThresholdNotifier {
  constructor({
    thresholds = DEFAULT_THRESHOLDS,
    webhook = null,
    enabled = true,
    onEvent = null,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    // Injectable so the suite can assert on what would be shown without
    // actually shelling out to osascript on every run.
    deliver = desktopNotify,
    now = () => Date.now(),
  } = {}) {
    this.thresholds = [...thresholds].sort((a, b) => a - b);
    this.webhook = webhook;
    this.enabled = enabled;
    this.onEvent = onEvent;
    this.cooldownMs = Math.max(0, Number(cooldownMs) || 0);
    this.deliver = deliver;
    this.now = now;
    /** @type {Map<string, {fired: Set<number>}>} */
    this.state = new Map();
    this.lastNotifyAt = -Infinity;
  }

  check(limits) {
    if (!this.enabled) return [];
    const fired = [];
    for (const { limit: l, state: st } of this.#walk(limits)) {
      // Anything usage has dropped back under is armed again, so the next
      // climb past it is news. This is the only way a threshold re-arms.
      for (const th of st.fired) if (l.percent < th - REARM_MARGIN) st.fired.delete(th);

      // Every newly crossed threshold is armed, but only the top one is an
      // event. Arming the others is what stops them firing on the next poll.
      const crossed = this.thresholds.filter((th) => l.percent >= th && !st.fired.has(th));
      if (!crossed.length) continue;
      for (const th of crossed) st.fired.add(th);

      const th = crossed[crossed.length - 1];
      fired.push({
        threshold: th,
        percent: l.percent,
        label: l.label,
        kind: l.kind,
        resetsAt: l.resetsAt,
        severity: l.severity,
        title: `Claude usage ${l.percent}%`,
        body: `${l.label} crossed ${th}%${l.resetsAt ? ` · resets ${formatReset(l.resetsAt)}` : ''}`,
      });
    }
    if (fired.length) this.#dispatch(fired);
    return fired;
  }

  /** Pre-arm thresholds already crossed, so starting at 80% doesn't fire 50 and 75. */
  prime(limits) {
    for (const { limit: l, state: st } of this.#walk(limits)) {
      for (const th of this.thresholds) if (l.percent >= th) st.fired.add(th);
    }
  }

  /**
   * Pairs each limit with its own dedup state, creating it on first sight.
   *
   * The key has to separate every limit the account reports, because two limits
   * sharing one state would re-arm each other on every poll. Kind and model
   * alone collided two scoped weekly limits with no model, so the key carries
   * group, surface and label too — and an occurrence counter behind that, so
   * entries that are genuinely indistinguishable still get a state each rather
   * than trading one back and forth.
   */
  #walk(limits) {
    const seen = new Map();
    const out = [];
    for (const l of limits) {
      if (typeof l.percent !== 'number') continue;
      const base = [
        l.kind,
        l.group || '',
        l.scope?.model?.display_name || l.scope?.model?.id || '',
        l.scope?.surface || '',
        l.label || '',
      ].join('|');
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      const key = n ? `${base}#${n}` : base;

      let st = this.state.get(key);
      if (!st) { st = { fired: new Set() }; this.state.set(key, st); }
      out.push({ limit: l, state: st });
    }
    return out;
  }

  #dispatch(events) {
    // The data feeds get everything; only the desktop ping is rationed.
    for (const e of events) {
      if (this.onEvent) { try { this.onEvent(e); } catch { /* listener must not break polling */ } }
      if (this.webhook) postWebhook(this.webhook, e);
    }

    const top = events.reduce((a, b) => (b.threshold > a.threshold ? b : a));
    const now = this.now();
    // Not "higher than the last ping": inside one window thresholds only ever
    // rise, so that would let the whole ladder through and ration nothing.
    const final = top.threshold >= this.thresholds[this.thresholds.length - 1];
    if (!final && now - this.lastNotifyAt < this.cooldownMs) return;

    this.lastNotifyAt = now;

    if (events.length === 1) {
      this.deliver(top.title, top.body);
    } else {
      // One line per limit, so a combined ping still says which ones moved.
      const body = events.map((e) => `${e.label} ${e.percent}%`).join('\n');
      this.deliver(`Claude usage · ${events.length} limits past ${top.threshold}%`, body);
    }
  }
}

function formatReset(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3600_000);
  const m = Math.round((ms % 3600_000) / 60_000);
  return h ? `in ${h}h ${m}m` : `in ${m}m`;
}

function desktopNotify(title, body) {
  const os = platform();
  if (os === 'darwin') {
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Submarine"`;
    execFile('osascript', ['-e', script], () => {});
  } else if (os === 'linux') {
    execFile('notify-send', [title, body], (err) => {
      if (err) process.stderr.write(`\x07[usage-bar] ${title}: ${body}\n`);
    });
  } else {
    process.stderr.write(`\x07[usage-bar] ${title}: ${body}\n`);
  }
}

async function postWebhook(url, event) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `${event.title} — ${event.body}`, event }),
    });
  } catch { /* a dead webhook must not break polling */ }
}

export { DEFAULT_THRESHOLDS, DEFAULT_COOLDOWN_MS, REARM_MARGIN };
