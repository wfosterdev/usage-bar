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
 * Fires once per threshold per reset window. Keyed on the limit's `resetsAt`,
 * so crossing 75% again after the window rolls over re-arms and notifies again,
 * but a percentage oscillating around 75% inside one window does not spam.
 *
 * Three separate things keep the volume down, because usage moves in jumps and
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
    /** @type {Map<string, {resetsAt: string|null, fired: Set<number>}>} */
    this.state = new Map();
    this.lastNotifyAt = -Infinity;
  }

  check(limits) {
    if (!this.enabled) return [];
    const fired = [];
    for (const l of limits) {
      if (typeof l.percent !== 'number') continue;
      const st = this.#stateFor(l);

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
    for (const l of limits) {
      if (typeof l.percent !== 'number') continue;
      const st = this.#stateFor(l);
      for (const th of this.thresholds) if (l.percent >= th) st.fired.add(th);
    }
  }

  /**
   * Per-limit dedup state, re-armed when the window rolls over.
   *
   * The key has to separate every limit the account reports. Keying on kind and
   * model alone collided two scoped weekly limits with no model, and since they
   * carried different reset times each poll looked like a rollover to the other
   * one — which re-armed the thresholds and pinged, forever.
   */
  #stateFor(l) {
    const key = [
      l.kind,
      l.group || '',
      l.scope?.model?.display_name || l.scope?.model?.id || '',
      l.scope?.surface || '',
      l.label || '',
    ].join('|');
    const st = this.state.get(key);
    if (st && !windowRolled(st.resetsAt, l.resetsAt)) return st;
    const fresh = { resetsAt: l.resetsAt, fired: new Set() };
    this.state.set(key, fresh);
    return fresh;
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

/**
 * True when `next` is a genuinely later window than `prev`.
 *
 * Deliberately not `prev !== next`: an out-of-order or briefly stale reading
 * would look like a rollover and re-arm every threshold.
 */
function windowRolled(prev, next) {
  if (prev === next) return false;
  const a = Date.parse(prev ?? '');
  const b = Date.parse(next ?? '');
  if (Number.isNaN(a) || Number.isNaN(b)) return true;  // not dates — trust inequality
  return b > a;
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

export { DEFAULT_THRESHOLDS, DEFAULT_COOLDOWN_MS };
