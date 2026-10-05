import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileGlob, pathProblem } from '../src/glob.js';

// Milestone 2b: glob grammar, path syntax and descent reachability.

const matches = (pattern: string, file: string, fold = false) => compileGlob(pattern, { fold }).matches(file);

test('glob matching: *, ? and ** semantics', () => {
  const table: [string, string, boolean][] = [
    ['src/*.js', 'src/a.js', true], ['src/*.js', 'src/a/b.js', false], ['src/*.js', 'src/.js', true],
    ['src/**', 'src/a.js', true], ['src/**', 'src/a/b/c.js', true], ['src/**', 'src', false],
    ['**/*.js', 'a.js', true], ['**/*.js', 'a/b/c.js', true], ['**/*.js', 'a/b/c.ts', false],
    ['a/**/b.js', 'a/b.js', true], ['a/**/b.js', 'a/x/y/b.js', true], ['a/**/b.js', 'a/x/c.js', false],
    ['**', 'x', true], ['**', 'a/b/c', true],
    ['a?c', 'abc', true], ['a?c', 'a/c', false], ['a?c', 'ac', false], ['a?c', 'a😀c', true],
    ['*', 'x', true], ['*', 'a/b', false],
    ['src/a.js', 'src/a.js', true], ['src/a.js', 'src/a.jsx', false],
    ['src', 'src/a.js', false],      // includes are not prefix-closed: a bare name matches only that file
    ['**/**/x', 'x', true], ['**/**/x', 'a/b/x', true]
  ];
  for (const [pattern, file, expected] of table) assert.equal(matches(pattern, file), expected, `${pattern} vs ${file}`);
});

test('wildcards match dot-leading segments; eligibility is decided elsewhere', () => {
  assert.equal(matches('*', '.env'), true);
  assert.equal(matches('**', '.git/config'), true);
});

test('allow comparisons are case-sensitive and NFC-insensitive; deny folds case too', () => {
  assert.equal(matches('src/A.js', 'src/a.js'), false);
  assert.equal(matches('café/*', 'café/x'), true);
  assert.equal(matches('café/*', 'café/x'), true);
  assert.equal(matches('SRC/*.JS', 'src/a.js', true), true);
  assert.equal(matches('Café/*', 'café/X', true), true);
});

test('unsupported syntax is rejected, not guessed', () => {
  for (const bad of ['src/[ab].js', 'src/{a,b}.js', '!src/a.js', 'src/a\\b', 'a**b', '***', 'a/**b/c', '']) {
    assert.throws(() => compileGlob(bad), /unsupported pattern syntax|invalid pattern/i, bad);
  }
});

test('couldMatchBeneath answers whether some path below a directory can match', () => {
  const beneath = (pattern: string, dir: string) => compileGlob(pattern).couldMatchBeneath(dir);
  const table: [string, string, boolean][] = [
    ['.github/**', '.github', true], ['.github/**', '.github/workflows', true], ['.github/**', 'src', false],
    ['.github/workflows/ci.yml', '.github', true], ['.github/workflows/ci.yml', '.github/workflows', true], ['.github/workflows/ci.yml', '.github/other', false],
    ['src/a/b.js', 'src', true], ['src/a/b.js', 'src/a', true], ['src/a/b.js', 'test', false], ['src/a/b.js', 'src/a/b.js', false],
    ['**/*.js', 'anything/deep', true], ['**', 'x', true],
    ['src/*.js', 'src', true], ['src/*.js', 'src/sub', false],
    ['a/**/b.js', 'a/x/y', true], ['a/**/b.js', 'b', false],
    ['café/*', 'café', true]
  ];
  for (const [pattern, dir, expected] of table) assert.equal(beneath(pattern, dir), expected, `${pattern} beneath ${dir}`);
});

test('path syntax: traversal and unsafe names are rejected; any other Unicode is kept as stored', () => {
  for (const ok of ['src/a.js', 'café.js', 'café.js', '.github/x.yml', '日本語/ファイル.txt', 'a b/c d.txt', 'a'.repeat(255)]) assert.equal(pathProblem(ok), undefined, ok);
  const bad = ['', '/x', '../x', 'a/../b', 'a//b', 'a/./b', './a', 'a/', 'a\\b', 'a\0b', 'a\x07b', 'a\x7fb', 'a\u0085b', 'a�b', 'a\uD800b', 'a'.repeat(256), `${'a/'.repeat(130)}b.txt`];
  for (const p of bad) assert.ok(pathProblem(p), JSON.stringify(p));
});
