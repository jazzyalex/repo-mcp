import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, readFile, realpath, chmod, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareFixture } from '../src/fixture.js';
import { RepoWorkspace, defaultPolicy, execute, type RepoPolicy, type RepoOptions } from '../src/repo.js';
import { executeToFile } from '../src/exec.js';
import { spawnSync } from 'node:child_process';
import { CaptureStore, removeOrphanedTempDirs, TEMP_PREFIX } from '../src/capture.js';
import { loadPolicy, policyDigest } from '../src/policy.js';
import { DEFAULT_LIMITS, type Limits } from '../src/limits.js';

// Milestone 2a: retained Git output. Git runs once per capture; pages come from stored bytes.

const PAGE = DEFAULT_LIMITS.page_bytes;
const bounded = (value: unknown) => assert.ok(Buffer.byteLength(JSON.stringify(value)) <= PAGE, `response ${Buffer.byteLength(JSON.stringify(value))} bytes`);
const git = async (cwd: string, ...args: string[]) => {
  const r = await execute('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], cwd, 60_000, {}, { maxOutputBytes: 256 * 1024 * 1024 });
  assert.equal(r.exit_code, 0, r.stderr);
  return r.stdout;
};

async function setup(t: { after(fn: () => Promise<void>): void }, untracked = 1500) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-capture-')));
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  const names = Array.from({ length: untracked }, (_, i) => `untracked-with-a-deliberately-long-file-name-${String(i).padStart(5, '0')}.txt`);
  for (const n of names) await writeFile(path.join(root, n), 'x');
  const open: RepoWorkspace[] = [];
  t.after(async () => { for (const r of open) await r.close(); await rm(base, { recursive: true, force: true }); });
  const policy: RepoPolicy = { ...defaultPolicy };
  const create = async (options: Pick<RepoOptions, 'operationBudgetMs' | 'monotonicClock' | 'captureHook'> & { limits?: Partial<Limits>; clock?: () => number; task?: string } = {}) => {
    const repo = await RepoWorkspace.create(root, policy, {
      limits: options.limits, clock: options.clock, operationBudgetMs: options.operationBudgetMs, monotonicClock: options.monotonicClock, captureHook: options.captureHook,
      ...(options.task ? { task: { stateDir: path.join(base, 'state'), taskId: options.task, policyDigest: policyDigest(loadPolicy(policy)) } } : {})
    });
    open.push(repo);
    return repo;
  };
  const expected = () => git(root, 'status', '--short', '--branch', '--untracked-files=all');
  return { base, root, create, expected };
}
const files = async (dir: string) => (await readdir(dir)).filter(f => !f.startsWith('.'));

async function drain(repo: RepoWorkspace, cursor: string | null) {
  let text = '';
  while (cursor) { const p = await repo.statusPage(cursor); bounded(p); text += p.status; cursor = p.status_next_cursor; }
  return text;
}

test('status pages come from one Git run: later changes outside the exposed files do not alter them', async t => {
  const { root, create, expected } = await setup(t);
  const snapshot = await expected();
  const repo = await create();
  const info = await repo.info();
  bounded(info);
  assert.equal(info.status_complete, false);
  assert.ok(info.status_next_cursor);
  await writeFile(path.join(root, 'appeared-later.txt'), 'x');
  assert.equal(info.status + await drain(repo, info.status_next_cursor), snapshot);
  assert.equal((await repo.captures.list()).length, 1);
});

test('a status that fits one page is not retained', async t => {
  const { create } = await setup(t, 3);
  const repo = await create();
  const info = await repo.info();
  assert.equal(info.status_complete, true);
  assert.equal(info.status_next_cursor, null);
  assert.deepEqual(await repo.captures.list(), []);
});

test('cursors are rejected explicitly when the exposed files, checkout or capture changes', async t => {
  const { root, create } = await setup(t);
  const repo = await create();
  const cursor = (await repo.info()).status_next_cursor!;
  // Another capture, same arguments: the cursor stays bound to its own capture.
  const second = (await repo.info()).status_next_cursor!;
  assert.notEqual(second, cursor);
  // Forged or mismatched cursors.
  const forged = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  await assert.rejects(repo.statusPage(Buffer.from(JSON.stringify({ ...forged, s: '0'.repeat(16) })).toString('base64url')), /invalid cursor/i);
  await assert.rejects(repo.statusPage(Buffer.from(JSON.stringify({ ...forged, c: 'not-a-capture' })).toString('base64url')), /invalid cursor/i);
  await assert.rejects(repo.statusPage(Buffer.from(JSON.stringify({ ...forged, k: 'diff' })).toString('base64url')), /invalid cursor/i);
  await assert.rejects(repo.statusPage(Buffer.from(JSON.stringify({ ...forged, o: 10 ** 9 })).toString('base64url')), /invalid cursor/i);
  await assert.rejects(repo.diff('', cursor), /invalid cursor/i, 'a status cursor is not a diff cursor');
  // The checkout moves.
  await git(root, 'commit', '--allow-empty', '-m', 'moved');
  await assert.rejects(repo.statusPage(cursor), /stale cursor/i);
});

