import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_BASE, RELEASE_VERSION } from '../src/version.js';

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: PROJECT_BASE, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('public source archive is deterministic, allowlisted and self-contained', async () => {
  assert.equal(
    await readFile(path.join(PROJECT_BASE, 'README.md'), 'utf8'),
    await readFile(path.join(PROJECT_BASE, 'docs/PUBLIC-README.md'), 'utf8'),
    'repository and packaged public README must stay identical'
  );
  const packageJson = JSON.parse(await readFile(path.join(PROJECT_BASE, 'package.json'), 'utf8')) as { version: string; scripts?: Record<string, string> };
  const packageLock = JSON.parse(await readFile(path.join(PROJECT_BASE, 'package-lock.json'), 'utf8')) as { version: string; packages?: Record<string, { version?: string }> };
  assert.equal(packageLock.version, packageJson.version, 'package-lock top-level version must match package.json');
  assert.equal(packageLock.packages?.['']?.version, packageJson.version, 'package-lock root package version must match package.json');
  assert.equal(packageJson.scripts?.start, 'node dist/src/service-main.js', 'npm start must launch the production multi-repository broker');
  const installer = await readFile(path.join(PROJECT_BASE, 'scripts/install-server-service.py'), 'utf8');
  assert.match(installer, /npm run coord -- service start/, 'installer guidance must use the grouped production service command');
  assert.doesNotMatch(installer, /npm run coord -- start(?:\s|['"])/, 'installer must not print the obsolete ungrouped start command');
  const release = path.join(PROJECT_BASE, 'release');
  await rm(release, { recursive: true, force: true });
  const first = JSON.parse(run('python3', ['scripts/package-release.py'])) as { archive: string; sha256: string };
  const firstBytes = await readFile(first.archive);
  const second = JSON.parse(run('python3', ['scripts/package-release.py'])) as { archive: string; sha256: string };
  const secondBytes = await readFile(second.archive);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(firstBytes, secondBytes);

  const root = `repo-mcp-${RELEASE_VERSION}/`;
  const listing = run('tar', ['-tzf', first.archive]).trim().split('\n');
  for (const required of [
    'README.md', 'SETUP.md', 'SECURITY.md', 'LICENSE', 'SOURCE-MANIFEST.json',
    'docs/MULTI-REPO-SPEC.md', 'docs/DESIGN-2B-PATH-POLICY.md', 'docs/WORKFLOW-SPEC.md',
    'docs/V1-HARDENING-SPEC.md', '.claude/skills/repo-mcp-review/SKILL.md',
    '.codex/skills/repo-mcp/SKILL.md',
    'scripts/model-policy.ts', 'src/model-policy.ts',
    'src/multirepo-state.ts', 'src/multirepo-server.ts', 'test/multirepo.test.ts'
  ]) assert.ok(listing.includes(root + required), `missing ${required}`);
  assert.ok(listing.every(entry => entry.startsWith(root)));
  assert.ok(listing.every(entry =>
    !entry.includes('/.git/') && !entry.includes('/.trial/') && !entry.includes('/evidence/') &&
    !entry.includes('/release/') && !entry.includes('/node_modules/') && !entry.includes('/state/') &&
    !entry.includes('/credentials/') && !entry.includes('/captures/')
  ));
});
