import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { RepoWorkspace, defaultPolicy } from '../src/repo.js';
import { compilePolicyFor, loadPolicy } from '../src/policy.js';
import { makeRepo, openGlob, policyDoc } from './helpers.js';

// A literal v2 policy may name approved dot paths. The v1 rule that bans every dot-leading segment belongs to direct v1
// policies only; compiled v2 policies are judged by path syntax and the PathPolicy decisions (built-in denials, dotfiles gate).

const BASE = ['AGENTS.md', 'src/clamp.js', 'test/clamp.test.js'];
const dotDoc = (over: Record<string, unknown> = {}, extra: string[] = ['.github/a.yml']) => policyDoc({
  read: { include: [...BASE, ...extra], exclude: [] }, write: { include: [], exclude: [] }, create: { paths: [], directories: [], extensions: [] },
  dotfiles: ['.github/**'], ...over
});
const startupError = async (fn: () => Promise<unknown>) => fn().then(() => '', e => (e as Error).message);

test('an exact v2 policy reads, lists and searches a literal approved dotfile on the exact fast path', async t => {
  const m = await makeRepo(t, { '.github/a.yml': 'ok\n', '.github/b.yml': 'hidden\n' });
  const repo = await openGlob(t, m.root, dotDoc(), {}, m.track);
  assert.equal(repo.exactPolicy, true, 'the exact fast path is kept');
  assert.equal((await repo.read('.github/a.yml')).content, 'ok\n');
  assert.ok((await repo.listFiles('.github')).files.some(f => f.path === '.github/a.yml'));
  assert.deepEqual((await repo.search('ok')).matches.filter(x => x.path.startsWith('.github')).map(x => x.path), ['.github/a.yml']);
  assert.ok((await repo.info()).files.includes('.github/a.yml'));
  await assert.rejects(repo.read('.github/b.yml'), /not exposed/, 'an approved directory does not expose unlisted files');
});

test('an editable tracked dotfile can be edited and shows in the diff; a literal creatable dot path can be created', async t => {
  const m = await makeRepo(t, { '.github/a.yml': 'ok\n' });
  const doc = dotDoc({
    write: { include: ['.github/a.yml', '.github/new.yml'], exclude: [] },
    create: { paths: ['.github/new.yml'], directories: [], extensions: [] }
  }, ['.github/a.yml', '.github/new.yml']);
  const repo = await openGlob(t, m.root, doc, {}, m.track);
  assert.equal(repo.exactPolicy, true);
  const read = await repo.read('.github/a.yml');
  await repo.edit('.github/a.yml', 'ok', 'fine', read.sha256);
  assert.equal(await readFile(path.join(m.root, '.github/a.yml'), 'utf8'), 'fine\n');
  const created = await repo.createFile('.github/new.yml', 'name: new\n');
  assert.ok(created.after_sha256);
  let text = '', page = await repo.diff();
  for (;;) { text += page.diff; if (!page.next_cursor) break; page = await repo.diff('', page.next_cursor); }
  assert.match(text, /\+fine/);
  assert.match(text, /\+name: new/);
  assert.ok((await repo.info()).editable_files.includes('.github/a.yml'));
});

test('built-in denials and a missing dotfiles gate still stop a literal dot path at startup', async t => {
  const m = await makeRepo(t, { '.github/a.yml': 'ok\n' });
  for (const file of ['.git/config', '.env', '.trial/x.log', '.ssh/id_rsa', '.github/server.pem']) {
    assert.match(await startupError(() => openGlob(t, m.root, dotDoc({ dotfiles: ['**'] }, [file]))), /built-in|server-owned|denied|\.git internals/i, file);
  }
  assert.match(await startupError(() => openGlob(t, m.root, dotDoc({ dotfiles: [] }))), /dot-leading segment/i, 'no dotfiles entry: still denied');
  assert.match(await startupError(() => openGlob(t, m.root, dotDoc({ dotfiles: ['.config/**'] }))), /dot-leading segment/i, 'a dotfiles entry for another directory does not cover it');
});

test('direct v1 policies and migrated v1 keep rejecting dot-leading paths', async t => {
  const m = await makeRepo(t, { '.github/a.yml': 'ok\n' });
  const v1 = { files: [...BASE, '.github/a.yml'], editable: ['src/clamp.js'], tests: ['test/clamp.test.js'] };
  await assert.rejects(RepoWorkspace.create(m.root, v1), /Invalid policy path/);
  await assert.rejects(RepoWorkspace.create(m.root, { ...defaultPolicy, files: [...defaultPolicy.files, '.hidden'] }), /Invalid policy path/);
  assert.match(await startupError(async () => RepoWorkspace.create(m.root, await compilePolicyFor(loadPolicy(v1), { root: m.root }))), /dot-leading segment|dotfiles/i, 'migrated v1 has no dotfiles entries');
});

test('syntax problems in a compiled exact policy are still refused', async t => {
  const m = await makeRepo(t);
  assert.match(await startupError(() => openGlob(t, m.root, dotDoc({ dotfiles: ['**'] }, ['.github//a.yml']))), /./);
  assert.match(await startupError(() => openGlob(t, m.root, dotDoc({ dotfiles: ['**'] }, ['.github/a\u0001.yml']))), /./);
});
