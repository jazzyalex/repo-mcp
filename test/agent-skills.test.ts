import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_BASE } from '../src/version.js';

function run(args: string[], home: string) {
  return spawnSync('python3', ['scripts/install-agent-skills.py', ...args], {
    cwd: PROJECT_BASE,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, REPO_MCP_HOME: path.join(home, 'app-support'), REPO_MCP_STATE_DIR: path.join(home, 'app-support/state'), HOME: home, CODEX_HOME: path.join(home, 'codex'), CLAUDE_HOME: path.join(home, 'claude') }
  });
}

test('agent skill installer installs, checks and detects stale copies', async t => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-agent-skills-')));
  t.after(() => rm(home, { recursive: true, force: true }));

  const before = run(['--check'], home);
  assert.equal(before.status, 1);
  assert.match(before.stdout, /missing or stale/);

  const installed = run(['--install'], home);
  assert.equal(installed.status, 0, installed.stderr);

  const pairs = [
    ['.codex/skills/repo-mcp/SKILL.md', 'codex/skills/repo-mcp/SKILL.md'],
    ['.codex/skills/repo-mcp-architect/SKILL.md', 'codex/skills/repo-mcp-architect/SKILL.md'],
    ['.claude/skills/repo-mcp/SKILL.md', 'claude/skills/repo-mcp/SKILL.md'],
    ['.claude/skills/repo-mcp-review/SKILL.md', 'claude/skills/repo-mcp-review/SKILL.md'],
    ['.claude/skills/repo-mcp-architect/SKILL.md', 'claude/skills/repo-mcp-architect/SKILL.md']
  ];
  for (const [source, target] of pairs) {
    assert.equal(
      await readFile(path.join(home, target), 'utf8'),
      await readFile(path.join(PROJECT_BASE, source), 'utf8')
    );
  }
  assert.equal(run(['--check'], home).status, 0);
  const installedTarget = path.join(home, pairs[0][1]);
  const beforeNoop = await stat(installedTarget);
  const noop = run(['--install'], home);
  const afterNoop = await stat(installedTarget);
  assert.equal(noop.status, 0, noop.stderr);
  assert.match(noop.stdout, /current:/);
  assert.equal(afterNoop.ino, beforeNoop.ino, 'a current owned skill must not be rewritten');
  assert.equal(afterNoop.mtimeMs, beforeNoop.mtimeMs, 'a current owned skill must keep its timestamp');

  await writeFile(path.join(home, pairs[0][1]), 'stale\n');
  assert.equal(run(['--check'], home).status, 1);
  assert.notEqual(run(['--install'], home).status, 0);
  assert.equal(await readFile(path.join(home, pairs[0][1]), 'utf8'), 'stale\n');
  const replaced = run(['--install', '--replace'], home);
  assert.equal(replaced.status, 0, replaced.stderr);
  const state = JSON.parse(await readFile(path.join(home, 'app-support/agent-skills/installed.json'), 'utf8'));
  assert.equal(await readFile(state.skills[path.join(home, pairs[0][1])].backup, 'utf8'), 'stale\n');
  assert.equal(run(['--check'], home).status, 0);
});

