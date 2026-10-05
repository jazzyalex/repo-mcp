import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { RepoWorkspace, defaultPolicy } from '../src/repo.js';
import { batchPaths } from '../src/git-batches.js';
import { makeRepo, openGlob, policyDoc, git } from './helpers.js';

// Milestone 2b: Git diff scope. Real Git throughout; Git 2.50's `diff` and `ls-files` take no --pathspec-from-file.

async function fullDiff(repo: RepoWorkspace, prefix = '') {
  let page = await repo.diff(prefix);
  let text = page.diff;
  while (page.next_cursor) { page = await repo.diff(prefix, page.next_cursor); text += page.diff; }
  return text;
}

test('path batches are bounded by count and bytes and keep order', () => {
  const paths = Array.from({ length: 1000 }, (_, i) => `dir/${String(i).padStart(5, '0')}-${'x'.repeat(i % 50)}.txt`);
  const batches = batchPaths(paths);
  assert.deepEqual(batches.flat(), paths);
  for (const b of batches) { assert.ok(b.length <= 200); assert.ok(b.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0) <= 48 * 1024); }
  assert.ok(batches.length >= 5);
  const long = Array.from({ length: 300 }, (_, i) => `${'d'.repeat(250)}${i}`);
  for (const b of batchPaths(long)) assert.ok(b.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0) <= 48 * 1024);
  assert.deepEqual(batchPaths([]), []);
});

test('git itself still rejects --pathspec-from-file for diff and ls-files (why batching is used)', async t => {
  const m = await makeRepo(t);
  for (const args of [['diff', '--pathspec-from-file=-', 'HEAD'], ['ls-files', '--pathspec-from-file=-']]) {
    await assert.rejects(git(m.root, ...args), /./, args.join(' '));
  }
});

test('thousands of changed and unchanged permitted paths produce the same patch as one Git command', async t => {
  const files = Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`many/file-${String(i).padStart(4, '0')}.txt`, `original ${i}\n`]));
  const m = await makeRepo(t, files);
  const repo = await openGlob(t, m.root, policyDoc({ write: { include: ['many/**'], exclude: [] } }), {}, m.track);
  for (let i = 0; i < 900; i += 2) await writeFile(path.join(m.root, `many/file-${String(i).padStart(4, '0')}.txt`), `changed ${i}\n`);   // 450 changed: several batches
  const expected = await git(m.root, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', 'HEAD');
  assert.ok(expected.length > 40_000);
  assert.equal(await fullDiff(repo), expected);
  const prefixed = await fullDiff(repo, 'many/file-01');
  assert.equal(prefixed, await git(m.root, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', 'HEAD', '--', 'many/file-01*'));
});

test('a large permitted tree with few changes only runs Git over the changed paths', async t => {
  const files = Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`tree/d${i % 40}/f${i}.txt`, `v${i}\n`]));
  const m = await makeRepo(t, files);
  const runs: number[] = [];
  const repo = await openGlob(t, m.root, policyDoc(), { captureHook: (stage, _attempt, run) => { if (stage === 'before-git') runs.push(run ?? 0); } }, m.track);
  await writeFile(path.join(m.root, 'tree/d1/f1.txt'), 'changed\n');
  const text = await fullDiff(repo);
  assert.equal(text, await git(m.root, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', 'HEAD'));
  assert.ok(runs.length <= 4, `Git ran ${runs.length} times`);
});

test('the shared deadline stops a long batch loop', async t => {
  const files = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`b/f${String(i).padStart(3, '0')}.txt`, `${i}\n`]));
  const m = await makeRepo(t, files);
  let now = 0;
  const gitRuns: number[] = [];
  const repo = await openGlob(t, m.root, policyDoc(), { operationBudgetMs: 1000, monotonicClock: () => now, captureHook: (stage, _a, run) => { if (stage === 'before-git') { gitRuns.push(run ?? 0); now += 300; } } }, m.track);
  for (let i = 0; i < 600; i++) await writeFile(path.join(m.root, `b/f${String(i).padStart(3, '0')}.txt`), `new ${i}\n`);
  await assert.rejects(repo.diff(), /timed out.*operation budget/i);
  assert.ok(gitRuns.length <= 4, `Git runs after the budget: ${gitRuns.length}`);
  assert.deepEqual(await readdirSafe(repo.captures.dir), []);
});
const readdirSafe = async (dir: string) => (await (await import('node:fs/promises')).readdir(dir)).filter(f => !f.startsWith('.'));

