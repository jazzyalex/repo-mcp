import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, mkdtemp, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { PROJECT_BASE, RELEASE_VERSION } from '../src/version.js';

function run(command: string, args: string[], cwd = PROJECT_BASE, timeout = 30_000) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('public source archive is deterministic, allowlisted and self-contained', { timeout: 240_000 }, async t => {
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
  const release = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-release-'));
  t.after(() => rm(release, { recursive: true, force: true }));
  const first = JSON.parse(run('python3', ['scripts/package-release.py', '--output-dir', release])) as { archive: string; sha256: string };
  const firstBytes = await readFile(first.archive);
  const second = JSON.parse(run('python3', ['scripts/package-release.py', '--output-dir', release])) as { archive: string; sha256: string };
  const secondBytes = await readFile(second.archive);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(firstBytes, secondBytes);

  const root = `repo-mcp-${RELEASE_VERSION}/`;
  const listing = run('tar', ['-tzf', first.archive]).trim().split('\n');
  for (const required of [
    'README.md', 'SETUP.md', 'SECURITY.md', 'AGENTS.md', 'CLAUDE.md', 'LICENSE', 'SOURCE-MANIFEST.json',
    'docs/MULTI-REPO-SPEC.md', 'docs/DESIGN-2B-PATH-POLICY.md', 'docs/WORKFLOW-SPEC.md',
    'docs/V1-HARDENING-SPEC.md', 'docs/PROVIDER-NEUTRAL-REVIEW-PLAN.md', '.claude/skills/repo-mcp/SKILL.md',
    '.claude/skills/repo-mcp-review/SKILL.md', '.claude/skills/repo-mcp-architect/SKILL.md',
    '.codex/skills/repo-mcp/SKILL.md', '.codex/skills/repo-mcp-architect/SKILL.md',
    'scripts/model-policy.ts', 'src/model-policy.ts', 'scripts/chatgpt-run.ts', 'src/chatgpt-run.ts', 'src/git-ref.ts',
    'src/multirepo-state.ts', 'src/multirepo-server.ts', 'test/multirepo.test.ts',
    'scripts/check-prerequisites.py', 'scripts/prerequisites.py', 'docs/policy-readonly.json', 'docs/policy-coding.json'
  ]) assert.ok(listing.includes(root + required), `missing ${required}`);
  assert.ok(listing.every(entry => entry.startsWith(root)));
  assert.ok(listing.every(entry =>
    !entry.includes('/.git/') && !entry.includes('/.trial/') && !entry.includes('/evidence/') &&
    !entry.includes('/release/') && !entry.includes('/node_modules/') && !entry.includes('/state/') &&
    !entry.includes('/credentials/') && !entry.includes('/captures/')
  ));
  // Validate an extraction with no .git or dist. Reuse already-installed
  // dependencies; the test has no network access requirement and never recurses
  // into this packaging test or modifies the control checkout's build output.
  run('tar', ['-xzf', first.archive, '-C', release]);
  const extracted = path.join(release, 'repo-mcp-' + RELEASE_VERSION);
  await assert.rejects(readFile(path.join(extracted, '.git')));
  const manifest = JSON.parse(await readFile(path.join(extracted, 'SOURCE-MANIFEST.json'), 'utf8'));
  const { createHash } = await import('node:crypto');
  for (const [relative, digest] of Object.entries(manifest)) {
    assert.equal(createHash('sha256').update(await readFile(path.join(extracted, relative))).digest('hex'), digest, relative);
  }
  await symlink(path.join(PROJECT_BASE, 'node_modules'), path.join(extracted, 'node_modules'), 'dir');
  run('npm', ['run', 'build'], extracted, 60_000);
  run(process.execPath, ['--import', 'tsx', '--test',
    'test/model-policy.test.ts', 'test/agent-skills.test.ts', 'test/onboarding.test.ts'], extracted, 120_000);
});
