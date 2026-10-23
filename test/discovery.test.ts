import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink, link, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { RepoWorkspace } from '../src/repo.js';
import { makeRepo, openGlob, policyDoc, git } from './helpers.js';

// Milestone 2b: discovery, inventories, freshness, limits and restart-safe cursors.

const byteSort = (list: string[]) => [...list].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
type Page = Awaited<ReturnType<RepoWorkspace['listFiles']>>;
async function listAll(repo: RepoWorkspace, prefix = '') {
  const paths: string[] = [];
  let page: Page = await repo.listFiles(prefix);
  for (;;) {
    paths.push(...page.files.map(f => f.path));
    if (!page.next_cursor) return { paths, last: page };
    page = await repo.listFiles(prefix, page.next_cursor);
  }
}
const cursorParts = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
const forge = (cursor: string, change: Record<string, unknown>) => Buffer.from(JSON.stringify({ ...cursorParts(cursor), ...change })).toString('base64url');
const manyFiles = (n: number, dir = 'bulk') => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${dir}/file-with-a-fairly-long-descriptive-name-${String(i).padStart(5, '0')}.txt`, `line ${i} needle\n`]));

test('glob discovery lists permitted files in byte order and hides denied ones', async t => {
  const m = await makeRepo(t, { 'src/a.js': 'a\n', 'src/sub/b.js': 'b\n', '.github/workflows/ci.yml': 'name: ci\n', 'docs/read me.md': 'x\n', 'src.old': 'x\n' }, { '.env': 'SECRET=1', 'keys/server.pem': 'PEM', '.env.example': 'A=', '.hidden': 'x' });
  const repo = await openGlob(t, m.root, policyDoc({ dotfiles: ['.github/**', '.env.example'], write: { include: ['src/**'], exclude: [] } }), {}, m.track);
  const { paths, last } = await listAll(repo);
  assert.deepEqual(paths, byteSort(['.github/workflows/ci.yml', 'AGENTS.md', 'README.md', 'docs/read me.md', 'package.json', 'src.old', 'src/a.js', 'src/clamp.js', 'src/sub/b.js', 'test/clamp.test.js']));
  assert.ok(!paths.includes('.env.example'), 'conventional examples stay denied without secret_exceptions');
  const page = await repo.listFiles('src/');
  assert.deepEqual(page.files.map(f => [f.path, f.editable]), [['src/a.js', true], ['src/clamp.js', true], ['src/sub/b.js', true]]);
  assert.equal(page.files[0].bytes, 2);
  assert.equal(last.complete, true);
  assert.equal(last.inventory.paths, paths.length);
  // Denied, unlisted and missing paths are indistinguishable.
  const messages = await Promise.all(['.env', 'keys/server.pem', '.git/config', 'does/not/exist.txt', '.hidden'].map(f => repo.read(f).then(() => 'read', e => (e as Error).message)));
  assert.equal(new Set(messages).size, 1, messages.join(' | '));
  assert.match(messages[0], /not exposed/);
});

test('descent follows mayDescend: allowed dotfile directories are entered, excluded trees are never walked', async t => {
  const m = await makeRepo(t, { '.github/workflows/ci.yml': 'a', '.github/ISSUE_TEMPLATE/bug.md': 'b', 'vendor/lib/a.js': 'v', 'src/a/b.js': 'x', 'src/a/c.js': 'x', 'test/t.js': 't' }, { '.secret/x.txt': 'x', '.ssh/id': 'x' });
  const nested = await openGlob(t, m.root, policyDoc({ read: { include: ['.github/workflows/ci.yml', 'src/a/b.js', 'nothing/*.zzz'], exclude: [] }, dotfiles: ['.github/workflows/*.yml'], checks: [] }), {}, m.track);
  assert.deepEqual((await listAll(nested)).paths, ['.github/workflows/ci.yml', 'src/a/b.js']);
  const visited: string[] = [];
  const spy = await openGlob(t, m.root, policyDoc({ read: { include: ['**'], exclude: ['vendor/**'] }, dotfiles: ['.github/**'] }), { pathHook: (stage, ctx) => { if (stage === 'walk:enter') visited.push(ctx.path); } }, m.track);
  await listAll(spy);
  assert.ok(visited.includes('.github') && visited.includes('.github/workflows') && visited.includes('src/a'), visited.join());
  for (const never of ['vendor', 'vendor/lib', '.git', '.secret', '.ssh']) assert.ok(!visited.includes(never), `${never} must not be entered`);
});

test('discovery limits are explicit and never yield a partial inventory', async t => {
  const m = await makeRepo(t, { ...manyFiles(30, 'node_modules/pkg'), 'src/a.js': 'a' });
  // Pruned trees do not count against the cap.
  const pruned = await openGlob(t, m.root, policyDoc({ read: { include: ['**'], exclude: ['node_modules/**'] } }), { limits: { inventory_paths: 20 } }, m.track);
  assert.equal((await listAll(pruned)).paths.length, 6);
  // Without the exclude the cap is exceeded: an error, not a truncated list.
  const open = await openGlob(t, m.root, policyDoc(), { limits: { inventory_paths: 20 } }, m.track);
  await assert.rejects(open.listFiles(), /discovery limit.*20/i);
  await assert.rejects(open.search('needle'), /discovery limit/i);
  await assert.rejects(open.info(), /discovery limit/i);
  // Entries that are visited but never listed also count, against a larger separate cap.
  const m2 = await makeRepo(t, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`logs/${i}.log`, 'x'])));
  const noisy = await openGlob(t, m2.root, policyDoc({ read: { include: ['**'], exclude: ['logs/*.log'] }, checks: [] }), { limits: { inventory_paths: 5 } }, m2.track);
  await assert.rejects(noisy.listFiles(), /discovery limit.*visited/i);
});

test('the discovery deadline is shared and explicit', async t => {
  const m = await makeRepo(t);
  const repo = await openGlob(t, m.root, policyDoc(), { operationBudgetMs: 0 }, m.track);
  await assert.rejects(repo.listFiles(), /timed out.*operation budget/i);
});

test('links, special files, oversize files and unsafe names are skipped and counted', async t => {
  const m = await makeRepo(t, { 'big.txt': 'x'.repeat(3000) }, { 'weird\u0001name.txt': 'x' });
  await writeFile(path.join(m.base, 'outside.txt'), 'outside');
  await symlink(path.join(m.base, 'outside.txt'), path.join(m.root, 'sym.txt'));
  await mkdir(path.join(m.base, 'outdir')); await writeFile(path.join(m.base, 'outdir/secret.txt'), 'x');
  await symlink(path.join(m.base, 'outdir'), path.join(m.root, 'symdir'));
  await link(path.join(m.base, 'outside.txt'), path.join(m.root, 'linked.txt'));
  const deep = Array.from({ length: 5 }, () => 'd'.repeat(60)).join('/');
  await mkdir(path.join(m.root, deep), { recursive: true });
  await writeFile(path.join(m.root, deep, 'f.txt'), 'x');
  const repo = await openGlob(t, m.root, policyDoc(), { limits: { edit_file_bytes: 1024 } }, m.track);
  const { paths, last } = await listAll(repo);
  for (const hidden of ['sym.txt', 'symdir/secret.txt', 'linked.txt', 'big.txt', 'weird\u0001name.txt', `${deep}/f.txt`]) assert.ok(!paths.includes(hidden), hidden);
  assert.deepEqual(last.inventory.skipped, { symlinks: 2, special: 0, linked: 1, too_large: 1, unsafe_name: 1, too_long: 1, other_device: 0, git_ignored: 0, nested_repo: 0 });
  await assert.rejects(repo.read('linked.txt'), /not exposed/);
  await assert.rejects(repo.read('big.txt'), /not exposed/);
});

test('new, deleted and renamed files change the inventory; their cursors go stale', async t => {
  const m = await makeRepo(t, manyFiles(400));
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);
  const first = await repo.listFiles();
  assert.equal(first.complete, false);
  const digest = first.inventory.digest;
  await writeFile(path.join(m.root, 'bulk/zz-new.txt'), 'new');
  await assert.rejects(repo.listFiles('', first.next_cursor!), /stale cursor/i);
  const second = await repo.listFiles();
  assert.notEqual(second.inventory.digest, digest);
  await rm(path.join(m.root, 'bulk/zz-new.txt'));
  await assert.rejects(repo.listFiles('', first.next_cursor!), /stale cursor/i, 'a deletion is a change too');
  assert.notEqual((await repo.listFiles()).inventory.digest, digest, 'directory metadata moved, so the inventory is a new generation');
  await git(m.root, 'mv', 'bulk/file-with-a-fairly-long-descriptive-name-00000.txt', 'bulk/renamed.txt');
  await assert.rejects(repo.listFiles('', first.next_cursor!), /stale cursor/i);
  assert.ok((await listAll(repo)).paths.includes('bulk/renamed.txt'));
});

test('an in-place edit with no directory change is visible to the next call and stales open cursors', async t => {
  const files = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`src/m${i}.js`, Array.from({ length: 40 }, (_, j) => `// needle ${i}-${j}`).join('\n') + '\n']));
  const m = await makeRepo(t, files);
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);
  const before = (await repo.listFiles('src/m1')).files[0];
  // writeFile truncates and rewrites the same inode: the directory's own metadata does not move.
  await writeFile(path.join(m.root, 'src/m1.js'), '// replaced content that is longer than before\n// needle changed\n');
  const after = (await repo.listFiles('src/m1')).files[0];
  assert.notEqual(after.bytes, before.bytes, 'entry metadata refreshed for a new call');
  const found = await repo.search('needle changed');
  assert.deepEqual(found.matches.map(x => [x.path, x.line]), [['src/m1.js', 2]]);
  assert.equal((await repo.search('needle 1-5')).matches.length, 0, 'old content is gone');
  // Mid-pagination: the next page is rejected after a further in-place edit.
  const page = await repo.search('needle');
  assert.ok(page.next_cursor);
  await writeFile(path.join(m.root, 'src/m3.js'), '// edited while paging\n');
  await assert.rejects(repo.search('needle', '', page.next_cursor!), /stale cursor/i);
});

