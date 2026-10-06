import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_BASE } from '../src/version.js';

function run(args: string[], home: string) {
  return spawnSync('python3', ['scripts/install-agent-skills.py', ...args], {
    cwd: PROJECT_BASE,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, 'codex'), CLAUDE_HOME: path.join(home, 'claude') }
  });
}

test('agent skill installer installs, checks and detects stale copies', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-agent-skills-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const before = run(['--check'], home);
  assert.equal(before.status, 1);
  assert.match(before.stdout, /missing or stale/);

  const installed = run(['--install'], home);
  assert.equal(installed.status, 0, installed.stderr);

  const pairs = [
    ['.codex/skills/repo-mcp/SKILL.md', 'codex/skills/repo-mcp/SKILL.md'],
    ['.claude/skills/repo-mcp/SKILL.md', 'claude/skills/repo-mcp/SKILL.md'],
    ['.claude/skills/repo-mcp-review/SKILL.md', 'claude/skills/repo-mcp-review/SKILL.md']
  ];
  for (const [source, target] of pairs) {
    assert.equal(
      await readFile(path.join(home, target), 'utf8'),
      await readFile(path.join(PROJECT_BASE, source), 'utf8')
    );
  }
  assert.equal(run(['--check'], home).status, 0);

  await writeFile(path.join(home, pairs[0][1]), 'stale\n');
  assert.equal(run(['--check'], home).status, 1);
});

test('agent skill installer refuses a symlink destination', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-agent-skills-link-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const target = path.join(home, 'codex/skills/repo-mcp/SKILL.md');
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(path.join(home, 'missing'), target);

  const result = run(['--install'], home);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to replace a non-regular skill file/);
});
