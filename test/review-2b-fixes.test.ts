import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, link, symlink, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { RepoWorkspace, defaultPolicy } from '../src/repo.js';
import { loadPolicy, policyDigest } from '../src/policy.js';
import { makeRepo, openGlob, policyDoc, git } from './helpers.js';

// Milestone 2b review fixes: (1) diff reads only filesystem-eligible files, (2) retained captures are bound to
// index state, (3) list_files and search never overflow page_bytes and fail explicitly when nothing fits.

const CANARY = 'CANARY-OUTSIDE-SECRET-4711';
const DIFF = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', 'HEAD'];
const writable = (...include: string[]) => policyDoc({ write: { include, exclude: [] } });

async function fullDiff(repo: RepoWorkspace, prefix = '') {
  let page = await repo.diff(prefix);
  let text = page.diff;
  while (page.next_cursor) { page = await repo.diff(prefix, page.next_cursor); text += page.diff; }
  return text;
}
const outsideFile = async (base: string, name = 'outside.txt', content = `${CANARY}\n`) => { const file = path.join(base, name); await writeFile(file, content); return file; };

// --- 1. git_diff and filesystem eligibility ----------------------------------------------------

test('diff never exposes a tracked file replaced by a hard link to an outside file (glob and exact policies)', async t => {
  for (const exact of [false, true]) {
    const m = await makeRepo(t);
    const repo = exact ? m.track(await RepoWorkspace.create(m.root, defaultPolicy)) : await openGlob(t, m.root, writable('src/**'), {}, m.track);
    const outside = await outsideFile(m.base, `outside-${exact}.txt`);
    await rm(path.join(m.root, 'src/clamp.js'));
    await link(outside, path.join(m.root, 'src/clamp.js'));
    if (!exact) assert.ok(!(await repo.listFiles()).files.some(f => f.path === 'src/clamp.js'), 'inventory refuses it');
    await assert.rejects(repo.read('src/clamp.js'));
    const text = await fullDiff(repo);
    assert.ok(!text.includes(CANARY), `canary leaked (exact=${exact})`);
    assert.match(text, /# no patch for src\/clamp\.js \(/, 'the omission is explicit, not silent');
    assert.equal(await readFile(outside, 'utf8'), `${CANARY}\n`);
  }
});

test('diff never exposes a symlinked file, a symlinked parent directory, an oversized file or an unsafe component', async t => {
  const m = await makeRepo(t, { 'src/sub/a.js': 'export const a = 1;\n', 'src/small.js': 'export const s = 1;\n', 'src/ok.js': 'export const ok = 1;\n' });
  const repo = await openGlob(t, m.root, writable('src/**'), { limits: { edit_file_bytes: 4096 } }, m.track);
  const outsideDir = path.join(m.base, 'outside-dir');
  await mkdir(path.join(outsideDir), { recursive: true });
  await writeFile(path.join(outsideDir, 'a.js'), `${CANARY} dir\n`);
  const secret = await outsideFile(m.base, 'secret.txt');
  await rm(path.join(m.root, 'src/clamp.js'));
  await symlink(secret, path.join(m.root, 'src/clamp.js'));
  await rm(path.join(m.root, 'src/sub'), { recursive: true });
  await symlink(outsideDir, path.join(m.root, 'src/sub'));
  await writeFile(path.join(m.root, 'src/small.js'), `// ${CANARY} big\n${'x'.repeat(5000)}\n`);
  await writeFile(path.join(m.root, 'src/ok.js'), 'export const ok = 2;\n');
  const text = await fullDiff(repo);
  assert.ok(!text.includes(CANARY), 'no outside or oversized content');
  assert.ok(!text.includes(secret) && !text.includes(outsideDir), 'no symlink target text');
  assert.match(text, /\+export const ok = 2;/, 'eligible changes are still shown');
  for (const name of ['src/clamp.js', 'src/small.js']) assert.match(text, new RegExp(`# no patch for ${name.replace('.', '\\.')} \\(`));
});

test('genuine tracked deletions are still reported next to an ineligible file', async t => {
  const m = await makeRepo(t, { 'src/gone.js': 'export const gone = 1;\n', 'src/dir/inner.js': 'export const inner = 1;\n' });
  const repo = await openGlob(t, m.root, writable('src/**'), {}, m.track);
  const outside = await outsideFile(m.base);
  await rm(path.join(m.root, 'src/gone.js'));
  await rm(path.join(m.root, 'src/dir'), { recursive: true });
  await rm(path.join(m.root, 'src/clamp.js'));
  await link(outside, path.join(m.root, 'src/clamp.js'));
  const text = await fullDiff(repo);
  assert.match(text, /diff --git a\/src\/gone\.js b\/src\/gone\.js\ndeleted file mode/);
  assert.match(text, /diff --git a\/src\/dir\/inner\.js b\/src\/dir\/inner\.js\ndeleted file mode/);
  assert.match(text, /-export const inner = 1;/);
  assert.ok(!text.includes(CANARY));
  // A staged deletion whose file is gone also stays visible.
  await git(m.root, 'rm', '-q', '--cached', '--', 'src/gone.js');
  assert.match(await fullDiff(repo), /deleted file mode/);
});

test('a swap to a hard link between the eligibility check and Git is never published', async t => {
  const m = await makeRepo(t);
  const outside = await outsideFile(m.base);
  let swapped = false;
  const repo = await openGlob(t, m.root, writable('src/**'), {
    captureHook: async (stage, attempt, run) => {
      // Runs 0 and 1 list names; run 2 is the first patch batch, after the eligibility check.
      if (stage === 'before-git' && attempt === 0 && run === 2 && !swapped) {
        swapped = true;
        await rm(path.join(m.root, 'src/clamp.js'));
        await link(outside, path.join(m.root, 'src/clamp.js'));
      }
    }
  }, m.track);
  await writeFile(path.join(m.root, 'src/clamp.js'), 'export const changed = 1;\n');
  const outcome = await repo.diff().then(page => ({ page }), error => ({ error: error as Error }));
  assert.equal(swapped, true, 'the swap was injected');
  if ('page' in outcome) assert.ok(!outcome.page.diff.includes(CANARY));
  else assert.match(outcome.error.message, /changed while/i);
  for (const capture of await repo.captures.list()) assert.ok(!(await readFile(path.join(repo.captures.dir, `${capture.id}.out`), 'utf8')).includes(CANARY), 'no retained capture holds the canary');
});

// --- 2. index state binding -------------------------------------------------------------------

const bigContent = (tag: string) => Array.from({ length: 3000 }, (_, i) => `${tag} line ${i} ${'y'.repeat(20)}\n`).join('');
const MARKER = /# no working-tree patch for staged\.txt/;

/** A diff of several pages whose capture ends with the staged-only marker for staged.txt. */
async function stagedOnlyFixture(t: Parameters<typeof makeRepo>[0], options: { task?: boolean; root?: string } = {}) {
  const m = await makeRepo(t, { 'big.txt': bigContent('old'), 'staged.txt': 'one\n' });
  const doc = policyDoc();
  const taskOptions = options.task ? { task: { stateDir: path.join(m.base, 'state'), taskId: 'idx', policyDigest: policyDigest(loadPolicy(doc)) } } : {};
  const open = () => openGlob(t, m.root, doc, taskOptions, m.track);
  const repo = await open();
  await writeFile(path.join(m.root, 'big.txt'), bigContent('new'));
  await writeFile(path.join(m.root, 'staged.txt'), 'two\n');
  await git(m.root, 'add', '--', 'staged.txt');
  await writeFile(path.join(m.root, 'staged.txt'), 'one\n');
  return { m, repo, open };
}

test('a diff cursor goes stale when only the index changes (staged-only path reset)', async t => {
  const { m, repo } = await stagedOnlyFixture(t);
  const first = await repo.diff();
  assert.equal(first.complete, false, 'multi-page capture');
  assert.match(await fullDiff(repo), MARKER);
  await git(m.root, 'reset', '-q', 'HEAD', '--', 'staged.txt');
  await assert.rejects(repo.diff('', first.next_cursor!), /stale cursor/i);
  assert.doesNotMatch(await fullDiff(repo), MARKER, 'a fresh diff has no marker');
});

test('a diff cursor goes stale when a path becomes staged-only after capture', async t => {
  const { m, repo } = await stagedOnlyFixture(t);
  await git(m.root, 'reset', '-q', 'HEAD', '--', 'staged.txt');
  const first = await repo.diff();
  assert.equal(first.complete, false);
  // Index-only change: the working file is not touched, so its metadata stays as captured.
  const staged = path.join(m.base, 'staged-content.txt');
  await writeFile(staged, 'two\n');
  const blob = (await git(m.root, 'hash-object', '-w', staged)).trim();
  await git(m.root, 'update-index', '--cacheinfo', `100644,${blob},staged.txt`);
  await assert.rejects(repo.diff('', first.next_cursor!), /stale cursor/i);
  assert.match(await fullDiff(repo), MARKER);
});

test('index refreshes that change only stat data do not invalidate a cursor', async t => {
  const m = await makeRepo(t, { 'big.txt': bigContent('old') });
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);
  await writeFile(path.join(m.root, 'big.txt'), bigContent('new'));
  const first = await repo.diff();
  assert.equal(first.complete, false);
  const indexBefore = await readFile(path.join(m.root, '.git/index'));
  await git(m.root, 'read-tree', 'HEAD');          // same entries, zeroed stat data
  await git(m.root, 'status', '--short');          // refresh rewrites stat data
  assert.ok(!indexBefore.equals(await readFile(path.join(m.root, '.git/index'))), 'the index file really was rewritten');
  const second = await repo.diff('', first.next_cursor!);
  assert.ok(second.diff.length > 0);
});