test('list and search cursors survive a restart while valid, and are bound and validated', async t => {
  const m = await makeRepo(t, manyFiles(400));
  let now = 1_700_000_000_000;
  const doc = policyDoc();
  const open = (clock = () => now) => openGlob(t, m.root, doc, { clock }, m.track);
  const repo = await open();
  const first = await repo.listFiles();
  const search = await repo.search('needle');
  assert.ok(first.next_cursor && search.next_cursor);
  const restarted = await open();
  const second = await restarted.listFiles('', first.next_cursor!);
  assert.ok(second.files.length > 0 && second.files[0].path > first.files.at(-1)!.path, 'continues where the first page ended');
  assert.ok((await restarted.search('needle', '', search.next_cursor!)).matches.length > 0);
  // Binding: arguments, policy, repository.
  await assert.rejects(restarted.listFiles('bulk/x', first.next_cursor!), /invalid cursor/i);
  await assert.rejects(restarted.search('other', '', search.next_cursor!), /invalid cursor/i);
  await assert.rejects(restarted.search('needle', 'bulk/', search.next_cursor!), /invalid cursor/i);
  const other = await openGlob(t, m.root, policyDoc({ read: { include: ['**'], exclude: ['zzz/**'] } }), {}, m.track);
  await assert.rejects(other.listFiles('', first.next_cursor!), /invalid cursor/i);
  await assert.rejects(restarted.listFiles('', forge(first.next_cursor!, { r: 'f'.repeat(64) })), /invalid cursor/i);
  // Malformed and out-of-range positions.
  for (const bad of ['garbage', Buffer.from('[]').toString('base64url'), forge(first.next_cursor!, { o: -1 }), forge(first.next_cursor!, { o: 1.5 }), forge(first.next_cursor!, { o: 'x' }),
    forge(first.next_cursor!, { o: 10 ** 9 }), forge(first.next_cursor!, { o: Number.MAX_SAFE_INTEGER + 2 }), forge(first.next_cursor!, { t: 'now' }), forge(first.next_cursor!, { k: 'search' })]) {
    await assert.rejects(restarted.listFiles('', bad), /invalid cursor|expired|stale/i, bad.slice(0, 40));
  }
  await assert.rejects(restarted.search('needle', '', forge(search.next_cursor!, { fi: 10 ** 6 })), /invalid cursor/i);
  await assert.rejects(restarted.search('needle', '', forge(search.next_cursor!, { li: -3 })), /invalid cursor/i);
  await assert.rejects(restarted.search('needle', '', forge(search.next_cursor!, { li: 10 ** 6 })), /invalid cursor/i);
  // Expiry and future dating.
  await assert.rejects(restarted.listFiles('', forge(first.next_cursor!, { t: now + 60 * 60_000 })), /invalid cursor|future/i);
  now += 25 * 3_600_000;
  await assert.rejects(restarted.listFiles('', first.next_cursor!), /expired/i);
  await assert.rejects(restarted.search('needle', '', search.next_cursor!), /expired/i);
});