test('a cursor from one task is not valid in another', async t => {
  const { create } = await setup(t);
  const a = await create({ task: 'task-a' });
  const cursor = (await a.info()).status_next_cursor!;
  await a.close();
  const b = await create({ task: 'task-b' });
  await assert.rejects(b.statusPage(cursor), /expired|unknown|evicted/i);
});

test('task captures survive a restart; untracked-mode captures do not', async t => {
  const { create, expected } = await setup(t);
  const first = await create({ task: 'restart' });
  const info = await first.info();
  const snapshot = await expected();
  await first.close();
  const second = await create({ task: 'restart' });
  assert.equal(info.status + await drain(second, info.status_next_cursor), snapshot, 'paging completes after restart');
  // Without task state the captures live in a per-process directory that is removed on close.
  const plain = await create();
  const plainCursor = (await plain.info()).status_next_cursor!;
  const dir = plain.captures.dir;
  await plain.close();
  assert.deepEqual(await readdir(path.dirname(dir)).then(l => l.filter(n => dir.endsWith(n))), []);
  const restarted = await create();
  await assert.rejects(restarted.statusPage(plainCursor), /expired|unknown|evicted|restart/i);
});

test('captures expire after the cursor lifetime and are swept', async t => {
  const { create } = await setup(t);
  let now = 1_000_000;
  const repo = await create({ task: 'ttl', limits: { cursor_ttl_hours: 1 }, clock: () => now });
  const cursor = (await repo.info()).status_next_cursor!;
  const dir = repo.captures.dir;
  assert.equal((await files(dir)).length, 2);
  now += 59 * 60_000;
  assert.ok((await repo.statusPage(cursor)).status.length > 0, 'still valid inside the lifetime');
  now += 2 * 60_000;
  await assert.rejects(repo.statusPage(cursor), /expired/i);
  assert.deepEqual(await files(dir), [], 'expired capture is deleted when used');
  // A capture that expires while nobody uses it is removed by the next server start.
  const again = (await repo.info()).status_next_cursor!;
  assert.ok(again);
  await repo.close();
  now += 2 * 3_600_000;
  const restarted = await create({ task: 'ttl', limits: { cursor_ttl_hours: 1 }, clock: () => now });
  assert.deepEqual(await files(restarted.captures.dir), []);
});

test('output over the capture limit is reported as an overflow and leaves nothing behind', async t => {
  const { create } = await setup(t);
  const repo = await create({ limits: { retained_output_bytes: 16 * 1024 } });
  await assert.rejects(repo.info(), /exceeded the 8 KiB capture limit/);
  assert.deepEqual(await files(repo.captures.dir), []);
});

test('the oldest captures are evicted to stay within the storage limit', async t => {
  const { create } = await setup(t, 700);
  // ~40 KiB per status; each capture is capped at 80 KiB, so five cannot all stay within 160 KiB.
  const repo = await create({ limits: { retained_output_bytes: 160 * 1024 } });
  const cursors: string[] = [];
  for (let i = 0; i < 5; i++) cursors.push((await repo.info()).status_next_cursor!);
  const kept = await repo.captures.list();
  assert.ok(kept.reduce((n, m) => n + m.bytes, 0) <= 160 * 1024, 'storage stays within retained_output_bytes');
  assert.ok(kept.length >= 1 && kept.length < 5, 'older captures were evicted');
  await assert.rejects(repo.statusPage(cursors[0]), /evicted|expired/i);
  assert.ok((await repo.statusPage(cursors[4])).status.length > 0, 'the newest capture is intact');
});

test('interrupted captures leave no valid capture and the next start removes the debris', async t => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-capdir-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = path.join(base, 'captures');
  const options = { limitBytes: 1024 * 1024, maxCaptureBytes: 64 * 1024, ttlMs: 3_600_000 };
  const store = await CaptureStore.open(dir, options);
  // Aborted before commit.
  const pending = await store.begin();
  await writeFile(pending.path, 'partial output');
  await pending.abort();
  assert.deepEqual(await files(dir), []);
  // A process that died mid-stream: partial file, a published file without its record, a record without its file.
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  await writeFile(path.join(dir, `${id(1)}.partial`), 'x');
  await writeFile(path.join(dir, `${id(2)}.out`), 'x');
  await writeFile(path.join(dir, `${id(3)}.json`), '{"version":1,"kind":"capture","data":{}}');
  await writeFile(path.join(dir, `${id(4)}.json`), 'not json');
  await writeFile(path.join(dir, '.tmp-leftover'), 'x');
  await CaptureStore.open(dir, options);
  assert.deepEqual(await files(dir), []);
  assert.deepEqual(await readdir(dir), []);
});