test('a status cursor goes stale when only the index changes', async t => {
  const untracked = Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`untracked-with-a-deliberately-long-file-name-${String(i).padStart(5, '0')}.txt`, 'x']));
  const m = await makeRepo(t, {}, untracked);
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);
  const info = await repo.info();
  assert.ok(info.status_next_cursor, 'status spans pages');
  assert.ok((await repo.statusPage(info.status_next_cursor!)).status.length > 0, 'valid while the index is unchanged');
  await git(m.root, 'add', '--', 'untracked-with-a-deliberately-long-file-name-00001.txt');
  await assert.rejects(repo.statusPage(info.status_next_cursor!), /stale cursor/i);
  const fresh = await repo.info();
  assert.match(fresh.status, /A {2}untracked-with-a-deliberately-long-file-name-00001\.txt/);
  await git(m.root, 'reset', '-q', 'HEAD', '--', 'untracked-with-a-deliberately-long-file-name-00001.txt');
  await assert.rejects(repo.statusPage(fresh.status_next_cursor!), /stale cursor/i);
});

test('an index change during capture is never published; a persistent one fails explicitly', async t => {
  const { m } = await stagedOnlyFixture(t);
  // One change after Git has run: attempt 0 is discarded, attempt 1 reflects the new index.
  let calls = 0;
  const once = await openGlob(t, m.root, policyDoc(), {
    captureHook: async stage => { if (stage === 'after-git' && calls++ === 0) await git(m.root, 'reset', '-q', 'HEAD', '--', 'staged.txt'); }
  }, m.track);
  const text = await fullDiff(once);
  assert.equal(calls, 2, 'the first capture was discarded and repeated');
  assert.doesNotMatch(text, MARKER, 'the published capture shows the final index');
  // A path that is re-staged and reset on every attempt never settles.
  let n = 0;
  const churn = await openGlob(t, m.root, policyDoc(), {
    captureHook: async stage => {
      if (stage !== 'after-git') return;
      if (n++ % 2 === 0) { await writeFile(path.join(m.root, 'staged.txt'), 'two\n'); await git(m.root, 'add', '--', 'staged.txt'); await writeFile(path.join(m.root, 'staged.txt'), 'one\n'); }
      else await git(m.root, 'reset', '-q', 'HEAD', '--', 'staged.txt');
    }
  }, m.track);
  await assert.rejects(churn.diff(), /changed while/i);
  assert.deepEqual(await churn.captures.list(), [], 'nothing retained');
  // Same for status through repo_info.
  let s = 0;
  const status = await openGlob(t, m.root, policyDoc(), {
    captureHook: async stage => { if (stage === 'after-git') { s++; await git(m.root, ...(s % 2 ? ['add', '--', 'big.txt'] : ['reset', '-q', '--', 'big.txt'])); } }
  }, m.track);
  await assert.rejects(status.info(), /changed while/i);
});

