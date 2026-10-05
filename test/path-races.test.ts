import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rename, symlink, mkdir, readdir, readFile, rm, stat, link, lstat } from 'node:fs/promises';
import path from 'node:path';
import { RepoWorkspace, defaultPolicy, type RepoOptions } from '../src/repo.js';
import { makeRepo, openGlob, policyDoc } from './helpers.js';

// Milestone 2b: symlink swaps, hard links and containment verification. Races are made deterministic
// with `pathHook`, which runs at named stages between a check and the operation it guards.

type Hook = NonNullable<RepoOptions['pathHook']>;
const swapDirForSymlink = async (root: string, dir: string, target: string) => {
  await rename(path.join(root, dir), path.join(root, `${dir}.moved`));
  await symlink(target, path.join(root, dir));
};
const names = async (dir: string) => (await readdir(dir)).sort();

async function setup(t: Parameters<typeof makeRepo>[0], hookFor: (m: Awaited<ReturnType<typeof makeRepo>>, outside: string) => Hook, doc = policyDoc({ write: { include: ['src/**'], exclude: [] }, create: { paths: [], directories: ['src'], extensions: ['.js'] } })) {
  const m = await makeRepo(t);
  const outside = path.join(m.base, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'clamp.js'), 'OUTSIDE SECRET\n');
  const repo = await openGlob(t, m.root, doc, { pathHook: hookFor(m, outside) }, m.track);
  return { m, outside, repo };
}

test('read: a directory swapped for a symlink after the check is detected', async t => {
  let armed = false;
  const { repo, outside } = await setup(t, (m, out) => async stage => { if (armed && stage === 'read:after-check') { armed = false; await swapDirForSymlink(m.root, 'src', out); } });
  await repo.listFiles();
  armed = true;
  await assert.rejects(repo.read('src/clamp.js'), /outside|symlink|changed|not exposed/i);
  assert.equal(await readFile(path.join(outside, 'clamp.js'), 'utf8'), 'OUTSIDE SECRET\n');
});

test('read: swap and restore between check and open is caught by descriptor identity', async t => {
  let armed = false;
  const { m, repo, outside } = await setup(t, (mm, out) => async stage => {
    if (!armed) return;
    if (stage === 'read:after-check') await swapDirForSymlink(mm.root, 'src', out);
    if (stage === 'read:after-open') { armed = false; await rm(path.join(mm.root, 'src')); await rename(path.join(mm.root, 'src.moved'), path.join(mm.root, 'src')); }
  });
  await repo.listFiles();
  armed = true;
  const result = await repo.read('src/clamp.js').then(r => r.content, e => (e as Error).message);
  assert.ok(!String(result).includes('OUTSIDE SECRET'), String(result));
  assert.match(String(result), /outside|changed|symlink|identity/i);
  assert.ok((await names(m.root)).includes('src'));
  assert.deepEqual(await names(outside), ['clamp.js']);
});

test('edit: a parent swapped for a symlink before rename leaves the outside tree untouched', async t => {
  let armed = false;
  const { m, repo, outside } = await setup(t, (mm, out) => async stage => { if (armed && stage === 'edit:before-rename') { armed = false; await swapDirForSymlink(mm.root, 'src', out); } });
  const read = await repo.read('src/clamp.js');
  armed = true;
  await assert.rejects(repo.edit('src/clamp.js', 'max - 1', 'max', read.sha256), /changed|containment|outside|not applied/i);
  assert.equal(await readFile(path.join(outside, 'clamp.js'), 'utf8'), 'OUTSIDE SECRET\n');
  assert.deepEqual(await names(outside), ['clamp.js'], 'no temp file or replacement outside the repository');
  assert.match(await readFile(path.join(m.root, 'src.moved/clamp.js'), 'utf8'), /max - 1/);
});