test('streaming stops at the cap, on timeout and on invalid UTF-8 without keeping the output in memory', async t => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-stream-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const run = (script: string, options: { maxBytes: number; timeout?: number }) => executeToFile(process.execPath, ['-e', script], base, path.join(base, `out-${Math.random()}`), options);
  const ok = await run('process.stdout.write("é".repeat(5000))', { maxBytes: 1_000_000 });
  assert.equal(ok.exit_code, 0);
  assert.equal(ok.bytes, 10_000);
  const over = await run('process.stdout.write("x".repeat(100000))', { maxBytes: 1000 });
  assert.equal(over.truncated, true);
  const slow = await run('process.stdout.write("x"); setTimeout(() => {}, 30000)', { maxBytes: 1000, timeout: 300 });
  assert.equal(slow.timed_out, true);
  const bad = await run('process.stdout.write(Buffer.from([0x61, 0xff]))', { maxBytes: 1000 });
  assert.equal(bad.invalid_utf8, true);
  const split = await run('process.stdout.write(Buffer.from([0x61, 0xe2, 0x82]))', { maxBytes: 1000 });
  assert.equal(split.invalid_utf8, true, 'a truncated final sequence is invalid');
  const multi = await run('const b = Buffer.from("€€€"); process.stdout.write(b.subarray(0, 4)); setTimeout(() => process.stdout.write(b.subarray(4)), 100)', { maxBytes: 1000 });
  assert.equal(multi.invalid_utf8, false, 'a sequence split across chunks is valid');
  // The stored bytes are exactly what the process wrote.
  const file = path.join(base, 'exact');
  await executeToFile(process.execPath, ['-e', 'process.stdout.write("line\\n".repeat(1000))'], base, file, { maxBytes: 1_000_000 });
  assert.equal(await readFile(file, 'utf8'), 'line\n'.repeat(1000));
});

test('a diff pages from its capture, including approved new files, and survives paging after a restart', async t => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-capdiff-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  const policy: RepoPolicy = { files: [...defaultPolicy.files, 'src/new.js'], editable: ['src/clamp.js', 'src/new.js'], creatable: ['src/new.js'], tests: ['test/clamp.test.js'] };
  const task = { stateDir: path.join(base, 'state'), taskId: 'diff', policyDigest: policyDigest(loadPolicy(policy)) };
  const first = await RepoWorkspace.create(root, policy, { task });
  const clamp = await first.readRange('src/clamp.js');
  await first.edit('src/clamp.js', 'export', '// ' + 'é'.repeat(30_000) + '\nexport', clamp.sha256);
  await first.createFile('src/new.js', 'export const added = 1;\n'.repeat(4000));
  let page = await first.diff();
  bounded(page);
  assert.equal(page.complete, false);
  assert.ok(page.total_bytes > 3 * PAGE);
  let text = page.diff;
  const cursor = page.next_cursor!;
  await first.close();
  const second = await RepoWorkspace.create(root, policy, { task });
  try {
    let next: string | null = cursor;
    while (next) { page = await second.diff('', next); bounded(page); text += page.diff; next = page.next_cursor; }
    assert.equal(Buffer.byteLength(text), page.total_bytes);
    assert.ok(text.includes('+export const added = 1;') && text.includes('+++ src/new.js'));
    await assert.rejects(second.diff('src/', cursor), /invalid cursor/i, 'cursor is bound to its prefix');
    await writeFile(path.join(root, 'src/new.js'), 'changed\n');
    await assert.rejects(second.diff('', cursor), /stale cursor/i);
  } finally { await second.close(); }
});

test('capture directories of dead processes are removed; live ones are kept', async t => {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-tmpdirs-')));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(tmp, `${TEMP_PREFIX}${dead.stdout.toString()}-abc123`));
  await mkdir(path.join(tmp, `${TEMP_PREFIX}${process.pid}-abc123`));
  await mkdir(path.join(tmp, 'unrelated'));
  await removeOrphanedTempDirs(tmp);
  assert.deepEqual((await readdir(tmp)).sort(), [`${TEMP_PREFIX}${process.pid}-abc123`, 'unrelated']);
});

// Review findings on retained captures.

async function diffFixture(t: { after(fn: () => Promise<void>): void }, options: Pick<RepoOptions, 'captureHook'> = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-capfix-')));
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  const policy: RepoPolicy = { files: [...defaultPolicy.files, 'src/new.js'], editable: ['src/clamp.js', 'src/new.js'], creatable: ['src/new.js'], tests: ['test/clamp.test.js'] };
  const repo = await RepoWorkspace.create(root, policy, options);
  t.after(async () => { await repo.close(); await rm(base, { recursive: true, force: true }); });
  return { root, repo };
}