test('search skips non-text files in glob mode and says so', async t => {
  const m = await makeRepo(t, { 'data/blob.bin': Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0xff]), 'data/latin1.txt': Buffer.from('needle \xe9\n', 'latin1'), 'data/ok.txt': 'needle ok\n' });
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);
  const result = await repo.search('needle');
  assert.deepEqual(result.matches.map(x => x.path), ['data/ok.txt']);
  assert.equal((result as { skipped_files?: number }).skipped_files, 2);
  await assert.rejects(repo.read('data/blob.bin'), /binary|UTF-8/i, 'read of a non-text file stays an explicit error');
});

test('repo_info in glob mode reports the inventory and a policy summary', async t => {
  const m = await makeRepo(t, manyFiles(300));
  const repo = await openGlob(t, m.root, policyDoc({ write: { include: ['bulk/**'], exclude: [] }, create: { paths: [], directories: ['bulk'], extensions: ['.txt'] } }), {}, m.track);
  const info = await repo.info({ capabilities: { x: 1 } }) as Record<string, any>;
  assert.equal(Buffer.byteLength(JSON.stringify(info)) <= 32 * 1024, true);
  assert.equal(info.inventory.paths, 305 + 0);
  assert.equal(info.policy_summary.create.directories[0], 'bulk');
  assert.ok(info.files_next_cursor || info.files.length === 305);
  assert.ok(info.instructions.length > 0);
});

