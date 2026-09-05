/**
 * Helpers for the encoded project-directory names Claude Code writes under
 * <claude>/projects. Path *resolution* lives in config.js — this file only
 * decodes names into something human-readable.
 */

/** Claude Code encodes a cwd into a dir name by replacing non-alphanumerics with '-'. */
export function decodeProjectDir(name) {
  return name.replace(/^-/, '/').replace(/-/g, '/');
}

/** Short label for a project dir: the last couple of meaningful path segments. */
export function projectLabel(name) {
  const parts = name.split('-').filter(Boolean);
  return parts.slice(-2).join('/') || name;
}
