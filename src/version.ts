import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function packageAt(candidate: string) {
  try {
    const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown; version?: unknown };
    if (parsed.name === 'repo-mcp' && typeof parsed.version === 'string' && parsed.version.length) return parsed.version;
  } catch {}
  return undefined;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.join(here, '..', 'package.json'),
  path.join(here, '..', '..', 'package.json')
];
let found: { base: string; version: string } | undefined;
for (const candidate of candidates) {
  const version = packageAt(candidate);
  if (version) { found = { base: path.dirname(candidate), version }; break; }
}
if (!found) throw new Error('Unable to locate the repo-mcp package.json for canonical version reporting.');

export const PROJECT_BASE = found.base;
export const RELEASE_VERSION = found.version;