test('large trees list and page within budget', async t => {
  const m = await makeRepo(t, manyFiles(20_000, 'tree'));
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);
  const started = Date.now();
  const { paths } = await listAll(repo);
  assert.equal(paths.length, 20_005);
  assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
  const fresh = Date.now();
  await repo.listFiles();
  assert.ok(Date.now() - fresh < 10_000, `a fresh call revalidates 20k entries in ${Date.now() - fresh} ms`);
  assert.equal(await readFile(path.join(m.root, paths.find(p => p.startsWith('tree/'))!), 'utf8').then(x => x.length > 0), true);
});

test('a reviewed secret_exceptions entry exposes a conventional example file and nothing else', async t => {
  const m = await makeRepo(t, { '.env.example': 'API_KEY=changeme\n' }, { '.env': 'API_KEY=real', '.env.local': 'x', 'config/.env.sample': 'x' });
  const doc = policyDoc({ dotfiles: ['.env.example', '.env.local', 'config/.env.sample'], secret_exceptions: ['.env.example'] });
  const repo = await openGlob(t, m.root, doc, {}, m.track);
  const { paths } = await listAll(repo);
  assert.ok(paths.includes('.env.example'));
  for (const hidden of ['.env', '.env.local', 'config/.env.sample']) assert.ok(!paths.includes(hidden), hidden);
  assert.equal((await repo.readRange('.env.example')).content, 'API_KEY=changeme\n');
  await assert.rejects(repo.read('.env'), /not exposed/);
});

test('untracked git-ignored files are hidden from list, read and search; tracked ones stay visible', async t => {
  const m = await makeRepo(t, { '.gitignore': 'config/local.yml\ntmp/\n*.tfout\nforced.tfout\n', 'config/app.yml': 'app: needle\n' }, {
    'config/local.yml': 'db_password: needle\n', 'tmp/cache/state.json': '{"needle":1}\n', 'deep/run.tfout': 'needle\n', 'notes.txt': 'needle\n'
  });
  await writeFile(path.join(m.root, 'forced.tfout'), 'needle tracked\n');
  await git(m.root, 'add', '-f', 'forced.tfout');
  await git(m.root, 'commit', '-m', 'force-track an ignored name');
  const repo = await openGlob(t, m.root, policyDoc({ dotfiles: ['.gitignore'] }), {}, m.track);
  const { paths, last } = await listAll(repo);
  for (const hidden of ['config/local.yml', 'tmp/cache/state.json', 'deep/run.tfout']) assert.ok(!paths.includes(hidden), hidden);
  for (const shown of ['config/app.yml', 'notes.txt', 'forced.tfout', '.gitignore']) assert.ok(paths.includes(shown), shown);
  assert.equal(last.inventory.skipped.git_ignored, 3, 'ignored files and directories are counted');
  for (const hidden of ['config/local.yml', 'tmp/cache/state.json', 'deep/run.tfout']) await assert.rejects(repo.read(hidden), /not exposed/, hidden);
  const found = (await repo.search('needle')).matches.map(x => x.path);
  assert.deepEqual(byteSort([...new Set(found)]), byteSort(['config/app.yml', 'forced.tfout', 'notes.txt']));
});

