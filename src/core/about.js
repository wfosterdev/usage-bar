/* Identity in one place. The version is read from package.json rather than
   restated here, so `npm version` remains the only thing to bump — a build whose
   About box disagrees with its download filename is a bug report waiting to be
   filed. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readVersion() {
  try {
    const path = fileURLToPath(new URL('../../package.json', import.meta.url));
    return JSON.parse(readFileSync(path, 'utf8')).version || '0.0.0';
  } catch {
    // A missing package.json means a broken install, not a reason to refuse to
    // start. The dashboard still works; it just cannot say which build it is.
    return '0.0.0';
  }
}

export const ABOUT = Object.freeze({
  name: 'usage-bar',
  version: readVersion(),
  author: 'William Foster',
  homepage: 'https://wfoster.dev',
  repository: 'https://github.com/wfosterdev/usage-bar',
  licence: 'MIT',
});
