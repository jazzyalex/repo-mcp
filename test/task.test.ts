import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareFixture } from '../src/fixture.js';
import { RepoWorkspace, defaultPolicy, execute, sha256, type RepoPolicy } from '../src/repo.js';
import { loadPolicy, policyDigest } from '../src/policy.js';
import { StateStore } from '../src/task-state.js';
import { setTaskPhase, rebindTask, TaskContext } from '../src/task.js';

const git = async (cwd: string, ...args: string[]) => {
  const r = await execute('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], cwd);
  assert.equal(r.exit_code, 0, r.stderr);
  return r.stdout.trim();
};
const creatable: RepoPolicy = { files: [...defaultPolicy.files, 'src/new.js'], editable: ['src/clamp.js', 'src/new.js'], creatable: ['src/new.js'], tests: ['test/clamp.test.js'] };

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-task-')));
  const root = path.join(base, 'repo');
  await prepareFixture(root);
  const stateDir = path.join(base, 'state');
  const open: RepoWorkspace[] = [];
  t.after(async () => { for (const r of open) await r.close(); await rm(base, { recursive: true, force: true }); });
  const create = async (checkout = root, taskId = 't1', policy: RepoPolicy = creatable, extra: Record<string, unknown> = {}) => {
    const repo = await RepoWorkspace.create(checkout, policy, { task: { stateDir, taskId, policyDigest: policyDigest(loadPolicy(policy)), ...extra } });
    open.push(repo);
    return repo;
  };
  return { base, root, stateDir, create };
}

test('standalone checkout binds identity and reports it', async t => {
  const { root, create } = await setup(t);
  const repo = await create();
  const info = await repo.info();
  assert.equal(info.identity.root, root);
  assert.equal(info.identity.branch, 'mcp-trial');
  assert.equal(info.identity.detached, false);
  assert.equal(info.identity.linked_worktree, false);
  assert.equal(info.identity.common_dir, path.join(root, '.git'));
  assert.equal(info.task?.task_id, 't1');
  assert.equal(info.task?.phase, 'coding');
});

test('linked worktree is accepted and edits stay in the selected checkout', async t => {
  const { base, root, create } = await setup(t);
  const wt = path.join(base, 'wt');
  await git(root, 'worktree', 'add', '-b', 'task-wt', wt);
  const repo = await create(wt);
  const info = await repo.info();
  assert.equal(info.identity.linked_worktree, true);
  assert.equal(info.identity.branch, 'task-wt');
  assert.equal(info.identity.common_dir, path.join(root, '.git'));
  const source = await repo.read('src/clamp.js');
  await repo.edit(source.path, 'max - 1', 'max', source.sha256);
  assert.doesNotMatch(await readFile(path.join(wt, 'src/clamp.js'), 'utf8'), /max - 1/);
  assert.match(await readFile(path.join(root, 'src/clamp.js'), 'utf8'), /max - 1/);
  assert.equal(await git(root, 'status', '--porcelain'), '', 'main checkout untouched');
  assert.match((await repo.diff()).diff, /-  return Math.min\(Math.max\(value, min\), max - 1\);/);
});

test('bare repositories and non-root directories are rejected', async t => {
  const { base, root, create } = await setup(t);
  await git(base, 'init', '--bare', 'bare.git');
  await assert.rejects(create(path.join(base, 'bare.git')), /bare/i);
  await assert.rejects(create(path.join(root, 'src')), /Git root does not match/);
});

test('detached HEAD requires explicit opt-in and HEAD movement blocks mutation', async t => {
  const { root, create } = await setup(t);
  const first = await git(root, 'rev-parse', 'HEAD');
  await git(root, 'commit', '--allow-empty', '-m', 'second');
  await git(root, 'checkout', '--detach', first);
  await assert.rejects(create(), /detached HEAD/i);
  const repo = await create(root, 't1', creatable, { allowDetached: true });
  const info = await repo.info();
  assert.equal(info.identity.detached, true);
  assert.equal(info.identity.branch, null);
  assert.equal(info.identity.head, first);
  const source = await repo.read('src/clamp.js');
  await git(root, 'checkout', '--detach', 'mcp-trial');
  await assert.rejects(repo.edit(source.path, 'max - 1', 'max', source.sha256), /HEAD changed/);
  assert.equal((await repo.read('src/clamp.js')).sha256, source.sha256);
});