test('a .gitignore change without a directory change takes effect on the next call', async t => {
  const m = await makeRepo(t, { '.gitignore': 'tmp/\n' }, { 'config/secret-ish.yml': 'token: x\n' });
  const repo = await openGlob(t, m.root, policyDoc({ dotfiles: ['.gitignore'] }), {}, m.track);
  assert.ok((await listAll(repo)).paths.includes('config/secret-ish.yml'));
  // Rewriting the same inode does not move any directory's metadata.
  await writeFile(path.join(m.root, '.gitignore'), 'tmp/\nconfig/secret-ish.yml\n');
  assert.ok(!(await listAll(repo)).paths.includes('config/secret-ish.yml'), 'newly ignored file is hidden');
  await assert.rejects(repo.read('config/secret-ish.yml'), /not exposed/);
  await writeFile(path.join(m.root, '.gitignore'), 'tmp/\n');
  assert.ok((await listAll(repo)).paths.includes('config/secret-ish.yml'), 'un-ignoring restores it');
});

test('a repository-local core.excludesFile and its target file are ignore sources', async t => {
  const m = await makeRepo(t, {}, { 'notes/local.txt': 'private\n', 'notes/other.txt': 'other\n' });
  const excludes = path.join(m.base, 'extra-excludes');
  await writeFile(excludes, '\n');
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);
  assert.ok((await listAll(repo)).paths.includes('notes/local.txt'));
  // Pointing core.excludesFile at a file changes only .git/config, never a walked directory.
  await writeFile(excludes, 'notes/local.txt\n');
  await git(m.root, 'config', 'core.excludesFile', excludes);
  assert.ok(!(await listAll(repo)).paths.includes('notes/local.txt'), 'config change applies on the next call');
  await assert.rejects(repo.read('notes/local.txt'), /not exposed/);
  // Editing the external excludes file is tracked too.
  await writeFile(excludes, 'notes/local.txt\nnotes/other.txt\n');
  const after = (await listAll(repo)).paths;
  assert.ok(!after.includes('notes/other.txt'), 'external excludes file edit applies on the next call');
});

test('a .gitignore edited while discovery runs never yields a stale first answer', async t => {
  const m = await makeRepo(t, { '.gitignore': 'tmp/\n' }, { 'config/late.yml': 'token: x\n' });
  let edited = false;
  const repo = await openGlob(t, m.root, policyDoc({ dotfiles: ['.gitignore'] }), {
    pathHook: async (stage, ctx) => {
      // After Git has listed ignored paths for the first walk, the rules change in place.
      if (stage === 'walk:enter' && ctx.path === '' && !edited) { edited = true; await writeFile(path.join(m.root, '.gitignore'), 'tmp/\nconfig/late.yml\n'); }
    }
  }, m.track);
  const first = (await listAll(repo)).paths;
  assert.ok(edited);
  assert.ok(!first.includes('config/late.yml'), 'the first answer already reflects the edited rules');
});

test('a .gitignore edited during a cached refresh never yields a stale answer', async t => {
  const m = await makeRepo(t, { '.gitignore': 'tmp/\n' }, { 'config/private.yml': 'token: x\n' });
  let armed = false, edited = false;
  const repo = await openGlob(t, m.root, policyDoc({ dotfiles: ['.gitignore'] }), {
    pathHook: async stage => {
      // After refresh has accepted the recorded ignore sources, the rules change in place.
      if (stage === 'refresh:sources-checked' && armed && !edited) { edited = true; await writeFile(path.join(m.root, '.gitignore'), 'tmp/\nconfig/private.yml\n'); }
    }
  }, m.track);
  assert.ok((await listAll(repo)).paths.includes('config/private.yml'));
  armed = true;
  const paths = (await listAll(repo)).paths;
  assert.ok(edited);
  assert.ok(!paths.includes('config/private.yml'), 'the refreshed answer already reflects the edited rules');
});