test('a deleted tracked file stays visible in the diff', async t => {
  const m = await makeRepo(t, { 'src/gone.js': 'export const gone = 1;\n', 'src/stay.js': 'export const stay = 1;\n' });
  const repo = await openGlob(t, m.root, policyDoc({ write: { include: ['src/**'], exclude: [] } }), {}, m.track);
  await rm(path.join(m.root, 'src/gone.js'));
  const text = await fullDiff(repo);
  assert.match(text, /diff --git a\/src\/gone\.js b\/src\/gone\.js\ndeleted file mode/);
  assert.match(text, /-export const gone = 1;/);
  assert.ok(!(await repo.listFiles()).files.some(f => f.path === 'src/gone.js'), 'it is gone from the inventory but not from the diff');
  assert.equal(text, await git(m.root, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', 'HEAD'));
});

test('exact-mode policies also keep deletions visible', async t => {
  const m = await makeRepo(t, { 'src/extra.js': 'x\n' });
  const policy = { files: [...defaultPolicy.files, 'src/extra.js'], editable: ['src/clamp.js'], tests: ['test/clamp.test.js'] };
  const repo = m.track(await RepoWorkspace.create(m.root, policy));
  await rm(path.join(m.root, 'src/extra.js'));
  const text = await fullDiff(repo);
  assert.match(text, /diff --git a\/src\/extra\.js b\/src\/extra\.js\ndeleted file mode/);
  await assert.rejects(RepoWorkspace.create(m.root, policy), /ENOENT|no such file/i, 'a listed file that is missing still fails startup, as before');
});

test('renames show as a deletion and an addition, each judged by policy on its own path', async t => {
  const m = await makeRepo(t, { 'src/old.js': 'export const value = 1;\nexport const more = 2;\nexport const third = 3;\n' });
  const repo = await openGlob(t, m.root, policyDoc({ read: { include: ['**'], exclude: ['secret/**'] } }), {}, m.track);
  await git(m.root, 'mv', 'src/old.js', 'src/new.js');
  let text = await fullDiff(repo);
  assert.match(text, /deleted file mode[\s\S]*--- a\/src\/old\.js\n\+\+\+ \/dev\/null/);
  assert.match(text, /new file mode[\s\S]*--- \/dev\/null\n\+\+\+ b\/src\/new\.js/);
  assert.ok(!/rename (from|to)|similarity index/.test(text), 'no rename pairing across batches');
  // A rename into a denied path shows only the permitted side.
  await mkdir(path.join(m.root, 'secret'));
  await git(m.root, 'mv', 'src/new.js', 'secret/moved.js');
  text = await fullDiff(repo);
  assert.match(text, /a\/src\/old\.js/);
  assert.ok(!text.includes('secret/moved.js'), 'content and name of the denied side never appear');
});

test('staged additions, staged deletions and staged-only differences are never dropped', async t => {
  const m = await makeRepo(t, { 'src/keep.js': 'export const keep = 1;\n', 'src/del.js': 'export const del = 1;\n', 'src/flip.js': 'export const flip = 1;\n' });
  const repo = await openGlob(t, m.root, policyDoc({ write: { include: ['src/**'], exclude: [] }, create: { paths: [], directories: ['src'], extensions: ['.js'] } }), {}, m.track);
  await writeFile(path.join(m.root, 'src/added.js'), 'export const added = 1;\n');
  await git(m.root, 'add', 'src/added.js');                    // staged addition
  await git(m.root, 'rm', '-q', 'src/del.js');                 // staged deletion
  await writeFile(path.join(m.root, 'src/flip.js'), 'export const flip = 2;\n');
  await git(m.root, 'add', 'src/flip.js');
  await writeFile(path.join(m.root, 'src/flip.js'), 'export const flip = 1;\n');   // worktree back to HEAD: index still differs
  const text = await fullDiff(repo);
  assert.match(text, /\+\+\+ b\/src\/added\.js/);
  assert.match(text, /--- a\/src\/del\.js\n\+\+\+ \/dev\/null/);
  assert.match(text, /# no working-tree patch for src\/flip\.js \(index differs from HEAD\)/);
});

test('deleting an unchanged tracked file after capture makes the cursor stale', async t => {
  const files = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`m/f${String(i).padStart(3, '0')}.txt`, `${'line\n'.repeat(60)}${i}\n`]));
  const m = await makeRepo(t, files);
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);
  for (let i = 0; i < 300; i += 3) await writeFile(path.join(m.root, `m/f${String(i).padStart(3, '0')}.txt`), `changed ${i}\n`.repeat(30));
  const first = await repo.diff();
  assert.ok(first.next_cursor);
  await rm(path.join(m.root, 'm/f001.txt'));
  await assert.rejects(repo.diff('', first.next_cursor!), /stale cursor/i);
  // And a file appearing in a scanned directory.
  const again = await repo.diff();
  await writeFile(path.join(m.root, 'm/brand-new.txt'), 'x');
  await assert.rejects(repo.diff('', again.next_cursor!), /stale cursor/i);
  assert.equal(await readFile(path.join(m.root, 'm/f000.txt'), 'utf8').then(x => x.length > 0), true);
});