test('branch or HEAD changes block mutations and checks until the coordinator rebinds', async t => {
  const { root, stateDir, create } = await setup(t);
  let repo = await create();
  const source = await repo.read('src/clamp.js');
  await git(root, 'checkout', '-b', 'elsewhere');
  await assert.rejects(repo.edit(source.path, 'max - 1', 'max', source.sha256), /branch changed/);
  await assert.rejects(repo.test(), /branch changed/);
  await assert.rejects(repo.createFile('src/new.js', 'x\n'), /branch changed/);
  assert.equal((await repo.read('src/clamp.js')).sha256, source.sha256, 'reads still work');
  await repo.close();
  await assert.rejects(create(), /branch changed/, 'restart does not silently rebind');
  await git(root, 'checkout', 'mcp-trial');
  await git(root, 'commit', '--allow-empty', '-m', 'moved');
  await assert.rejects(create(), /HEAD changed/);
  await rebindTask(stateDir, 't1', root);
  repo = await create();
  await repo.edit(source.path, 'max - 1', 'max', source.sha256);
});

test('duplicate writers, wrong checkout and changed policy fail clearly', async t => {
  const { base, root, create } = await setup(t);
  const first = await create();
  await assert.rejects(create(root, 't2'), /already owned by live process/);
  await first.close();
  const second = await create(root, 't2');
  await second.close();
  const other = path.join(base, 'other');
  await prepareFixture(other);
  await assert.rejects(create(other, 't1'), /bound to a different checkout/);
  await assert.rejects(create(root, 't1', { ...creatable, editable: [...creatable.editable, 'README.md'] }), /policy changed/);
  await assert.rejects(create(root, '../escape'), /task id/i);
});

test('failed binding releases the checkout lock', async t => {
  const { root, create } = await setup(t);
  await (await create()).close();
  await git(root, 'checkout', '-b', 'elsewhere');
  await assert.rejects(create(), /branch changed/);
  await (await create(root, 't2')).close();
});

test('valid Stage 1 marker preserves drift-specific reopen errors and releases ownership on failure', async t => {
  const { root, stateDir, create } = await setup(t);
  await (await create()).close();
  const store = await StateStore.open(stateDir);
  assert.ok(await store.read('tasks/t1/protocol.json', 'task-protocol'));
  await git(root, 'checkout', '-b', 'marker-drift');
  await assert.rejects(create(), /branch changed/);
  await (await create(root, 't2')).close();
});

test('persisted review phase freezes all MCP mutations but not reads or checks', async t => {
  const { root, stateDir, create } = await setup(t);
  const repo = await create();
  const source = await repo.read('src/clamp.js');
  await setTaskPhase(stateDir, 't1', 'review');
  assert.equal((await repo.info()).task?.phase, 'review');
  await assert.rejects(repo.edit(source.path, 'max - 1', 'max', source.sha256), /review phase/);
  await assert.rejects(repo.createFile('src/new.js', 'x\n'), /review phase/);
  assert.equal((await repo.test()).exit_code, 1);
  assert.match((await repo.search('clamp')).matches[0].text, /clamp/);
  await repo.close();
  const restarted = await create();
  assert.equal((await restarted.info()).task?.phase, 'review', 'phase survives restart');
  await setTaskPhase(stateDir, 't1', 'coding');
  await restarted.edit(source.path, 'max - 1', 'max', source.sha256);
  await assert.rejects(setTaskPhase(stateDir, 't1', 'bogus' as 'review'), /phase/);
  await assert.rejects(setTaskPhase(stateDir, 'missing', 'review'), /not bound/);
  assert.match(await readFile(path.join(root, 'src/clamp.js'), 'utf8'), /max\);/);
});

test('external editor changes are detected by hash, not blocked by the lock', async t => {
  const { root, create } = await setup(t);
  const repo = await create();
  const source = await repo.read('src/clamp.js');
  await writeFile(path.join(root, 'src/clamp.js'), source.content + '// external\n');
  await assert.rejects(repo.edit(source.path, 'max - 1', 'max', source.sha256), /Stale/);
});

