import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const buggySource = `export function clamp(value, min, max) {
  if (min > max) throw new RangeError('min exceeds max');
  return Math.min(Math.max(value, min), max - 1);
}
`;

export const fixtureTests = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/clamp.js';

test('keeps values within the interval', () => assert.equal(clamp(5, 0, 10), 5));
test('clamps below the lower bound', () => assert.equal(clamp(-2, 0, 10), 0));
test('includes the upper endpoint', () => assert.equal(clamp(10, 0, 10), 10));
test('clamps above the upper bound', () => assert.equal(clamp(99, 0, 10), 10));
test('supports a single-value interval', () => assert.equal(clamp(3, 4, 4), 4));
test('rejects reversed bounds', () => assert.throws(() => clamp(3, 8, 4), RangeError));
`;

export async function prepareFixture(root: string) {
  // Refuse to overwrite an existing trial, including any ChatGPT edits.
  await mkdir(root);
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'src/clamp.js'), buggySource);
  await writeFile(path.join(root, 'test/clamp.test.js'), fixtureTests);
  await writeFile(path.join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  await writeFile(path.join(root, 'README.md'), 'Disposable MCP trial. Fix clamp to return a value inside the inclusive [min, max] interval. Preserve the tests.\n');
  await writeFile(path.join(root, 'AGENTS.md'), 'Only edit src/clamp.js. Run tests before and after editing, and inspect the final diff. Do not change tests or package.json.\n');
  const env = { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, stdio: 'pipe' });
  git('init', '-b', 'mcp-trial');
  git('add', '--', '.');
  git('-c', 'user.name=MCP Trial', '-c', 'user.email=trial@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Disposable failing fixture');
}