test('task captures keep their index binding across a restart', async t => {
  const { m, repo, open } = await stagedOnlyFixture(t, { task: true });
  const first = await repo.diff();
  assert.equal(first.complete, false);
  await repo.close();
  const same = await open();
  assert.ok((await same.diff('', first.next_cursor!)).diff.length > 0, 'valid after restart while the index is unchanged');
  await same.close();
  await git(m.root, 'reset', '-q', 'HEAD', '--', 'staged.txt');
  const changed = await open();
  await assert.rejects(changed.diff('', first.next_cursor!), /stale cursor/i);
});

test('in a linked worktree the binding follows that worktree\'s own index', async t => {
  const m = await makeRepo(t, { 'big.txt': bigContent('old'), 'staged.txt': 'one\n' });
  const tree = path.join(m.base, 'linked');
  await git(m.root, 'worktree', 'add', '-q', '-b', 'linked-branch', tree);
  const root = await realpath(tree);
  const repo = await openGlob(t, root, policyDoc(), {}, m.track);
  await writeFile(path.join(root, 'big.txt'), bigContent('new'));
  await writeFile(path.join(root, 'staged.txt'), 'two\n');
  await git(root, 'add', '--', 'staged.txt');
  await writeFile(path.join(root, 'staged.txt'), 'one\n');
  const first = await repo.diff();
  assert.equal(first.complete, false);
  // The main checkout has its own index: changing it leaves the linked capture valid.
  await writeFile(path.join(m.root, 'staged.txt'), 'main\n');
  await git(m.root, 'add', '--', 'staged.txt');
  assert.ok((await repo.diff('', first.next_cursor!)).diff.length > 0);
  await git(root, 'reset', '-q', 'HEAD', '--', 'staged.txt');
  await assert.rejects(repo.diff('', first.next_cursor!), /stale cursor/i);
});

