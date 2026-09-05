import { readdir, stat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';

const SESSION_RE = /^([0-9a-f-]{36})\.jsonl$/i;
const AGENT_RE = /^agent-([0-9a-z]+)\.jsonl$/i;

/**
 * Discovers every transcript under ~/.claude/projects.
 *
 * Layout:
 *   <project>/<sessionId>.jsonl                      main session
 *   <project>/<sessionId>/subagents/agent-<id>.jsonl subagent sidechain
 */
export async function discover(projectsDir) {
  const found = [];
  let projects;
  try {
    projects = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const projPath = join(projectsDir, proj.name);
    let entries;
    try {
      entries = await readdir(projPath, { withFileTypes: true });
    } catch { continue; }

    for (const entry of entries) {
      if (entry.isFile()) {
        const m = entry.name.match(SESSION_RE);
        if (m) found.push({ kind: 'session', sessionId: m[1], project: proj.name, path: join(projPath, entry.name), root: projectsDir });
      } else if (entry.isDirectory()) {
        const subDir = join(projPath, entry.name, 'subagents');
        let agents;
        try {
          agents = await readdir(subDir, { withFileTypes: true });
        } catch { continue; }
        for (const a of agents) {
          const am = a.isFile() && a.name.match(AGENT_RE);
          if (am) {
            found.push({
              kind: 'subagent',
              sessionId: entry.name,
              agentId: am[1],
              project: proj.name,
              path: join(subDir, a.name),
              root: projectsDir,
            });
          }
        }
      }
    }
  }
  return found;
}

/**
 * Discovers across several transcript roots at once.
 *
 * Roots are deduplicated by resolved real path: the same directory reached via
 * two paths (a bind mount and its target, say) would otherwise double every
 * session's cost. Roots that cannot be read are reported rather than thrown, so
 * one bad path in settings does not blind the whole scan.
 */
export async function discoverAll(dirs = []) {
  const files = [];
  const problems = [];
  const seenRoots = new Set();
  const seenFiles = new Set();

  for (const dir of dirs) {
    if (!dir) continue;
    let real;
    try {
      real = await realpath(dir);
    } catch (err) {
      problems.push({ dir, message: err.code === 'ENOENT' ? 'Does not exist' : err.message });
      continue;
    }
    if (seenRoots.has(real)) continue;
    seenRoots.add(real);

    const found = await discover(dir);
    if (!found.length) problems.push({ dir, message: 'No session transcripts found' });
    for (const f of found) {
      // Guard against the same file surfacing through two roots.
      let key;
      try { key = await realpath(f.path); } catch { key = f.path; }
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      files.push(f);
    }
  }
  return { files, problems, roots: [...seenRoots] };
}

/**
 * Incremental append-only reader. Remembers a byte offset per file and on each
 * call yields only the lines appended since last time. A file that shrank
 * (rotated or rewritten) is re-read from zero.
 */
export class TailReader {
  constructor() {
    /** @type {Map<string, {offset: number, partial: string, mtimeMs: number}>} */
    this.files = new Map();
  }

  /** Has this file changed since we last read it? Cheap mtime+size check. */
  async changed(path) {
    let s;
    try { s = await stat(path); } catch { return false; }
    const prev = this.files.get(path);
    if (!prev) return true;
    return s.size !== prev.offset || s.mtimeMs !== prev.mtimeMs;
  }

  /**
   * Reads new lines from `path`. Returns { lines, reset, mtimeMs, size }.
   * `reset` is true when the file shrank and the caller must discard prior state.
   */
  async read(path) {
    let s;
    try { s = await stat(path); } catch { return { lines: [], reset: false, mtimeMs: 0, size: 0 }; }

    let state = this.files.get(path);
    let reset = false;
    if (!state) {
      state = { offset: 0, partial: '', mtimeMs: 0 };
      this.files.set(path, state);
    } else if (s.size < state.offset) {
      state.offset = 0;
      state.partial = '';
      reset = true;
    }

    if (s.size === state.offset) {
      state.mtimeMs = s.mtimeMs;
      return { lines: [], reset, mtimeMs: s.mtimeMs, size: s.size };
    }

    const fh = await open(path, 'r');
    try {
      const length = s.size - state.offset;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await fh.read(buf, 0, length, state.offset);
      const chunk = state.partial + buf.subarray(0, bytesRead).toString('utf8');
      state.offset += bytesRead;
      state.mtimeMs = s.mtimeMs;

      const parts = chunk.split('\n');
      // A trailing fragment means the writer is mid-line; hold it for next read.
      state.partial = parts.pop() ?? '';

      const lines = [];
      for (const p of parts) {
        if (!p.trim()) continue;
        try { lines.push(JSON.parse(p)); } catch { /* skip torn or malformed line */ }
      }
      return { lines, reset, mtimeMs: s.mtimeMs, size: s.size };
    } finally {
      await fh.close();
    }
  }

  forget(path) { this.files.delete(path); }
}

/** Flatten a message `content` field into plain text for display. */
export function contentToText(content, { maxLen = 2000 } = {}) {
  if (typeof content === 'string') return content.slice(0, maxLen);
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.text) out.push(block.text);
    else if (block.type === 'thinking') out.push('[thinking]');
    else if (block.type === 'tool_use') out.push(`[tool: ${block.name}]`);
    else if (block.type === 'tool_result') out.push('[tool result]');
  }
  return out.join('\n').slice(0, maxLen);
}

/**
 * Just the prose a human wrote or read — text blocks only.
 * Thinking, tool calls and tool results are deliberately excluded: they are
 * surfaced as their own annotations, and letting them into the message body
 * turns the transcript view into a wall of "[tool result]".
 */
export function proseOf(content, { maxLen = 800 } = {}) {
  if (typeof content === 'string') return content.slice(0, maxLen);
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
    .slice(0, maxLen);
}

/** Names of tools invoked in an assistant message, in order. */
export function toolNames(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b?.type === 'tool_use' && b.name).map((b) => b.name);
}