test('an include.path config file, even empty or missing at first, is an ignore source', async t => {
  const m = await makeRepo(t, {}, { 'notes/local.txt': 'private\n' });
  const excludes = path.join(m.base, 'extra-excludes');
  await writeFile(excludes, 'notes/local.txt\n');
  await writeFile(path.join(m.root, '.git', 'extra.conf'), '');
  await git(m.root, 'config', '--add', 'include.path', 'extra.conf');
  await git(m.root, 'config', '--add', 'include.path', 'missing.conf');
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);
  assert.ok((await listAll(repo)).paths.includes('notes/local.txt'));
  await writeFile(path.join(m.root, '.git', 'extra.conf'), `[core]\n\texcludesFile = ${excludes}\n`);
  assert.ok(!(await listAll(repo)).paths.includes('notes/local.txt'), 'editing an empty included file applies');
  await writeFile(path.join(m.root, '.git', 'extra.conf'), '');
  assert.ok((await listAll(repo)).paths.includes('notes/local.txt'));
  await writeFile(path.join(m.root, '.git', 'missing.conf'), `[core]\n\texcludesFile = ${excludes}\n`);
  assert.ok(!(await listAll(repo)).paths.includes('notes/local.txt'), 'creating a missing included file applies');
});

test('a symlinked excludes file is tracked through its target', async t => {
  const m = await makeRepo(t, {}, { 'notes/local.txt': 'private\n' });
  const target = path.join(m.base, 'real-excludes');
  await writeFile(target, '\n');
  await symlink(target, path.join(m.base, 'linked-excludes'));
  await git(m.root, 'config', 'core.excludesFile', path.join(m.base, 'linked-excludes'));
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);
  assert.ok((await listAll(repo)).paths.includes('notes/local.txt'));
  await writeFile(target, 'notes/local.txt\n');
  assert.ok(!(await listAll(repo)).paths.includes('notes/local.txt'), 'editing the link target applies');
});

test('ignored files and directories with decomposed (NFD) names stay hidden', async t => {
  const nfdFile = 'notes/café.private', nfdDir = 'resumés';
  const m = await makeRepo(t, { '.gitignore': '*.private\nresum*/\n' }, { [nfdFile]: 'secret\n', [`${nfdDir}/cv.txt`]: 'private\n', 'notes/plain.txt': 'ok\n' });
  const repo = await openGlob(t, m.root, policyDoc({ dotfiles: ['.gitignore'] }), {}, m.track);
  const paths = (await listAll(repo)).paths.map(p => p.normalize('NFC'));
  assert.ok(paths.includes('notes/plain.txt'));
  assert.ok(!paths.includes(nfdFile.normalize('NFC')), 'NFD ignored file is hidden');
  assert.ok(!paths.includes(`${nfdDir}/cv.txt`.normalize('NFC')), 'files in an NFD ignored directory are hidden');
  await assert.rejects(repo.read(nfdFile), /not exposed/);
  assert.equal((await repo.search('secret')).matches.length, 0);
});

test('nested repositories and submodules are not walked, so their ignored files never leak', async t => {
  const m = await makeRepo(t, {}, { 'nested/.gitignore': 'local.cfg\n', 'nested/local.cfg': 'token\n', 'nested/readme.txt': 'hi\n' });
  await git(path.join(m.root, 'nested'), 'init', '-q');
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);
  const { paths, last } = await listAll(repo);
  assert.ok(!paths.some(p => p.startsWith('nested/')), paths.join());
  assert.equal(last.inventory.skipped.nested_repo, 1);
});