test('retrying an edit with the same request ID returns the recorded outcome without reapplying', async t => {
  const { create } = await setup(t);
  let repo = await create();
  const source = await repo.read('src/clamp.js');
  const first = await repo.edit(source.path, 'max - 1', 'max', source.sha256, 'req-edit-1');
  const retry = await repo.edit(source.path, 'max - 1', 'max', source.sha256, 'req-edit-1');
  assert.equal(retry.already_applied, true);
  assert.equal(retry.after_sha256, first.after_sha256);
  assert.equal((await repo.read(source.path)).sha256, first.after_sha256);
  await repo.close();
  repo = await create();
  assert.equal((await repo.edit(source.path, 'max - 1', 'max', source.sha256, 'req-edit-1')).already_applied, true, 'durable across restart');
  await assert.rejects(repo.edit(source.path, 'max - 1', 'max + 0', source.sha256, 'req-edit-1'), /different arguments/);
});

test('retry after a later change reports conflict instead of success or replay', async t => {
  const { create } = await setup(t);
  const repo = await create();
  const source = await repo.read('src/clamp.js');
  const first = await repo.edit(source.path, 'max - 1', 'max', source.sha256, 'req-a');
  await repo.edit(source.path, 'RangeError', 'TypeError', first.after_sha256, 'req-b');
  await assert.rejects(repo.edit(source.path, 'max - 1', 'max', source.sha256, 'req-a'), /changed since/);
});

test('failed requests are recorded and not silently retried under the same ID', async t => {
  const { create } = await setup(t);
  const repo = await create();
  const source = await repo.read('src/clamp.js');
  await assert.rejects(repo.edit(source.path, 'max - 1', 'max', '0'.repeat(64), 'req-fail'), /Stale/);
  await assert.rejects(repo.edit(source.path, 'max - 1', 'max', '0'.repeat(64), 'req-fail'), /previously failed.*Stale/s);
  assert.equal((await repo.read(source.path)).sha256, source.sha256);
});

test('create_file retry is idempotent by request ID', async t => {
  const { create } = await setup(t);
  const repo = await create();
  const made = await repo.createFile('src/new.js', 'export const x = 1;\n', 'req-create');
  const again = await repo.createFile('src/new.js', 'export const x = 1;\n', 'req-create');
  assert.equal(again.already_applied, true);
  assert.equal(again.after_sha256, made.after_sha256);
  await assert.rejects(repo.createFile('src/new.js', 'export const x = 1;\n', 'req-other'), /already exists/);
});

test('recorded intent is reconciled against observed hashes after a crash', async t => {
  const { root, stateDir, create } = await setup(t);
  const repo = await create();
  const source = await repo.read('src/clamp.js');
  const fixed = source.content.replace('max - 1', 'max');
  const task = (repo as unknown as { task: TaskContext }).task;
  const digest = TaskContext.argsDigest('edit', [source.path, 'max - 1', 'max', source.sha256]);
  // Crash after intent, before write: the retry applies exactly once.
  await task.recordIntent('req-crash-before', digest, 'edit', source.path, source.sha256, sha256(fixed));
  const applied = await repo.edit(source.path, 'max - 1', 'max', source.sha256, 'req-crash-before');
  assert.equal(applied.already_applied, undefined);
  assert.equal((await repo.read(source.path)).content, fixed);
  // Crash after write, before completion record: report already_applied.
  const store = await StateStore.open(stateDir);
  const digest2 = TaskContext.argsDigest('edit', [source.path, 'RangeError', 'TypeError', sha256(fixed)]);
  const changed = fixed.replace('RangeError', 'TypeError');
  await task.recordIntent('req-crash-after', digest2, 'edit', source.path, sha256(fixed), sha256(changed));
  await writeFile(path.join(root, source.path), changed);
  const reconciled = await repo.edit(source.path, 'RangeError', 'TypeError', sha256(fixed), 'req-crash-after');
  assert.equal(reconciled.already_applied, true);
  assert.equal(reconciled.after_sha256, sha256(changed));
  // Neither before nor after: uncertain, never replayed.
  const digest3 = TaskContext.argsDigest('edit', [source.path, 'min', 'lo', sha256(changed)]);
  await task.recordIntent('req-uncertain', digest3, 'edit', source.path, sha256(changed), sha256('whatever'));
  await writeFile(path.join(root, source.path), changed + '// someone else\n');
  await assert.rejects(repo.edit(source.path, 'min', 'lo', sha256(changed), 'req-uncertain'), /uncertain/);
  assert.ok(store);
});

