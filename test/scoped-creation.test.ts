import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { makeRepo, openGlob, policyDoc, git } from './helpers.js';
import { loadPolicy, policyDigest } from '../src/policy.js';

// Milestone 2b: scoped creation under directories, with nested directories and no overwrite.

const scoped = (over: Record<string, unknown> = {}) => policyDoc({
  write: { include: ['src/**', 'docs/**', 'README.new'], exclude: [] },
  create: { paths: ['README.new'], directories: ['src/features', 'docs'], extensions: ['.js', '.md'] }, ...over
});

test('nested creation under a scope creates missing directories, never overwrites, and the file is usable', async t => {
  const m = await makeRepo(t, { 'src/features/.keep.txt': 'x\n', 'docs/index.md': '# docs\n' });
  const repo = await openGlob(t, m.root, scoped({ dotfiles: [] }), {}, m.track);
  const result = await repo.createFile('src/features/deep/er/thing.js', 'export const thing = 1;\n') as Record<string, unknown>;
  assert.deepEqual(result.created_directories, ['src/features/deep', 'src/features/deep/er']);
  assert.equal(await readFile(path.join(m.root, 'src/features/deep/er/thing.js'), 'utf8'), 'export const thing = 1;\n');
  assert.equal((await stat(path.join(m.root, 'src/features/deep'))).mode & 0o777, 0o755);
  // Readable, listed, editable and shown in the diff without staging.
  const read = await repo.readRange('src/features/deep/er/thing.js');
  assert.equal(read.content, 'export const thing = 1;\n');
  assert.ok((await repo.listFiles('src/features/deep')).files.some(f => f.path.endsWith('thing.js') && f.editable));
  await repo.edit('src/features/deep/er/thing.js', 'thing = 1', 'thing = 2', read.sha256);
  const diff = (await repo.diff()).diff;
  assert.match(diff, /\+\+\+ src\/features\/deep\/er\/thing\.js/);
  assert.match(diff, /\+export const thing = 2;/);
  // Never overwrites.
  await assert.rejects(repo.createFile('src/features/deep/er/thing.js', 'x\n'), /already exists|never overwrites/i);
  await assert.rejects(repo.createFile('docs/index.md', 'overwrite\n'), /already exists|never overwrites/i);
  assert.equal(await readFile(path.join(m.root, 'docs/index.md'), 'utf8'), '# docs\n');
  // An exact create.paths entry still works and needs no extension.
  await repo.createFile('README.new', 'new readme\n');
});

test('creation is refused outside the scope, for wrong extensions, too deep, and for missing scope roots', async t => {
  const m = await makeRepo(t, { 'src/features/.keep.txt': 'x\n', 'docs/index.md': '# docs\n' });
  const repo = await openGlob(t, m.root, scoped(), {}, m.track);
  await assert.rejects(repo.createFile('src/features/a.py', 'x\n'), /extension/);
  await assert.rejects(repo.createFile(`src/features/${'d/'.repeat(8)}x.js`, 'x\n'), /depth/);
  await assert.rejects(repo.createFile('src/other/a.js', 'x\n'), /not approved for creation/);
  await assert.rejects(repo.createFile('src/features/.env', 'x\n'), /not approved for creation/);
  await assert.rejects(repo.createFile('src/features/.git/hook.js', 'x\n'), /not approved for creation/);
  await assert.rejects(repo.createFile('../escape.js', 'x\n'), /not approved for creation|not exposed|invalid/i);
  assert.deepEqual((await readdir(path.join(m.root, 'src'))).sort(), ['clamp.js', 'features']);
  // The scope root itself is never created.
  await rm(path.join(m.root, 'docs'), { recursive: true });
  await assert.rejects(repo.createFile('docs/new.md', 'x\n'), /scope|exist/i);
  await assert.rejects(stat(path.join(m.root, 'docs')), /ENOENT/);
});

