import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT_BASE } from '../src/version.js';
import { loadPolicy, compilePolicy } from '../src/policy.js';

test('normal installation enforces Python 3.9 and keeps pytest optional', () => {
  const script = "import sys; sys.path.insert(0, 'scripts'); from prerequisites import require_python; require_python((3, 8))";
  const old = spawnSync('python3', ['-c', script], { cwd: PROJECT_BASE, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(old.status, 0);
  assert.match(old.stderr, /Python 3\.9.*pytest.*optional/s);
  const current = spawnSync('python3', ['scripts/check-prerequisites.py', '--python-only'], { cwd: PROJECT_BASE, encoding: 'utf8', timeout: 5000 });
  assert.equal(current.status, 0, current.stderr);
});

test('onboarding documents, skills and safe policies agree', async () => {
  for (const file of ['README.md', 'SETUP.md', '.codex/skills/repo-mcp/SKILL.md', '.claude/skills/repo-mcp/SKILL.md']) {
    const text = await readFile(path.join(PROJECT_BASE, file), 'utf8');
    assert.match(text, /Python 3\.9/);
    assert.match(text, /check-prerequisites\.py/);
    assert.match(text, /repo-mcp-onboarding/);
    assert.match(text, /repo-mcp-onboarding-smoke/);
    assert.match(text, /repository resolve/);
  }
  const reviewSkill = await readFile(path.join(PROJECT_BASE, '.claude/skills/repo-mcp-review/SKILL.md'), 'utf8');
  assert.match(reviewSkill, /user does not need to know or supply repository IDs/i);
  assert.match(reviewSkill, /repository resolve --repo CURRENT_ROOT/);
  assert.match(reviewSkill, /Do not ask the user to invent an ID/i);
  assert.equal(await readFile(path.join(PROJECT_BASE, 'README.md'), 'utf8'), await readFile(path.join(PROJECT_BASE, 'docs/PUBLIC-README.md'), 'utf8'));
  const readOnly = compilePolicy(loadPolicy(JSON.parse(await readFile(path.join(PROJECT_BASE, 'docs/policy-readonly.json'), 'utf8')))).paths;
  const coding = compilePolicy(loadPolicy(JSON.parse(await readFile(path.join(PROJECT_BASE, 'docs/policy-coding.json'), 'utf8')))).paths;
  assert.equal(readOnly.decide('src/example.ts', 'write').ok, false);
  assert.equal(coding.decide('src/example.ts', 'write').ok, true);
  assert.equal(coding.decide('package.json', 'write').ok, false);
  assert.equal(coding.decide('src/.env', 'read').ok, false);
  assert.equal(coding.decide('dist/example.js', 'read').ok, false);
});