test('request IDs require task state and a valid format', async t => {
  const { root, create } = await setup(t);
  const plain = await RepoWorkspace.create(root, creatable);
  const source = await plain.read('src/clamp.js');
  await assert.rejects(plain.edit(source.path, 'max - 1', 'max', source.sha256, 'req-1'), /task state/);
  const repo = await create();
  await assert.rejects(repo.edit(source.path, 'max - 1', 'max', source.sha256, 'bad id!'), /request_id/);
});

test('coordinator CLI reports status, changes phase and rebinds', async t => {
  const { root, stateDir, create } = await setup(t);
  const repo = await create();
  const run = (...args: string[]) => execute(process.execPath, ['--import', 'tsx', 'scripts/task.ts', ...args, '--task', 't1', '--state-dir', stateDir], process.cwd(), 20_000, { PATH: process.env.PATH ?? '' });
  const status = await run('status');
  assert.equal(status.exit_code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).phase, 'coding');
  assert.equal((await run('phase', '--phase', 'review')).exit_code, 0);
  assert.equal((await repo.info()).task?.phase, 'review');
  const bad = await run('phase', '--phase', 'nope');
  assert.equal(bad.exit_code, 1);
  assert.match(bad.stderr, /Invalid task phase/);
  await git(root, 'commit', '--allow-empty', '-m', 'coordinator commit');
  const rebound = await run('rebind', '--root', root);
  assert.equal(rebound.exit_code, 0, rebound.stderr);
  assert.equal(JSON.parse(rebound.stdout).head, await git(root, 'rev-parse', 'HEAD'));
});

test('compatibility rebind compiles a proposed policy before publishing any task state', async t => {
  const { base, root, stateDir, create } = await setup(t);
  await create();
  const store = await StateStore.open(stateDir);
  const beforeBinding = await store.read('tasks/t1/binding.json', 'binding');
  const beforeProtocol = await store.read('tasks/t1/protocol.json', 'task-protocol');
  const beforePhase = await store.read('tasks/t1/phase.json', 'phase');
  const activeSentinel = { generation: 17, marker: 'must-not-change' };
  await store.write('control/active-service.json', 'active-service', activeSentinel);

  const invalid = loadPolicy(creatable);
  invalid.checks = [{ id: 'named-check', path: 'test/clamp.test.js' }];
  const invalidPolicy = path.join(base, 'compile-invalid-policy.json');
  await writeFile(invalidPolicy, JSON.stringify(invalid));
  const run = (...args: string[]) => execute(
    process.execPath,
    ['--import', 'tsx', 'scripts/task.ts', ...args, '--task', 't1', '--state-dir', stateDir],
    process.cwd(),
    20_000,
    { PATH: process.env.PATH ?? '' }
  );
  const result = await run('rebind', '--root', root, '--policy', invalidPolicy);
  assert.equal(result.exit_code, 1);
  assert.match(result.stderr, /named check|check id|not supported/i);
  assert.deepEqual(await store.read('tasks/t1/binding.json', 'binding'), beforeBinding);
  assert.deepEqual(await store.read('tasks/t1/protocol.json', 'task-protocol'), beforeProtocol);
  assert.deepEqual(await store.read('tasks/t1/phase.json', 'phase'), beforePhase);
  assert.deepEqual(await store.read('control/active-service.json', 'active-service'), activeSentinel);
});

// Review findings (milestone 1 NO-SHIP), reproduced as regressions.

const pauseRead = (repo: RepoWorkspace, file: string) => {
  const original = repo.read.bind(repo);
  let reached!: () => void, resume!: () => void;
  const atPause = new Promise<void>(r => { reached = r; });
  const go = new Promise<void>(r => { resume = r; });
  let once = true;
  repo.read = (async (f: string) => { const v = await original(f); if (f === file && once) { once = false; reached(); await go; } return v; }) as typeof repo.read;
  return { atPause, resume };
};