test('a branch-conditional include is re-checked when HEAD moves', async t => {
  const m = await makeRepo(t, {}, { 'notes/local.txt': 'private\n' });
  const excludes = path.join(m.base, 'branch-excludes');
  await writeFile(excludes, 'notes/local.txt\n');
  await writeFile(path.join(m.root, '.git', 'branch.conf'), `[core]\n\texcludesFile = ${excludes}\n`);
  await git(m.root, 'config', 'includeIf.onbranch:other.path', 'branch.conf');
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);
  assert.ok((await listAll(repo)).paths.includes('notes/local.txt'));
  await git(m.root, 'symbolic-ref', 'HEAD', 'refs/heads/other');
  assert.ok(!(await listAll(repo)).paths.includes('notes/local.txt'), 'rules that apply on the new branch are used');
});

test('churn of unrelated ignored files does not make discovery fail', async t => {
  const m = await makeRepo(t, { '.gitignore': '*.tmp\n' }, { 'src/visible.txt': 'ok\n' });
  let n = 0;
  const repo = await openGlob(t, m.root, policyDoc({ dotfiles: ['.gitignore'] }), {
    // A build writes a new ignored cache file after the root has been listed, on every attempt.
    pathHook: async (stage, ctx) => { if (stage === 'walk:enter' && ctx.path === 'src') await writeFile(path.join(m.root, `build-${n++}.tmp`), 'x'); }
  }, m.track);
  const paths = (await listAll(repo)).paths;
  assert.ok(paths.includes('src/visible.txt'));
  assert.ok(!paths.some(p => p.endsWith('.tmp')));
});

test('an include added while sources are being fingerprinted is still tracked', async t => {
  const m = await makeRepo(t, {}, { 'notes/local.txt': 'private\n' });
  const excludes = path.join(m.base, 'late-excludes');
  await writeFile(excludes, 'notes/local.txt\n');
  await writeFile(path.join(m.root, '.git', 'late.conf'), '');
  let added = false;
  const repo = await openGlob(t, m.root, policyDoc(), {
    pathHook: async stage => {
      // An empty include changes no ignore result, so only the source-set re-check can notice it.
      if (stage === 'walk:sources-listed' && !added) { added = true; await git(m.root, 'config', '--add', 'include.path', 'late.conf'); }
    }
  }, m.track);
  assert.ok((await listAll(repo)).paths.includes('notes/local.txt'));
  assert.ok(added);
  await writeFile(path.join(m.root, '.git', 'late.conf'), `[core]\n\texcludesFile = ${excludes}\n`);
  assert.ok(!(await listAll(repo)).paths.includes('notes/local.txt'), 'the late include target is a recorded source');
});

test('NFD names stay hidden when Git also prints NFD (core.precomposeunicode=false)', async t => {
  const nfdFile = 'notes/café.private';
  const m = await makeRepo(t, { '.gitignore': '*.private\n' }, { [nfdFile]: 'secret\n', 'notes/plain.txt': 'ok\n' });
  await git(m.root, 'config', 'core.precomposeunicode', 'false');
  const repo = await openGlob(t, m.root, policyDoc({ dotfiles: ['.gitignore'] }), {}, m.track);
  const paths = (await listAll(repo)).paths.map(p => p.normalize('NFC'));
  assert.ok(paths.includes('notes/plain.txt'));
  assert.ok(!paths.includes(nfdFile.normalize('NFC')));
  await assert.rejects(repo.read(nfdFile), /not exposed/);
});

test('ignored_exact lists only the named Git-ignored files; everything else stays hidden', async t => {
  const m = await makeRepo(t, { '.gitignore': 'research/\n*.tfout\n' }, {
    'research/notes.md': 'needle notes\n', 'research/raw.md': 'needle raw\n', 'deep/run.tfout': 'needle\n', 'research/.env': 'TOKEN=x\n'
  });
  const repo = await openGlob(t, m.root, policyDoc({ dotfiles: ['.gitignore'], ignored_exact: ['research/notes.md', 'research/absent.md'] }), {}, m.track);
  const { paths } = await listAll(repo);
  assert.ok(paths.includes('research/notes.md'));
  for (const hidden of ['research/raw.md', 'deep/run.tfout', 'research/.env', 'research/absent.md']) assert.ok(!paths.includes(hidden), hidden);
  assert.equal((await repo.readRange('research/notes.md')).content, 'needle notes\n');
  await assert.rejects(repo.read('research/raw.md'), /not exposed/);
  const found = (await repo.search('needle')).matches.map(x => x.path);
  assert.ok(found.includes('research/notes.md') && !found.includes('research/raw.md'));
  // Creating a listed file later is noticed through its watched parent directory.
  await writeFile(path.join(m.root, 'research', 'absent.md'), 'late\n');
  assert.ok((await listAll(repo)).paths.includes('research/absent.md'));
});