// --- 3. response budget ---------------------------------------------------------------------------

const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`dir/file-${String(i).padStart(2, '0')}.js`, `export const value${i} = ${i};\n// match target\n`]));
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test('list_files: a page budget below metadata plus the first entry fails explicitly (page_bytes 400 repro)', async t => {
  const m = await makeRepo(t, many);
  const small = await openGlob(t, m.root, policyDoc(), { limits: { page_bytes: 400 } }, m.track);
  await assert.rejects(small.listFiles(), /page_bytes \(400\)/);
  await assert.rejects(small.listFiles('dir/'), /page_bytes \(400\)/);
  const tiny = await openGlob(t, m.root, policyDoc(), { limits: { page_bytes: 100 } }, m.track);
  await assert.rejects(tiny.listFiles('no-such-prefix/'), /page_bytes \(100\)/, 'oversized metadata alone is rejected too');
});

test('list_files: the response never exceeds page_bytes at any budget, and the boundary is exact', async t => {
  const m = await makeRepo(t, many);
  const at = async (pageBytes: number) => openGlob(t, m.root, policyDoc(), { limits: { page_bytes: pageBytes } }, m.track);
  const reference = await openGlob(t, m.root, policyDoc(), {}, m.track);
  // Exact boundary: one entry, complete response.
  const one = size(await reference.listFiles('dir/file-07.js'));
  assert.equal((await (await at(one)).listFiles('dir/file-07.js')).files.length, 1);
  await assert.rejects((await at(one - 1)).listFiles('dir/file-07.js'), /page_bytes/);
  // Exact boundary: empty complete response.
  const empty = size(await reference.listFiles('none/'));
  assert.deepEqual((await (await at(empty)).listFiles('none/')).files, []);
  await assert.rejects((await at(empty - 1)).listFiles('none/'), /page_bytes/);
  // Sweep: every budget either fails explicitly or pages the whole inventory within budget, with progress.
  const all = (await reference.listFiles()).files.map(f => f.path);
  let sawFailure = false, sawSuccess = false;
  for (let budget = 150; budget <= 1400; budget += 23) {
    const repo = await at(budget);
    const seen: string[] = [];
    try {
      let page = await repo.listFiles('dir/');
      for (let guard = 0; ; guard++) {
        assert.ok(size(page) <= budget, `budget ${budget}: response ${size(page)} bytes`);
        assert.ok(page.files.length > 0 || page.complete, 'a page makes progress');
        seen.push(...page.files.map(f => f.path));
        if (!page.next_cursor) break;
        assert.ok(guard < 100, 'cursor chain terminates');
        page = await repo.listFiles('dir/', page.next_cursor);
      }
      assert.deepEqual(seen, all.filter(p => p.startsWith('dir/')));
      sawSuccess = true;
    } catch (error) {
      if (!/page_bytes/.test((error as Error).message)) throw error;
      sawFailure = true;
    }
  }
  assert.ok(sawFailure && sawSuccess, 'sweep covers both sides of the boundary');
});