test('review freeze waits for an in-flight edit and is acknowledged only after it drains', async t => {
  const { stateDir, create } = await setup(t);
  const repo = await create();
  const source = await repo.read('src/clamp.js');
  const pause = pauseRead(repo, 'src/clamp.js');
  const order: string[] = [];
  const edit = repo.edit(source.path, 'max - 1', 'max', source.sha256, 'freeze-edit').then(() => order.push('edit'));
  await pause.atPause;
  const freeze = setTaskPhase(stateDir, 't1', 'review').then(() => order.push('freeze'));
  await new Promise(r => setTimeout(r, 150));
  assert.deepEqual(order, [], 'freeze must not be acknowledged while the edit is running');
  pause.resume();
  await Promise.all([edit, freeze]);
  assert.deepEqual(order, ['edit', 'freeze']);
  const after = await repo.read('src/clamp.js');
  await assert.rejects(repo.edit(after.path, 'RangeError', 'TypeError', after.sha256), /review phase/);
});

test('policy rebind blocks the running server until it reloads the validated policy', async t => {
  const { root, stateDir, create } = await setup(t);
  const repo = await create();
  const readOnly: RepoPolicy = { ...defaultPolicy, editable: [] };
  await rebindTask(stateDir, 't1', root, { policyDigest: policyDigest(loadPolicy(readOnly)) });
  const source = await (await RepoWorkspace.create(root, creatable)).read('src/clamp.js');
  await assert.rejects(repo.edit(source.path, 'max - 1', 'max', source.sha256), /policy changed/);
  await assert.rejects(repo.createFile('src/new.js', 'x\n'), /policy changed/);
  await assert.rejects(repo.test(), /policy changed/);
  await assert.rejects(repo.readRange('src/clamp.js'), /policy changed/);
  await assert.rejects(repo.search('clamp'), /policy changed/);
  await assert.rejects(repo.diff(), /policy changed/);
  await assert.rejects(repo.info(), /policy changed/);
  assert.equal((await (await RepoWorkspace.create(root, creatable)).read('src/clamp.js')).sha256, source.sha256);
  await repo.close();
  const reloaded = await create(root, 't1', readOnly);
  await assert.rejects(reloaded.edit(source.path, 'max - 1', 'max', source.sha256), /not editable/);
});

test('rebind keeps the Stage 1 adoption marker immutable while mutable binding policy advances', async t => {
  const { root, stateDir, create } = await setup(t);
  await (await create()).close();
  const store = await StateStore.open(stateDir);
  const protocolBefore = await store.read('tasks/t1/protocol.json', 'task-protocol');
  const readOnly: RepoPolicy = { ...defaultPolicy, editable: [] };
  const digest = policyDigest(loadPolicy(readOnly));
  await rebindTask(stateDir, 't1', root, { policyDigest: digest });
  const binding = await store.read<{ policy_digest: string }>('tasks/t1/binding.json', 'binding');
  const protocolAfter = await store.read<{ protocol: string }>('tasks/t1/protocol.json', 'task-protocol');
  assert.equal(binding?.policy_digest, digest);
  assert.equal(protocolAfter?.protocol, 'v1-stage1');
  assert.deepEqual(protocolAfter, protocolBefore);
  await (await create(root, 't1', readOnly)).close();
});

test('rejected creation stays failed on retry even when contents match', async t => {
  const { root, create } = await setup(t);
  const repo = await create();
  await writeFile(path.join(root, 'src/new.js'), 'existing\n');
  await assert.rejects(repo.createFile('src/new.js', 'existing\n', 'dup-create'), /already exists/);
  await assert.rejects(repo.createFile('src/new.js', 'existing\n', 'dup-create'), /previously failed.*already exists/s);
});

test('edit that detects a concurrent change before publish is recorded as failed', async t => {
  const { root, create } = await setup(t);
  const repo = await create();
  const source = await repo.read('src/clamp.js');
  const original = repo.read.bind(repo);
  let calls = 0;
  // The second read of the file is the pre-rename recheck; change the file just before it.
  repo.read = (async (f: string) => { if (f === source.path && ++calls === 2) await writeFile(path.join(root, f), source.content + '// racing writer\n'); return original(f); }) as typeof repo.read;
  await assert.rejects(repo.edit(source.path, 'max - 1', 'max', source.sha256, 'race-edit'), /changed during edit/);
  repo.read = original;
  await assert.rejects(repo.edit(source.path, 'max - 1', 'max', source.sha256, 'race-edit'), /previously failed/);
});
