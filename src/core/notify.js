import { execFile } from 'node:child_process';
import { platform } from 'node:os';

const DEFAULT_THRESHOLDS = [50, 75, 90, 95];

/**
 * Fires once per threshold per reset window. Keyed on the limit's `resetsAt`,
 * so crossing 75% again after the window rolls over re-arms and notifies again,
 * but a percentage oscillating around 75% inside one window does not spam.
 */
export class ThresholdNotifier {
  constructor({ thresholds = DEFAULT_THRESHOLDS, webhook = null, enabled = true, onEvent = null } = {}) {
    this.thresholds = [...thresholds].sort((a, b) => a - b);
    this.webhook = webhook;
    this.enabled = enabled;
    this.onEvent = onEvent;
    /** @type {Map<string, {resetsAt: string|null, fired: Set<number>}>} */
    this.state = new Map();
  }

  check(limits) {
    if (!this.enabled) return [];
    const fired = [];
    for (const l of limits) {
      if (typeof l.percent !== 'number') continue;
      const key = `${l.kind}:${l.scope?.model?.display_name || ''}`;
      let st = this.state.get(key);
      if (!st || st.resetsAt !== l.resetsAt) {
        st = { resetsAt: l.resetsAt, fired: new Set() };
        this.state.set(key, st);
      }
      for (const th of this.thresholds) {
        if (l.percent >= th && !st.fired.has(th)) {
          st.fired.add(th);
          const event = {
            threshold: th,
            percent: l.percent,
            label: l.label,
            kind: l.kind,
            resetsAt: l.resetsAt,
            severity: l.severity,
            title: `Claude usage ${l.percent}%`,
            body: `${l.label} crossed ${th}%${l.resetsAt ? ` · resets ${formatReset(l.resetsAt)}` : ''}`,
          };
          fired.push(event);
        }
      }
    }
    for (const e of fired) this.#dispatch(e);
    return fired;
  }

  /** Pre-arm thresholds already crossed, so starting at 80% doesn't fire 50 and 75. */
  prime(limits) {
    for (const l of limits) {
      if (typeof l.percent !== 'number') continue;
      const key = `${l.kind}:${l.scope?.model?.display_name || ''}`;
      const st = { resetsAt: l.resetsAt, fired: new Set(this.thresholds.filter((t) => l.percent >= t)) };
      this.state.set(key, st);
    }
  }

  #dispatch(event) {
    if (this.onEvent) { try { this.onEvent(event); } catch { /* listener must not break polling */ } }
    desktopNotify(event.title, event.body);
    if (this.webhook) postWebhook(this.webhook, event);
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

export { DEFAULT_THRESHOLDS };
