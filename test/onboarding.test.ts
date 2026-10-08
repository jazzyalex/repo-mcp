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
  assert.match(reviewSkill, /base_ref: "HEAD\^"/);
  assert.match(reviewSkill, /Never\s+return `SHIP`.*working tree is clean/is);
  assert.match(reviewSkill, /Execution surface: Claude Code/);
  assert.match(reviewSkill, /does not launch\s+ChatGPT or choose a ChatGPT model/is);
  const claudeSkill = await readFile(path.join(PROJECT_BASE, '.claude/skills/repo-mcp/SKILL.md'), 'utf8');
  assert.match(claudeSkill, /When this Claude conversation is doing the requested work/i);
  assert.match(claudeSkill, /immediately consume that grant itself/i);
  assert.match(claudeSkill, /Never make that handoff the default current-session\s+workflow/i);
  assert.match(claudeSkill, /claude mcp add --scope user --transport http repo-mcp http:\/\/127\.0\.0\.1:8787\/mcp/);
  assert.match(claudeSkill, /WorkingDirectory.*control checkout/is);
  const codexSkill = await readFile(path.join(PROJECT_BASE, '.codex/skills/repo-mcp/SKILL.md'), 'utf8');
  assert.match(codexSkill, /claude mcp get repo-mcp/i);
  assert.match(codexSkill, /http:\/\/127\.0\.0\.1:8787\/mcp/);
  assert.match(codexSkill, /WorkingDirectory.*control checkout/is);
  assert.match(codexSkill, /each configured real client route/i);
  assert.match(codexSkill, /unqualified request to "use Repo MCP review".*ChatGPT web/is);
  assert.match(codexSkill, /Do not satisfy that request with a Codex\s+subagent/is);
  assert.match(codexSkill, /model profile `review`.*Sol Extra High/is);
  assert.match(codexSkill, /never silently substitute a Codex subagent/is);
  assert.match(codexSkill, /execution surface \(`ChatGPT web`,\s+`Codex`, or `Claude Code`\)/is);
  assert.match(codexSkill, /Codex operator must resolve\/register the target\s+checkout/is);
  assert.match(codexSkill, /include the exact repository and task IDs in the submitted browser\s+prompt/is);
  const setup = await readFile(path.join(PROJECT_BASE, 'SETUP.md'), 'utf8');
  assert.match(setup, /Use Repo MCP to review this repository/);
  assert.match(setup, /Repo MCP supplies repository tools to the client that is already running/i);
  assert.match(setup, /Codex subagent with Repo MCP is a Codex review/i);
  assert.match(setup, /defaults to the token-saving route.*ChatGPT web/is);
  assert.doesNotMatch(setup, /ask Claude.*registered repository\/task IDs/i);
  assert.equal(await readFile(path.join(PROJECT_BASE, 'README.md'), 'utf8'), await readFile(path.join(PROJECT_BASE, 'docs/PUBLIC-README.md'), 'utf8'));
  const readOnly = compilePolicy(loadPolicy(JSON.parse(await readFile(path.join(PROJECT_BASE, 'docs/policy-readonly.json'), 'utf8')))).paths;
  const coding = compilePolicy(loadPolicy(JSON.parse(await readFile(path.join(PROJECT_BASE, 'docs/policy-coding.json'), 'utf8')))).paths;
  assert.equal(readOnly.decide('src/example.ts', 'write').ok, false);
  assert.equal(coding.decide('src/example.ts', 'write').ok, true);
  assert.equal(coding.decide('package.json', 'write').ok, false);
  assert.equal(coding.decide('src/.env', 'read').ok, false);
  assert.equal(coding.decide('dist/example.js', 'read').ok, false);
});