test('agent skill uninstall is selective, ownership-aware and preserves other clients', async t => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-agent-skills-uninstall-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(run(['--install'], home).status, 0);

  const codex = path.join(home, 'codex/skills/repo-mcp/SKILL.md');
  const codexArchitect = path.join(home, 'codex/skills/repo-mcp-architect/SKILL.md');
  const claudeSetup = path.join(home, 'claude/skills/repo-mcp/SKILL.md');
  const claudeReview = path.join(home, 'claude/skills/repo-mcp-review/SKILL.md');
  const claudeArchitect = path.join(home, 'claude/skills/repo-mcp-architect/SKILL.md');
  const codexBefore = await stat(codex);
  assert.equal((await stat(path.dirname(claudeSetup))).mode & 0o777, 0o700);

  const removed = run(['--uninstall', '--client', 'claude'], home);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /removed:.*claude\/skills\/repo-mcp\/SKILL\.md/);
  assert.match(removed.stdout, /removed:.*claude\/skills\/repo-mcp-review\/SKILL\.md/);
  assert.match(removed.stdout, /removed:.*claude\/skills\/repo-mcp-architect\/SKILL\.md/);
  await assert.rejects(stat(claudeSetup), { code: 'ENOENT' });
  await assert.rejects(stat(claudeReview), { code: 'ENOENT' });
  await assert.rejects(stat(claudeArchitect), { code: 'ENOENT' });
  const codexAfter = await stat(codex);
  assert.equal(codexAfter.ino, codexBefore.ino);
  assert.equal(codexAfter.mtimeMs, codexBefore.mtimeMs);
  assert.equal(run(['--check', '--client', 'claude'], home).status, 1);
  assert.equal(run(['--check', '--client', 'codex'], home).status, 0);
  const state = JSON.parse(await readFile(path.join(home, 'app-support/agent-skills/installed.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.skills).sort(), [codex, codexArchitect].sort());

  assert.equal(run(['--install', '--client', 'claude'], home).status, 0);
  await writeFile(claudeSetup, 'user modification\n');
  const refused = run(['--uninstall', '--client', 'claude'], home);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Foreign or user-modified skill preserved/);
  assert.equal(await readFile(claudeSetup, 'utf8'), 'user modification\n');
  assert.equal(
    await readFile(claudeReview, 'utf8'),
    await readFile(path.join(PROJECT_BASE, '.claude/skills/repo-mcp-review/SKILL.md'), 'utf8')
  );
});

test('agent skill installer refuses a symlink destination', async t => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-agent-skills-link-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const target = path.join(home, 'codex/skills/repo-mcp/SKILL.md');
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(path.join(home, 'missing'), target);

  const result = run(['--install'], home);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to replace a non-regular skill file/);
});

test('foreign skills and symlinked parents are preserved', async t => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-foreign-skills-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const target = path.join(home, 'codex/skills/repo-mcp/SKILL.md');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'personal skill\n');
  assert.notEqual(run(['--install'], home).status, 0);
  assert.equal(await readFile(target, 'utf8'), 'personal skill\n');
  assert.equal(run(['--install', '--replace'], home).status, 0);
  const outside = path.join(home, 'outside');
  await mkdir(outside);
  await rm(path.dirname(target), { recursive: true });
  await symlink(outside, path.dirname(target));
  assert.notEqual(run(['--install', '--replace'], home).status, 0);
});

test('recognized installed hashes permit safe skill upgrades', async t => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-owned-skills-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(run(['--install'], home).status, 0);
  const statePath = path.join(home, 'app-support/agent-skills/installed.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const target = path.join(home, 'codex/skills/repo-mcp/SKILL.md');
  await writeFile(target, 'previous owned version\n');
  const { createHash } = await import('node:crypto');
  state.skills[target].sha256 = createHash('sha256').update('previous owned version\n').digest('hex');
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  const upgraded = run(['--install'], home);
  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.equal(await readFile(target, 'utf8'), await readFile(path.join(PROJECT_BASE, '.codex/skills/repo-mcp/SKILL.md'), 'utf8'));
});

test('ownership state refuses symlinks, permissive files and served checkouts', async t => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-skills-state-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(run(['--install'], home).status, 0);
  const statePath = path.join(home, 'app-support/agent-skills/installed.json');
  const { chmod } = await import('node:fs/promises');
  await chmod(statePath, 0o644);
  assert.notEqual(run(['--install'], home).status, 0);
  await rm(statePath);
  await symlink(path.join(home, 'missing'), statePath);
  assert.notEqual(run(['--install'], home).status, 0);
  const inside = spawnSync('python3', ['scripts/install-agent-skills.py', '--check'], {
    cwd: PROJECT_BASE, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, REPO_MCP_HOME: PROJECT_BASE }
  });
  assert.notEqual(inside.status, 0);
  assert.match(inside.stderr, /outside.*checkout|inside.*checkout/i);
});