test('search: a first match that does not fit fails explicitly; every budget stays within page_bytes', async t => {
  const long = `${'q'.repeat(280)} needle ${'r'.repeat(280)}`;
  const m = await makeRepo(t, { ...many, 'wide.txt': `${long}\nneedle again\n` });
  const at = (pageBytes: number) => openGlob(t, m.root, policyDoc(), { limits: { page_bytes: pageBytes } }, m.track);
  await assert.rejects((await at(400)).search('needle', 'wide.txt'), /page_bytes \(400\)/);
  let sawFailure = false, sawSuccess = false;
  for (let budget = 120; budget <= 1500; budget += 29) {
    const repo = await at(budget);
    try {
      let page = await repo.search('needle');
      const lines: string[] = [];
      for (let guard = 0; ; guard++) {
        assert.ok(size(page) <= budget, `budget ${budget}: response ${size(page)} bytes`);
        assert.ok(page.matches.length > 0 || page.complete, 'a page makes progress');
        lines.push(...page.matches.map(x => `${x.path}:${x.line}`));
        if (!page.next_cursor) break;
        assert.ok(guard < 100, 'cursor chain terminates');
        page = await repo.search('needle', '', page.next_cursor);
      }
      assert.deepEqual(lines, ['wide.txt:1', 'wide.txt:2']);
      sawSuccess = true;
    } catch (error) {
      if (!/page_bytes/.test((error as Error).message)) throw error;
      sawFailure = true;
    }
  }
  assert.ok(sawFailure && sawSuccess);
});

// --- 2b. index entry flags that `ls-files -s -v` does not carry (intent-to-add, skip-worktree, assume-unchanged) ---------

const LONG_NAME = (i: number) => `untracked-with-a-deliberately-long-file-name-${String(i).padStart(5, '0')}.txt`;
const listing = (root: string) => git(root, 'ls-files', '--stage', '-v', '-z');
const statusOf = (root: string, ...paths: string[]) => git(root, 'status', '--short', '--branch', '--untracked-files=all', ...(paths.length ? ['--', ...paths] : []));
const stage = async (root: string, ...args: string[]) => { await git(root, ...args); };

/** A repo whose repo_info status spans several pages, with an empty file and a tracked file to flag. */
async function flagFixture(t: Parameters<typeof makeRepo>[0], prepare: (root: string) => Promise<void> = async () => {}, options: Parameters<typeof openGlob>[3] = {}) {
  const untracked = Object.fromEntries([...Array.from({ length: 1200 }, (_, i) => [LONG_NAME(i), 'x']), ['empty.txt', '']]);
  const m = await makeRepo(t, { 'tracked.txt': 'tracked\n' }, untracked);
  await prepare(m.root);
  const repo = await openGlob(t, m.root, policyDoc(), options, m.track);
  return { m, repo };
}
async function drainStatus(repo: RepoWorkspace, first: { status: string; status_next_cursor: string | null }) {
  let text = first.status, cursor = first.status_next_cursor;
  while (cursor) { const page = await repo.statusPage(cursor); text += page.status; cursor = page.status_next_cursor; }
  return text;
}

test('status cursor goes stale when an intent-to-add entry becomes a staged add (listing is byte-identical)', async t => {
  const { m, repo } = await flagFixture(t, root => stage(root, 'add', '-N', '--', 'empty.txt'));
  const info = await repo.info();
  assert.ok(info.status_next_cursor, 'status spans pages');
  const before = await listing(m.root);
  assert.match(await statusOf(m.root, 'empty.txt'), / A empty\.txt/);
  await git(m.root, 'add', '--', 'empty.txt');
  assert.equal(await listing(m.root), before, 'the plain listing cannot tell the two states apart');
  assert.match(await statusOf(m.root, 'empty.txt'), /A {2}empty\.txt/);
  await assert.rejects(repo.statusPage(info.status_next_cursor!), /stale cursor/i);
});

