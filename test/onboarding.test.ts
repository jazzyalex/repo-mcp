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
  assert.match(reviewSkill, /exact immutable resolved base commit recorded by `chatgpt-run`/i);
  assert.match(reviewSkill, /never[\s\S]*choose `HEAD\^` after preparation/i);
  assert.match(reviewSkill, /Never\s+return `SHIP`.*working tree is clean/is);
  assert.doesNotMatch(reviewSkill, /Execution surface: Claude Code/);
  assert.match(reviewSkill, /ChatGPT web performs the semantic review/is);
  assert.match(reviewSkill, /Claude's host-native browser controls/is);
  assert.match(reviewSkill, /durable `chatgpt-run`/i);
  assert.match(reviewSkill, /Execution surface:\s+ChatGPT web/is);
  assert.match(reviewSkill, /Do not substitute Claude's own\s+review/is);
  const claudeSkill = await readFile(path.join(PROJECT_BASE, '.claude/skills/repo-mcp/SKILL.md'), 'utf8');
  assert.match(claudeSkill, /Claude's maintained Repo MCP paths are read-only/i);
  assert.match(claudeSkill, /Return coding\/write work to the Codex Repo MCP operator/i);
  assert.match(claudeSkill, /Claude's\s+host-native browser controls/is);
  assert.match(claudeSkill, /Never substitute\s+Claude's own analysis or invoke Oracle implicitly/is);
  assert.match(claudeSkill, /claude mcp add --scope user --transport http repo-mcp http:\/\/127\.0\.0\.1:8787\/mcp/);
  assert.match(claudeSkill, /WorkingDirectory.*control checkout/is);
  const codexSkill = await readFile(path.join(PROJECT_BASE, '.codex/skills/repo-mcp/SKILL.md'), 'utf8');
  assert.match(codexSkill, /claude mcp get repo-mcp/i);
  assert.match(codexSkill, /http:\/\/127\.0\.0\.1:8787\/mcp/);
  assert.match(codexSkill, /WorkingDirectory.*control checkout/is);
  assert.match(codexSkill, /each configured real client route/i);
  assert.match(codexSkill, /request to "use Repo MCP review".*ChatGPT web/is);
  assert.match(codexSkill, /Do not satisfy it with a Codex subagent/is);
  assert.match(codexSkill, /model profile `review`.*Sol Extra High/is);
  assert.match(codexSkill, /host-native browser control/is);
  assert.match(codexSkill, /durable `chatgpt-run`/i);
  assert.match(codexSkill, /do not invoke `model-policy run`, Oracle/is);
  assert.match(codexSkill, /never silently substitute a Codex subagent.*Oracle/is);
  assert.match(codexSkill, /Execution surface: ChatGPT web.*Coordinator:\s+Codex/is);
  assert.match(codexSkill, /Codex operator must resolve\/register the target\s+checkout/is);
  assert.match(codexSkill, /include the exact repository and task IDs in the submitted browser\s+prompt/is);
  const setup = await readFile(path.join(PROJECT_BASE, 'SETUP.md'), 'utf8');
  assert.match(setup, /Use Repo MCP to review this repository/);
  assert.match(setup, /Repo MCP supplies repository tools to ChatGPT web/i);
  assert.match(setup, /Codex subagent or Claude process.*outside the Repo MCP review\/architecture contract/is);
  assert.match(setup, /defaults to the token-saving route.*ChatGPT web/is);
  assert.match(setup, /chatgpt-run.*provider-neutral run journal/is);
  assert.doesNotMatch(setup, /ask Claude.*registered repository\/task IDs/i);
  const workflow = await readFile(path.join(PROJECT_BASE, 'docs/WORKFLOW-SPEC.md'), 'utf8');
  assert.match(workflow, /Codex and Claude coordinator skills use host-native browser control/i);
  assert.match(workflow, /ChatGPT web performs every Repo MCP review and\s+architecture pass/is);
  assert.match(workflow, /explicit `--backend oracle` compatibility path/i);
  assert.doesNotMatch(workflow, /browser mode is an optional future transport/i);
  assert.doesNotMatch(workflow, /automatic browser orchestration/);
  for (const [file, coordinator] of [
    ['.codex/skills/repo-mcp-architect/SKILL.md', 'Codex'],
    ['.claude/skills/repo-mcp-architect/SKILL.md', 'Claude Code']
  ]) {
    const architect = await readFile(path.join(PROJECT_BASE, file), 'utf8');
    assert.match(architect, /ChatGPT web performs the architecture work/i);
    assert.match(architect, /profile `architecture`.*Sol Pro/is);
    assert.match(architect, new RegExp(`Coordinator: ${coordinator}`));
    assert.match(architect, /Repository evidence: Repo MCP/);
    assert.match(architect, /Do not invoke\s+`model-policy run`\s+or Oracle/is);
  }
  assert.equal(await readFile(path.join(PROJECT_BASE, 'README.md'), 'utf8'), await readFile(path.join(PROJECT_BASE, 'docs/PUBLIC-README.md'), 'utf8'));
  const readOnly = compilePolicy(loadPolicy(JSON.parse(await readFile(path.join(PROJECT_BASE, 'docs/policy-readonly.json'), 'utf8')))).paths;
  const coding = compilePolicy(loadPolicy(JSON.parse(await readFile(path.join(PROJECT_BASE, 'docs/policy-coding.json'), 'utf8')))).paths;
  assert.equal(readOnly.decide('src/example.ts', 'write').ok, false);
  assert.equal(coding.decide('src/example.ts', 'write').ok, true);
  assert.equal(coding.decide('package.json', 'write').ok, false);
  assert.equal(coding.decide('src/.env', 'read').ok, false);
  assert.equal(coding.decide('dist/example.js', 'read').ok, false);
});
