import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { claudeHome, COMMAND_SOURCE_ALLOWED, DEFAULTS } from './config.js';

const run = promisify(execFile);

/** One phrasing for the keychain, used for both the origin and the label. */
function keychainLabel({ service, account } = {}) {
  const name = service || DEFAULTS.credentials.service;
  return `macOS keychain (${name}${account ? ` / ${account}` : ''})`;
}

export function defaultCredentialsPath() {
  return join(claudeHome(), '.credentials.json');
}

/* ---------- raw fetchers, one per source ---------- */

async function fromFile(path) {
  try {
    return { ok: true, raw: await readFile(path, 'utf8'), origin: path };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'no-credentials', message: `No credentials file at ${path}.` };
    if (err.code === 'EACCES') return { ok: false, reason: 'unreadable', message: `No permission to read ${path}.` };
    return { ok: false, reason: 'unreadable', message: `Could not read ${path}: ${err.message}` };
  }
}

/**
 * macOS stores Claude Code's OAuth blob in the login keychain rather than on
 * disk, so a file path alone cannot reach it. Reading it may prompt for
 * keychain access the first time.
 */
async function fromKeychain(service, account) {
  if (platform() !== 'darwin') {
    return { ok: false, reason: 'unsupported', message: 'The keychain source is only available on macOS.' };
  }
  const args = ['find-generic-password', '-s', service || DEFAULTS.credentials.service, '-w'];
  if (account) args.splice(3, 0, '-a', account);
  try {
    const { stdout } = await run('security', args, { timeout: 15000, maxBuffer: 1 << 20 });
    const raw = stdout.trim();
    if (!raw) return { ok: false, reason: 'no-credentials', message: `Keychain item "${service}" is empty.` };
    return { ok: true, raw, origin: keychainLabel({ service, account }) };
  } catch (err) {
    return {
      ok: false,
      reason: 'no-credentials',
      message: `Keychain lookup failed for "${service}". Check the item name in Keychain Access. (${(err.stderr || err.message || '').trim()})`,
    };
  }
}

async function fromCommand(command) {
  if (!COMMAND_SOURCE_ALLOWED) {
    return { ok: false, reason: 'disabled', message: 'The command source is disabled. Restart with USAGE_BAR_ALLOW_COMMAND=1.' };
  }
  try {
    const { stdout } = await run(process.env.SHELL || '/bin/sh', ['-c', command], { timeout: 20000, maxBuffer: 1 << 20 });
    const raw = stdout.trim();
    if (!raw) return { ok: false, reason: 'no-credentials', message: 'The command produced no output.' };
    return { ok: true, raw, origin: 'command' };
  } catch (err) {
    return { ok: false, reason: 'unreadable', message: `Command failed: ${(err.stderr || err.message || '').trim()}` };
  }
}

/* ---------- parsing ---------- */

/**
 * Accepts either the full credentials document or a bare token string, so a
 * `command` source can print whichever it has to hand.
 */
function parseCredentials(raw, origin) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('sk-ant-')) {
    return { ok: true, accessToken: trimmed, expiresAt: 0, subscriptionType: null, rateLimitTier: null, scopes: [], origin };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: 'malformed', message: `Credentials from ${origin} are neither JSON nor a bare sk-ant- token.` };
  }

  const oauth = parsed.claudeAiOauth || parsed;
  const accessToken = oauth.accessToken || oauth.access_token;
  if (!accessToken) {
    return { ok: false, reason: 'no-token', message: `No accessToken found in credentials from ${origin}.` };
  }

  const expiresAt = oauth.expiresAt ?? oauth.expires_at ?? 0;
  if (expiresAt && expiresAt < Date.now()) {
    return {
      ok: false, reason: 'expired', expiresAt, origin,
      message: 'The OAuth access token has expired. Run any Claude Code command to refresh it.',
    };
  }

  return {
    ok: true,
    accessToken,
    expiresAt,
    subscriptionType: oauth.subscriptionType || null,
    rateLimitTier: oauth.rateLimitTier || null,
    scopes: oauth.scopes || [],
    origin,
  };
}

/* ---------- public API ---------- */

/**
 * Resolves credentials from the configured source.
 *
 * Deliberately read-only: we never refresh the token. Claude Code rotates it
 * and rewrites its own store, and a refresh issued from here could rotate the
 * refresh token out from under the CLI. We re-read on every poll instead, so a
 * refresh by Claude Code is picked up immediately.
 */
export async function readCredentials(credentialsConfig = DEFAULTS.credentials) {
  const cfg = { ...DEFAULTS.credentials, ...(credentialsConfig || {}) };
  let result;

  switch (cfg.source) {
    case 'file':
      result = await fromFile(cfg.path || defaultCredentialsPath());
      break;
    case 'keychain':
      result = await fromKeychain(cfg.service, cfg.account);
      break;
    case 'command':
      result = await fromCommand(cfg.command);
      break;
    case 'token':
      result = cfg.token
        ? { ok: true, raw: cfg.token, origin: 'configured token' }
        : { ok: false, reason: 'no-token', message: 'No token configured.' };
      break;
    case 'auto':
    default: {
      // Standard file first; on macOS fall back to the keychain, which is where
      // Claude Code actually keeps them there.
      const path = cfg.path || defaultCredentialsPath();
      result = await fromFile(path);
      if (!result.ok && platform() === 'darwin') {
        const keychain = await fromKeychain(cfg.service, cfg.account);
        if (keychain.ok) result = keychain;
        else {
          return {
            ok: false, reason: 'no-credentials',
            message: `No credentials at ${path}, and the macOS keychain lookup failed. Set a location in Settings.`,
          };
        }
      }
      break;
    }
  }

  if (!result.ok) return result;
  return parseCredentials(result.raw, result.origin);
}

/** Is there a Claude Code item under this name in the login keychain? */
export async function keychainPresent(service = DEFAULTS.credentials.service, account = null) {
  if (platform() !== 'darwin') return false;
  // No `-w`: this asks whether the item exists, and deliberately does not ask
  // for the secret, so it does not trigger a keychain access prompt.
  const args = ['find-generic-password', '-s', service];
  if (account) args.push('-a', account);
  try {
    await run('security', args, { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Human description of where credentials are being read from.
 *
 * `auto` names the source it will actually land on rather than reciting the
 * whole chain: on a Mac there is usually no credentials file at all — Claude
 * Code keeps the blob in the login keychain — and reporting the path it is
 * about to miss reads as though auto-detection had settled on the file.
 */
export function describeSource(credentialsConfig = DEFAULTS.credentials) {
  const cfg = { ...DEFAULTS.credentials, ...(credentialsConfig || {}) };
  switch (cfg.source) {
    case 'file': return cfg.path || defaultCredentialsPath();
    case 'keychain': return keychainLabel(cfg);
    case 'command': return `command · ${cfg.command}`;
    case 'token': return 'pasted token';
    default: {
      const path = cfg.path || defaultCredentialsPath();
      if (existsSync(path)) return `auto · ${path}`;
      // No file: on macOS the keychain is where it will come from, and
      // elsewhere the path is still the most useful thing to name in the
      // failure that follows.
      return platform() === 'darwin' ? `auto · ${keychainLabel(cfg)}` : `auto · ${path}`;
    }
  }
}