test('status cursor goes stale when a staged add becomes intent-to-add (listing is byte-identical)', async t => {
  const { m, repo } = await flagFixture(t, root => stage(root, 'add', '--', 'empty.txt'));
  const info = await repo.info();
  assert.ok(info.status_next_cursor);
  const before = await listing(m.root);
  await git(m.root, 'rm', '-q', '--cached', '--', 'empty.txt');
  await git(m.root, 'add', '-N', '--', 'empty.txt');
  assert.equal(await listing(m.root), before);
  assert.match(await statusOf(m.root, 'empty.txt'), / A empty\.txt/);
  await assert.rejects(repo.statusPage(info.status_next_cursor!), /stale cursor/i);
});

test('status cursor goes stale when an untracked file becomes intent-to-add', async t => {
  const { m, repo } = await flagFixture(t);
  const info = await repo.info();
  assert.ok(info.status_next_cursor);
  await git(m.root, 'add', '-N', '--', 'empty.txt');
  await assert.rejects(repo.statusPage(info.status_next_cursor!), /stale cursor/i);
});

test('status cursor goes stale when skip-worktree or assume-unchanged is toggled (working file untouched)', async t => {
  for (const flag of ['skip-worktree', 'assume-unchanged']) {
    const { m, repo } = await flagFixture(t);
    const info = await repo.info();
    assert.ok(info.status_next_cursor);
    await git(m.root, 'update-index', `--${flag}`, '--', 'tracked.txt');
    await assert.rejects(repo.statusPage(info.status_next_cursor!), /stale cursor/i, flag);
    const again = await repo.info();
    await git(m.root, 'update-index', `--no-${flag}`, '--', 'tracked.txt');
    await assert.rejects(repo.statusPage(again.status_next_cursor!), /stale cursor/i, `no-${flag}`);
  }
});

test('a diff cursor goes stale when an intent-to-add entry with content changes state', async t => {
  const m = await makeRepo(t, { 'big.txt': bigContent('old') }, { 'n.txt': 'new file\n' });
  await git(m.root, 'add', '-N', '--', 'n.txt');
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);
  await writeFile(path.join(m.root, 'big.txt'), bigContent('new'));
  const first = await repo.diff();
  assert.equal(first.complete, false);
  await git(m.root, 'add', '--', 'n.txt');
  await assert.rejects(repo.diff('', first.next_cursor!), /stale cursor/i);
});

test('index rewrites that keep every entry and flag (stat data, index version) do not invalidate, intent-to-add present', async t => {
  const { m, repo } = await flagFixture(t, root => stage(root, 'add', '-N', '--', 'empty.txt'));
  const info = await repo.info();
  assert.ok(info.status_next_cursor);
  const indexBefore = await readFile(path.join(m.root, '.git/index'));
  await git(m.root, 'update-index', '--index-version', '4');
  await git(m.root, 'status', '--short');
  assert.ok(!indexBefore.equals(await readFile(path.join(m.root, '.git/index'))), 'the index file really was rewritten');
  assert.match(await statusOf(m.root, 'empty.txt'), / A empty\.txt/, 'intent-to-add survived the rewrite');
  assert.ok((await repo.statusPage(info.status_next_cursor!)).status.length > 0);
});

test('an intent-to-add change during status capture is never published; a persistent one fails explicitly', async t => {
  let calls = 0;
  let root = '';
  const { m, repo } = await flagFixture(t, r => stage(r, 'add', '-N', '--', 'empty.txt'), {
    captureHook: async hookStage => { if (hookStage === 'after-git' && calls++ === 0) await git(root, 'add', '--', 'empty.txt'); }
  });
  root = m.root;
  const info = await repo.info();
  assert.equal(calls, 2, 'the first capture was discarded and repeated');
  assert.equal(await drainStatus(repo, info), await statusOf(m.root), 'the published status shows the final index');
  // add and add -N alternate on every attempt, so the capture never settles.
  let n = 0;
  const churn = await openGlob(t, m.root, policyDoc(), {
    captureHook: async hookStage => {
      if (hookStage !== 'after-git') return;
      if (n++ % 2 === 0) { await git(m.root, 'rm', '-q', '--cached', '--', 'empty.txt'); await git(m.root, 'add', '-N', '--', 'empty.txt'); }
      else await git(m.root, 'add', '--', 'empty.txt');
    }
  }, m.track);
  await assert.rejects(churn.info(), /changed while/i);
  assert.deepEqual(await churn.captures.list(), [], 'nothing retained');
});