test('create: a parent swapped before link publishes nothing outside', async t => {
  let armed = false;
  const { repo, outside } = await setup(t, (mm, out) => async stage => { if (armed && stage === 'create:before-link') { armed = false; await swapDirForSymlink(mm.root, 'src', out); } });
  armed = true;
  await assert.rejects(repo.createFile('src/new.js', 'export const x = 1;\n'), /changed|containment|outside|not applied/i);
  assert.deepEqual(await names(outside), ['clamp.js']);
});

test('create: a swap after link is reported as a containment violation, never as success', async t => {
  let armed = false;
  const { repo, outside } = await setup(t, (mm, out) => async stage => { if (armed && stage === 'create:after-link') { armed = false; await swapDirForSymlink(mm.root, 'src', out); } });
  armed = true;
  await assert.rejects(repo.createFile('src/new.js', 'export const x = 1;\n'), /containment_violation/);
  assert.deepEqual(await names(outside), ['clamp.js']);
});

test('mkdir: a creation scope swapped for a symlink creates nothing outside', async t => {
  let armed = false;
  const { repo, outside } = await setup(t, (mm, out) => async stage => { if (armed && stage === 'mkdir:before') { armed = false; await swapDirForSymlink(mm.root, 'src', out); } });
  armed = true;
  await assert.rejects(repo.createFile('src/deep/er/new.js', 'export const x = 1;\n'), /changed|containment|outside|symlink|not applied/i);
  assert.deepEqual(await names(outside), ['clamp.js']);
});

test('discovery: a directory swapped for a symlink while it is listed is never followed', async t => {
  const flag = { armed: false };
  const m = await makeRepo(t, { 'sub/a.txt': 'a' });
  const outside = path.join(m.base, 'outside');
  await mkdir(outside); await writeFile(path.join(outside, 'leak.txt'), 'x');
  const repo = await openGlob(t, m.root, policyDoc(), { pathHook: async (stage, ctx) => { if (flag.armed && stage === 'walk:after-list' && ctx.path === 'sub') { flag.armed = false; await rename(path.join(m.root, 'sub'), path.join(m.root, 'sub.moved')); await symlink(outside, path.join(m.root, 'sub')); } } }, m.track);
  flag.armed = true;
  const result = await repo.listFiles().then(r => r.files.map(f => f.path), e => (e as Error).message);
  assert.ok(!JSON.stringify(result).includes('leak.txt'));
  const after = await repo.listFiles();
  assert.ok(!after.files.some(f => f.path.includes('leak')));
  assert.equal(flag.armed, false);
});

test('hard links to outside files are never exposed; exact policies refuse them at startup', async t => {
  const m = await makeRepo(t);
  await writeFile(path.join(m.base, 'outside.txt'), 'outside');
  await link(path.join(m.base, 'outside.txt'), path.join(m.root, 'linked.txt'));
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);
  assert.ok(!(await repo.listFiles()).files.some(f => f.path === 'linked.txt'));
  await assert.rejects(repo.read('linked.txt'), /not exposed/);
  await assert.rejects(RepoWorkspace.create(m.root, { ...defaultPolicy, files: [...defaultPolicy.files, 'linked.txt'] }), /one hard link/);
});

test('a file replaced by a symlink after discovery is refused', async t => {
  const m = await makeRepo(t);
  const repo = await openGlob(t, m.root, policyDoc({ write: { include: ['src/**'], exclude: [] } }), {}, m.track);
  await repo.listFiles();
  await writeFile(path.join(m.base, 'secret.txt'), 'outside');
  await rm(path.join(m.root, 'src/clamp.js'));
  await symlink(path.join(m.base, 'secret.txt'), path.join(m.root, 'src/clamp.js'));
  await assert.rejects(repo.read('src/clamp.js'), /not exposed|symlink/i);
  await assert.rejects(repo.edit('src/clamp.js', 'a', 'b', '0'.repeat(64)), /not exposed|symlink|not editable/i);
  assert.equal(await readFile(path.join(m.base, 'secret.txt'), 'utf8'), 'outside');
  assert.ok((await lstat(path.join(m.root, 'src/clamp.js'))).isSymbolicLink());
  assert.ok(await stat(m.root));
});