test('a change made while a capture is generated is never published as a complete result', async t => {
  // The hook runs after Git has finished and before the capture is published: change the exposed file exactly there, once.
  let root = '', fired = false;
  const fixture = await diffFixture(t, { captureHook: async (stage, attempt) => {
    if (stage === 'after-git' && attempt === 0 && !fired) { fired = true; await appendFile(path.join(root, 'src/clamp.js'), '// late change\n'); }
  } });
  root = fixture.root;
  await appendFile(path.join(root, 'src/clamp.js'), '// early change\n');
  const outcome = await fixture.repo.diff().then(page => ({ page }), error => ({ error: error as Error }));
  assert.equal(fired, true, 'the change was injected after Git finished');
  if ('page' in outcome) {
    assert.equal(outcome.page.complete, true);
    assert.match(outcome.page.diff, /\+\/\/ late change/, 'a published capture reflects the files as they are');
  } else assert.match(outcome.error.message, /changed while/i);
});

test('a capture that keeps changing is discarded with an explicit error', async t => {
  let root = '', n = 0;
  const fixture = await diffFixture(t, { captureHook: async stage => { if (stage === 'after-git') await appendFile(path.join(root, 'src/clamp.js'), `// churn ${n++}\n`); } });
  root = fixture.root;
  await assert.rejects(fixture.repo.diff(), /changed while/i);
  assert.equal(n, 3, 'every attempt was discarded');
  assert.deepEqual(await fixture.repo.captures.list(), [], 'nothing is retained from discarded captures');
});

test('an executable-bit change invalidates a diff cursor', async t => {
  const { root, repo } = await diffFixture(t);
  const clamp = await repo.readRange('src/clamp.js');
  await repo.edit('src/clamp.js', 'export', '// ' + 'é'.repeat(40_000) + '\nexport', clamp.sha256);
  const page = await repo.diff();
  assert.equal(page.complete, false);
  await chmod(path.join(root, 'src/clamp.js'), 0o755);
  await assert.rejects(repo.diff('', page.next_cursor!), /stale cursor/i);
  const fresh = await repo.diff();
  assert.match(fresh.diff, /old mode 100644\nnew mode 100755/);
});

test('capture retries share one operation deadline and cannot reset it', async t => {
  const { root, create } = await setup(t);
  let now = 0;
  const attempts: number[] = [];
  const repo = await create({
    operationBudgetMs: 1000, monotonicClock: () => now,
    captureHook: async (stage, attempt) => {
      if (stage !== 'after-git') return;
      attempts.push(attempt);
      now += 500; // each attempt "takes" 500 ms
      await writeFile(path.join(root, 'src/clamp.js'), `// drift ${attempt}\n`); // an exposed file moves: the capture must be retried
    }
  });
  await assert.rejects(repo.info(), /timed out.*1000 ms operation budget/i);
  assert.deepEqual(attempts, [0, 1], 'no further attempt starts once the budget is spent');
  assert.deepEqual(await files(repo.captures.dir), [], 'the pending capture is discarded');
});

test('Git runs with the time that is left, not a fresh timeout', async t => {
  const { create } = await setup(t);
  let now = 0;
  const stages: string[] = [];
  const repo = await create({
    operationBudgetMs: 1000, monotonicClock: () => now,
    captureHook: (stage) => { stages.push(stage); if (stage === 'before-git') now = 999; } // 1 ms remains when Git starts
  });
  await assert.rejects(repo.info(), /timed out.*operation budget/i);
  assert.deepEqual(stages, ['before-git'], 'Git was killed at the deadline');
  assert.deepEqual(await files(repo.captures.dir), []);
});

test('a spent budget stops the capture before Git runs', async t => {
  const { create } = await setup(t);
  const stages: string[] = [];
  const repo = await create({ operationBudgetMs: 0, captureHook: stage => { stages.push(stage); } });
  await assert.rejects(repo.info(), /timed out.*0 ms operation budget/i);
  assert.deepEqual(stages, []);
  await assert.rejects(repo.diff(), /timed out.*operation budget/i);
  assert.deepEqual(await files(repo.captures.dir), []);
});

test('identity checks and Git bookkeeping calls honour the deadline too', async t => {
  const { root } = await setup(t, 3);
  const { resolveIdentity } = await import('../src/identity.js');
  await assert.rejects(resolveIdentity(root, { timeout: () => 1 }), /timed out/i);
  assert.equal((await resolveIdentity(root, { timeout: () => 10_000 })).root, root);
});