test('creation refuses names that collide after case or Unicode normalisation', async t => {
  const m = await makeRepo(t, { 'docs/Guide.md': '# g\n', 'docs/café.md': '# decomposed\n', 'docs/Section/a.md': 'x\n' });
  const repo = await openGlob(t, m.root, scoped(), {}, m.track);
  await assert.rejects(repo.createFile('docs/guide.md', 'x\n'), /conflicting name/i);
  await assert.rejects(repo.createFile('docs/GUIDE.MD', 'x\n'), /conflicting name|extension/i);
  await assert.rejects(repo.createFile('docs/café.md', 'x\n'), /conflicting name/i, 'NFC spelling of a decomposed existing name');
  await assert.rejects(repo.createFile('docs/section/b.md', 'x\n'), /conflicting name/i, 'a directory that differs only by case');
  await repo.createFile('docs/Section/b.md', 'x\n');
  // Disk spelling is preserved in listings and reachable by its NFC form.
  const listed = (await repo.listFiles('docs/')).files.map(f => f.path);
  assert.ok(listed.includes('docs/café.md'));
  assert.equal((await repo.readRange('docs/café.md')).content, '# decomposed\n');
  assert.equal((await repo.readRange('docs/café.md')).path, 'docs/café.md');
});

test('a failed publish removes the directories this call created, best effort', async t => {
  const m = await makeRepo(t, { 'src/features/.keep.txt': 'x\n' });
  const repo = await openGlob(t, m.root, scoped(), { pathHook: async (stage) => { if (stage === 'create:before-link') await writeFile(path.join(m.root, 'src/features/n1/n2/taken.js'), 'taken\n'); } }, m.track);
  await assert.rejects(repo.createFile('src/features/n1/n2/taken.js', 'mine\n'), /already exists|never overwrites/i);
  assert.equal(await readFile(path.join(m.root, 'src/features/n1/n2/taken.js'), 'utf8'), 'taken\n');
  // Dirs now hold someone else's file, so rmdir refuses and they stay. A failure that leaves them empty cleans them up.
  assert.ok((await stat(path.join(m.root, 'src/features/n1/n2'))).isDirectory());
  const failing = await openGlob(t, m.root, scoped(), { pathHook: async stage => { if (stage === 'create:before-link') throw new Error('boom'); } }, m.track);
  await assert.rejects(failing.createFile('src/features/x1/x2/never.js', 'mine\n'));
  await assert.rejects(stat(path.join(m.root, 'src/features/x1')), /ENOENT/, 'empty directories created by the failed call are removed');
});

test('created files appear as approved new files in the diff', async t => {
  const m = await makeRepo(t, { 'src/features/.keep.txt': 'x\n' });
  const repo = await openGlob(t, m.root, scoped(), {}, m.track);
  await repo.createFile('src/features/a/b.js', 'export const b = 1;\n');
  assert.ok((await git(m.root, 'status', '--short', '--untracked-files=all')).includes('src/features/a/b.js'));
  assert.match((await repo.diff()).diff, /Index: src\/features\/a\/b\.js[\s\S]*\+export const b = 1;/);
});

test('nested creation is idempotent by request_id in task mode', async t => {
  const m = await makeRepo(t, { 'src/features/.keep.txt': 'x\n' });
  const doc = scoped();
  const task = { stateDir: path.join(m.base, 'state'), taskId: 'scoped', policyDigest: policyDigest(loadPolicy(doc)) };
  const repo = await openGlob(t, m.root, doc, { task }, m.track);
  const first = await repo.createFile('src/features/a/b/c.js', 'export const c = 1;\n', 'req-1') as Record<string, unknown>;
  assert.deepEqual(first.created_directories, ['src/features/a', 'src/features/a/b']);
  const retry = await repo.createFile('src/features/a/b/c.js', 'export const c = 1;\n', 'req-1') as Record<string, unknown>;
  assert.equal(retry.already_applied, true);
  assert.equal(await readFile(path.join(m.root, 'src/features/a/b/c.js'), 'utf8'), 'export const c = 1;\n');
  await assert.rejects(repo.createFile('src/features/a/b/c.js', 'different\n', 'req-1'), /different arguments/i);
});
