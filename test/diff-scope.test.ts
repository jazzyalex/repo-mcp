import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { RepoWorkspace, defaultPolicy } from '../src/repo.js';
import { batchPaths } from '../src/git-batches.js';
import { makeRepo, openGlob, policyDoc, git } from './helpers.js';

// Milestone 2b: Git diff scope. Real Git throughout; Git 2.50's `diff` and `ls-files` take no --pathspec-from-file.

async function fullDiff(repo: RepoWorkspace, prefix = '', baseRef?: string, headRef?: string) {
  let page = await repo.diff(prefix, undefined, baseRef, headRef);
  let text = page.diff;
  while (page.next_cursor) { page = await repo.diff(prefix, page.next_cursor, baseRef, headRef); text += page.diff; }
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

test('an explicit base_ref exposes committed changes from an otherwise clean checkout', async t => {
  const m = await makeRepo(t, { 'src/value.js': 'export const value = 1;\n' });
  await writeFile(path.join(m.root, 'src/value.js'), 'export const value = 2;\n');
  await git(m.root, 'add', 'src/value.js');
  await git(m.root, 'commit', '-m', 'change value');
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);

  assert.equal((await repo.diff()).diff, '', 'the default working-tree diff stays empty');
  const first = await repo.diff('', undefined, 'HEAD^');
  assert.equal(first.base_ref, 'HEAD^');
  assert.match(first.base_commit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  assert.match(first.diff, /-export const value = 1;[\s\S]*\+export const value = 2;/);
  assert.equal(await fullDiff(repo, '', 'HEAD^'), await git(m.root, 'diff', 'HEAD^'));
  await assert.rejects(repo.diff('', undefined, '--output=/tmp/no'), /invalid base_ref/i);
  await assert.rejects(repo.diff('', undefined, 'missing-ref'), /unknown or non-commit base_ref/i);
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

test('commit-pinned diff and read use Git objects only, ignoring staged, worktree and untracked state', async t => {
  const file = 'src/pinned.txt';
  const m = await makeRepo(t, { [file]: 'one\n' });
  const base = (await git(m.root, 'rev-parse', 'HEAD')).trim();
  await writeFile(path.join(m.root, file), 'two\n');
  await git(m.root, 'add', '--', file);
  await git(m.root, 'commit', '-m', 'pinned head');
  const head = (await git(m.root, 'rev-parse', 'HEAD')).trim();

  await writeFile(path.join(m.root, file), 'staged-only\n');
  await git(m.root, 'add', '--', file);
  await writeFile(path.join(m.root, file), 'worktree-only\n');
  await writeFile(path.join(m.root, 'src/untracked.txt'), 'untracked\n');

  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);
  const text = await fullDiff(repo, '', base, head);
  assert.match(text, /-one/);
  assert.match(text, /\+two/);
  assert.ok(!text.includes('staged-only'));
  assert.ok(!text.includes('worktree-only'));
  assert.ok(!text.includes('untracked'));

  const pinned = await repo.readRange(file, 1, 200, undefined, head);
  assert.equal(pinned.content, 'two\n');
  assert.equal(pinned.commit, head);
  assert.match(pinned.git_blob_id, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  assert.match(pinned.raw_sha256, /^[a-f0-9]{64}$/);
});

test('commit-pinned reads and diffs enforce policy, conservative refs and cursor argument identity', async t => {
  const large = 'src/large.txt';
  const m = await makeRepo(t, {
    [large]: 'old\n'.repeat(6000),
    'secret/hidden.txt': 'secret\n'
  });
  const base = (await git(m.root, 'rev-parse', 'HEAD')).trim();
  await writeFile(path.join(m.root, large), 'new\n'.repeat(6000));
  await git(m.root, 'add', '--', large);
  await git(m.root, 'commit', '-m', 'large pinned head');
  const head = (await git(m.root, 'rev-parse', 'HEAD')).trim();
  const repo = await openGlob(t, m.root, policyDoc({
    read: { include: ['**'], exclude: ['secret/**'] }
  }), {}, m.track);

  await assert.rejects(repo.readRange('secret/hidden.txt', 1, 1, undefined, head), /not exposed/i);
  await assert.rejects(repo.readRange(large, 1, 1, undefined, '--output=/tmp/no'), /invalid ref/i);
  await assert.rejects(repo.diff('', undefined, base, '--output=/tmp/no'), /invalid head_ref/i);

  const readFirst = await repo.readRange(large, 1, 1, undefined, head);
  assert.ok(readFirst.next_cursor);
  await assert.rejects(
    repo.readRange(large, 1, 1, readFirst.next_cursor!, base),
    /cursor.*arguments|invalid cursor/i
  );

  const diffFirst = await repo.diff('', undefined, base, head);
  assert.ok(diffFirst.next_cursor);
  await assert.rejects(
    repo.diff('', diffFirst.next_cursor!, base, base),
    /cursor.*arguments|invalid cursor/i
  );
});

test('commit-pinned path reads and patches treat Git pathspec-looking filenames literally', async t => {
  const magic = ':(glob)*.txt';
  const m = await makeRepo(t, {
    [magic]: 'magic old\n',
    'secret.txt': 'secret old\n'
  });
  const base = (await git(m.root, 'rev-parse', 'HEAD')).trim();
  await writeFile(path.join(m.root, magic), 'magic new\n');
  await writeFile(path.join(m.root, 'secret.txt'), 'secret new\n');
  await git(m.root, '--literal-pathspecs', 'add', '--', magic, 'secret.txt');
  await git(m.root, 'commit', '-m', 'pathspec-looking filename');
  const head = (await git(m.root, 'rev-parse', 'HEAD')).trim();
  const repo = await openGlob(t, m.root, policyDoc({
    read: { include: ['**'], exclude: ['secret.txt'] }
  }), {}, m.track);

  const text = await fullDiff(repo, '', base, head);
  assert.match(text, /magic old[\s\S]*magic new/);
  assert.ok(!text.includes('secret.txt'));
  assert.ok(!text.includes('secret new'));

  const read = await repo.readRange(magic, 1, 10, undefined, head);
  assert.equal(read.content, 'magic new\n');
  assert.equal(read.commit, head);
});

test('committed symlink metadata fails closed when it cannot fit page_bytes', async t => {
  const m = await makeRepo(t);
  const payload = 'x'.repeat(64 * 1024);
  const payloadPath = path.join(m.root, 'long-link-payload.txt');
  await writeFile(payloadPath, payload);
  const oid = (await git(m.root, 'hash-object', '-w', '--', 'long-link-payload.txt')).trim();
  await git(m.root, 'update-index', '--add', '--cacheinfo', `120000,${oid},src/long-link`);
  await git(m.root, 'commit', '-m', 'long committed symlink metadata');
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);

  await assert.rejects(
    repo.readRange('src/long-link', 1, 1, undefined, 'HEAD'),
    error => {
      assert.match(String(error), /committed read response exceeds.*page_bytes budget/i);
      assert.ok(Buffer.byteLength(String(error)) < 512, 'overflow failure stays small and explicit');
      return true;
    }
  );
});

test('commit-pinned read and diff ignore Git replacement refs', async t => {
  const file = 'src/replaced.txt';
  const m = await makeRepo(t, { [file]: 'base-newline\n' });
  const base = (await git(m.root, 'rev-parse', 'HEAD')).trim();
  await writeFile(path.join(m.root, file), 'head-newline\n');
  await git(m.root, 'add', '--', file);
  await git(m.root, 'commit', '-m', 'pinned replacement head');
  const head = (await git(m.root, 'rev-parse', 'HEAD')).trim();

  const replacementCommit = async (content: string, label: string) => {
    await git(m.root, 'reset', '--hard', base);
    await writeFile(path.join(m.root, file), content);
    await git(m.root, 'add', '--', file);
    await git(m.root, 'commit', '-m', label);
    const commit = (await git(m.root, 'rev-parse', 'HEAD')).trim();
    await git(m.root, 'reset', '--hard', head);
    return commit;
  };
  const replacementOne = await replacementCommit('replacement-one-newline\n', 'replacement one');
  const replacementTwo = await replacementCommit('replacement-two-newline\n', 'replacement two');

  await git(m.root, 'replace', head, replacementOne);
  assert.equal(await git(m.root, 'show', `${head}:${file}`), 'replacement-one-newline\n', 'fixture replacement must affect ordinary Git');
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);

  const firstRead = await repo.readRange(file, 1, 10, undefined, head);
  assert.equal(firstRead.commit, head);
  assert.equal(firstRead.content, 'head-newline\n');
  const firstDiff = await fullDiff(repo, '', base, head);
  assert.match(firstDiff, /-base-newline[\s\S]*\+head-newline/);
  assert.doesNotMatch(firstDiff, /replacement-one-newline/);

  await git(m.root, 'replace', '-f', head, replacementTwo);
  assert.equal(await git(m.root, 'show', `${head}:${file}`), 'replacement-two-newline\n', 'fixture replacement must change for ordinary Git');
  const secondRead = await repo.readRange(file, 1, 10, undefined, head);
  assert.equal(secondRead.content, 'head-newline\n');
  const secondDiff = await fullDiff(repo, '', base, head);
  assert.equal(secondDiff, firstDiff, 'replacement-ref changes must not alter pinned evidence');
});

test('commit-pinned proven-text patches ignore dirty and info attributes that mark the path binary', async t => {
  const file = 'src/a.txt';
  const m = await makeRepo(t, { [file]: 'base-text\n' });
  const base = (await git(m.root, 'rev-parse', 'HEAD')).trim();
  await writeFile(path.join(m.root, file), 'head-text\n');
  await git(m.root, 'add', '--', file);
  await git(m.root, 'commit', '-m', 'text head');
  const head = (await git(m.root, 'rev-parse', 'HEAD')).trim();

  await writeFile(path.join(m.root, '.gitattributes'), `${file} -diff\n`);
  await mkdir(path.join(m.root, '.git', 'info'), { recursive: true });
  await writeFile(path.join(m.root, '.git', 'info', 'attributes'), `${file} -diff\n`);

  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);
  const text = await fullDiff(repo, '', base, head);
  assert.match(text, /-base-text[\s\S]*\+head-text/);
  assert.doesNotMatch(text, /Binary files .* differ/);
});