test('ignored_exact rejects patterns, secrets and paths the read policy denies', async () => {
  const { loadPolicy, compilePolicyFor } = await import('../src/policy.js');
  const compile = async (over: Record<string, unknown>) => compilePolicyFor(loadPolicy(policyDoc(over)));
  await assert.rejects(compile({ ignored_exact: ['research/*.md'] }), /exact path/);
  await assert.rejects(compile({ ignored_exact: ['research/.env'] }), /not readable|denied/);
  await assert.rejects(compile({ read: { include: ['src/**'], exclude: [] }, ignored_exact: ['research/notes.md'] }), /not readable/);
  // Off by default and an empty list keep the policy digest unchanged.
  const { policyDigest } = await import('../src/policy.js');
  assert.equal(policyDigest(loadPolicy(policyDoc({ ignored_exact: [] }))), policyDigest(loadPolicy(policyDoc())));
});

test('ignored_exact watches existing parents when a deeper parent is missing, so a later create is seen', async t => {
  const m = await makeRepo(t, { '.gitignore': 'research/\n' }, { 'research/old.md': 'old\n' });
  const repo = await openGlob(t, m.root, policyDoc({ dotfiles: ['.gitignore'], ignored_exact: ['research/new/notes.md'] }), {}, m.track);
  assert.ok(!(await listAll(repo)).paths.includes('research/new/notes.md'));
  await mkdir(path.join(m.root, 'research', 'new'));
  await writeFile(path.join(m.root, 'research', 'new', 'notes.md'), 'fresh\n');
  assert.ok((await listAll(repo)).paths.includes('research/new/notes.md'));
});

test('a parent of an ignored_exact file that becomes a nested repository during discovery is not used', async t => {
  const m = await makeRepo(t, { '.gitignore': 'research/\n' }, { 'research/notes.md': 'needle\n' });
  let made = false;
  const repo = await openGlob(t, m.root, policyDoc({ dotfiles: ['.gitignore'], ignored_exact: ['research/notes.md'] }), {
    pathHook: async stage => {
      if (stage === 'walk:sources-listed' && !made) { made = true; await mkdir(path.join(m.root, 'research', '.git')); }
    }
  }, m.track);
  const { paths, last } = await listAll(repo);
  assert.ok(made);
  assert.ok(!paths.includes('research/notes.md'), 'the retried walk sees the nested repository');
  assert.ok(last.inventory.skipped.nested_repo >= 1);
  await assert.rejects(repo.read('research/notes.md'), /not exposed/);
});

test('an ignored_exact file is not read once its parent becomes a nested repository at read time', async t => {
  const m = await makeRepo(t, { '.gitignore': 'research/\n' }, { 'research/notes.md': 'needle\n' });
  let arm = false;
  const repo = await openGlob(t, m.root, policyDoc({ dotfiles: ['.gitignore'], ignored_exact: ['research/notes.md'] }), {
    pathHook: async (stage, ctx) => { if (arm && stage === 'read:after-check' && ctx.path === 'research/notes.md') await mkdir(path.join(m.root, 'research', '.git')); }
  }, m.track);
  assert.ok((await listAll(repo)).paths.includes('research/notes.md'));
  arm = true;
  await assert.rejects(repo.read('research/notes.md'), /not exposed/);
});

test('removing a nested-repository marker makes a listed ignored file visible on refresh', async t => {
  const m = await makeRepo(t, { '.gitignore': 'research/\n' }, { 'research/notes.md': 'needle\n' });
  await mkdir(path.join(m.root, 'research', '.git'));
  const repo = await openGlob(t, m.root, policyDoc({ dotfiles: ['.gitignore'], ignored_exact: ['research/notes.md'] }), {}, m.track);
  assert.ok(!(await listAll(repo)).paths.includes('research/notes.md'));
  await rm(path.join(m.root, 'research', '.git'), { recursive: true });
  assert.ok((await listAll(repo)).paths.includes('research/notes.md'));
});