test('committed binary changes expose immutable identity and explicit semantic-review limits', async t => {
  const file = 'src/blob.bin';
  const m = await makeRepo(t, { [file]: '\0\u0001\u0002\u0003' });
  const base = (await git(m.root, 'rev-parse', 'HEAD')).trim();
  await writeFile(path.join(m.root, file), Buffer.from([0, 9, 2, 3]));
  await git(m.root, 'add', '--', file);
  await git(m.root, 'commit', '-m', 'binary pinned head');
  const head = (await git(m.root, 'rev-parse', 'HEAD')).trim();
  const repo = await openGlob(t, m.root, policyDoc(), {}, m.track);

  const diff = await repo.diff('', undefined, base, head);
  assert.match(diff.capture_sha256, /^[a-f0-9]{64}$/);
  assert.match(diff.diff, /committed binary\/non-text change; semantic text review is unsupported/i);
  assert.match(diff.diff, /old mode=100644 blob=(?:[a-f0-9]{40}|[a-f0-9]{64}) size=4/);
  assert.match(diff.diff, /new mode=100644 blob=(?:[a-f0-9]{40}|[a-f0-9]{64}) size=4/);
  assert.ok(diff.review_limitations.some((line: string) => /identity-only/i.test(line)));

  const read = await repo.readRange(file, 1, 10, undefined, head);
  assert.equal(read.text_supported, false);
  if (read.text_supported) assert.fail('binary committed read unexpectedly reported text support');
  assert.match(read.git_blob_id, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  assert.match(read.raw_sha256, /^[a-f0-9]{64}$/);
  assert.match(read.unsupported_reason, /NUL|semantic text review is unsupported/i);
});
