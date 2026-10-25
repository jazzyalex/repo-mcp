import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { garbageCollect } from '../src/gc.js';
import { defaultPolicy } from '../src/repo.js';
import { migrateV1 } from '../src/policy.js';
import {
  bindRegisteredTask,
  closeWorkspace,
  finishRegisteredTask,
  issueWorkspaceGrant,
  openWorkspace,
  readMultiRepoCatalog,
  registerRepository
} from '../src/multirepo-state.js';
import { StateStore } from '../src/task-state.js';
import { prepareFixture } from '../src/fixture.js';

const outcomeFile = (requestId: string) => `${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}.json`;

async function setup(t: { after(fn: () => Promise<void>): void }, taskId = 'task') {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-gc-'));
  const root = path.join(base, 'repo');
  const stateDir = path.join(base, 'state');
  const policyPath = path.join(base, 'policy.json');
  await prepareFixture(root);
  await writeFile(policyPath, JSON.stringify(migrateV1(defaultPolicy)));
  await registerRepository({ stateDir, repositoryId: 'repo', root, policyPath });
  await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root, stateDir, taskId };
}

test('gc defaults to a read-only plan and atomically prunes expired authorization history on apply', async t => {
  const { stateDir, taskId } = await setup(t);
  const opened = await openWorkspace({
    stateDir, repositoryId: 'repo', taskId, mode: 'inspect',
    requestId: 'open-old', ttlMs: 60_000
  });
  await closeWorkspace({ stateDir, workspaceToken: opened.workspace_token, requestId: 'close-old' });
  await issueWorkspaceGrant({ stateDir, taskId, ttlMs: 1_000 });

  const store = await StateStore.open(stateDir);
  const auth = await store.read<any>('control/multirepo-auth.json', 'multirepo-auth');
  assert.ok(auth);
  for (const value of Object.values<any>(auth.workspaces)) value.expires_at = '2020-01-01T00:00:00.000Z';
  for (const value of Object.values<any>(auth.grants)) value.expires_at = '2020-01-01T00:00:00.000Z';
  for (const value of Object.values<any>(auth.requests)) value.at = '2020-01-01T00:00:00.000Z';
  await store.write('control/multirepo-auth.json', 'multirepo-auth', auth);

  const before = await readFile(path.join(stateDir, 'control/multirepo-auth.json'), 'utf8');
  const markerBefore = await readFile(path.join(stateDir, 'control/multirepo-auth-used.json'), 'utf8');
  const plan = await garbageCollect({ stateDir, nowMs: Date.parse('2020-01-03T00:00:00.000Z') });
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.complete, true);
  assert.equal(plan.would_remove.workspaces, 1);
  assert.equal(plan.would_remove.grants, 1);
  assert.equal(plan.would_remove.requests, 2);
  assert.equal(await readFile(path.join(stateDir, 'control/multirepo-auth.json'), 'utf8'), before);
  assert.equal(await readFile(path.join(stateDir, 'control/multirepo-auth-used.json'), 'utf8'), markerBefore);

  const applied = await garbageCollect({ stateDir, apply: true, nowMs: Date.parse('2020-01-03T00:00:00.000Z') });
  assert.equal(applied.removed.workspaces, 1);
  assert.equal(applied.removed.grants, 1);
  assert.equal(applied.removed.requests, 2);
  const after = await store.read<any>('control/multirepo-auth.json', 'multirepo-auth');
  assert.deepEqual(after, { schema_version: 1, grants: {}, workspaces: {}, requests: {} });
  assert.ok(await store.read('control/multirepo-auth-used.json', 'multirepo-auth-used'));

  await store.remove('control/multirepo-catalog.json');
  await assert.rejects(readMultiRepoCatalog(stateDir), /catalog is missing after durable authorization state was initialized/i);
});

test('gc removes only expired captures and terminal outcomes for durably completed tasks', async t => {
  const { stateDir, taskId } = await setup(t);
  await finishRegisteredTask({ stateDir, taskId, result: 'abandoned' });
  const store = await StateStore.open(stateDir);
  const completion = await store.read<any>(`tasks/${taskId}/completion.json`, 'completion');
  assert.ok(completion);

  const captureId = '11111111-1111-4111-8111-111111111111';
  const payload = 'captured diff\n';
  await mkdir(path.join(stateDir, 'captures', taskId), { recursive: true, mode: 0o700 });
  await writeFile(path.join(stateDir, 'captures', taskId, `${captureId}.out`), payload, { mode: 0o600 });
  await store.write(`captures/${taskId}/${captureId}.json`, 'capture', {
    id: captureId, kind: 'diff', args: '', task_id: taskId,
    identity: { root: '/tmp/repo', git_dir: '/tmp/repo/.git', common_dir: '/tmp/repo/.git', branch: 'main', head: 'a'.repeat(40) },
    fingerprint: 'f'.repeat(64), index: 'e'.repeat(64), bytes: Buffer.byteLength(payload),
    sha256: createHash('sha256').update(payload).digest('hex'), created_at: 1, expires_at: 2
  });

  const terminal = {
    request_id: 'done', operation: 'edit', args_digest: 'a'.repeat(64), path: 'src/a.ts',
    status: 'completed', before_sha256: 'b'.repeat(64), after_sha256: 'c'.repeat(64),
    result: { path: 'src/a.ts' }, updated_at: '2020-01-01T00:00:00.000Z'
  };
  const intent = { ...terminal, request_id: 'intent', status: 'intent' };
  const publication = { ...terminal, request_id: 'publication', publication: { target: '/tmp/x', temp: '/tmp/y', dev: '1', ino: '2' } };
  await store.write(`tasks/${taskId}/outcomes/${outcomeFile('done')}`, 'outcome', terminal);
  await store.write(`tasks/${taskId}/outcomes/${outcomeFile('intent')}`, 'outcome', intent);
  await store.write(`tasks/${taskId}/outcomes/${outcomeFile('publication')}`, 'outcome', publication);

  const result = await garbageCollect({
    stateDir, apply: true, nowMs: Date.parse('2030-01-01T00:00:00.000Z'),
    taskRetentionDays: 1, captureRetentionHours: 0
  });
  assert.equal(result.removed.captures, 1);
  assert.equal(result.removed.capture_files, 2);
  assert.equal(result.removed.outcomes, 1);
  await assert.rejects(stat(path.join(stateDir, 'captures', taskId, `${captureId}.json`)), /ENOENT/);
  await assert.rejects(stat(path.join(stateDir, 'captures', taskId, `${captureId}.out`)), /ENOENT/);
  await assert.rejects(stat(path.join(stateDir, 'tasks', taskId, 'outcomes', outcomeFile('done'))), /ENOENT/);
  assert.ok(await store.read(`tasks/${taskId}/outcomes/${outcomeFile('intent')}`, 'outcome'));
  assert.ok(await store.read(`tasks/${taskId}/outcomes/${outcomeFile('publication')}`, 'outcome'));
  assert.ok(await store.read(`tasks/${taskId}/completion.json`, 'completion'));
  assert.ok(await store.read(`tasks/${taskId}/binding.json`, 'binding'));
});

test('gc preserves unfinished task state and a missing-state dry run creates nothing', async t => {
  const missing = path.join(os.tmpdir(), `repo-mcp-gc-missing-${Date.now()}-${Math.random()}`);
  const empty = await garbageCollect({ stateDir: missing });
  assert.equal(empty.complete, true);
  assert.equal(empty.mode, 'dry-run');
  await assert.rejects(stat(missing), /ENOENT/);

  const { stateDir, taskId } = await setup(t, 'unfinished');
  const store = await StateStore.open(stateDir);
  await store.write(`tasks/${taskId}/outcomes/${outcomeFile('old')}`, 'outcome', {
    request_id: 'old', operation: 'edit', args_digest: 'a'.repeat(64), path: 'src/a.ts',
    status: 'completed', before_sha256: 'b'.repeat(64), after_sha256: 'c'.repeat(64),
    updated_at: '2020-01-01T00:00:00.000Z'
  });
  const result = await garbageCollect({ stateDir, apply: true, nowMs: Date.parse('2021-01-01T00:00:00.000Z'), taskRetentionDays: 1 });
  assert.equal(result.removed.outcomes, 0);
  assert.ok(result.skipped.some(item => item.task_id === taskId && item.reason === 'task-not-completed'));
  assert.ok(await store.read(`tasks/${taskId}/outcomes/${outcomeFile('old')}`, 'outcome'));
});

test('gc bounds every task-directory entry and leaves over-limit state untouched', async t => {
  const { stateDir, taskId } = await setup(t, 'bounded');
  await finishRegisteredTask({ stateDir, taskId, result: 'abandoned' });
  const outcomeDir = path.join(stateDir, 'tasks', taskId, 'outcomes');
  await mkdir(outcomeDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(outcomeDir, 'unknown-a'), 'a', { mode: 0o600 });
  await writeFile(path.join(outcomeDir, 'unknown-b'), 'b', { mode: 0o600 });

  const result = await garbageCollect({
    stateDir, apply: true, nowMs: Date.parse('2030-01-01T00:00:00.000Z'), maxRecords: 1
  });
  assert.equal(result.complete, false);
  assert.equal(result.removed.outcomes, 0);
  assert.ok(result.skipped.some(item => item.task_id === taskId && item.reason === 'task-busy-or-unsafe'));
  assert.equal(await readFile(path.join(outcomeDir, 'unknown-a'), 'utf8'), 'a');
  assert.equal(await readFile(path.join(outcomeDir, 'unknown-b'), 'utf8'), 'b');
});

test('gc rejects a pending journal that names anything outside its exact deletion unit', async t => {
  const { base, stateDir, taskId } = await setup(t, 'pending-safe');
  await finishRegisteredTask({ stateDir, taskId, result: 'abandoned' });
  const outside = path.join(base, 'outside.txt');
  await writeFile(outside, 'keep', { mode: 0o600 });
  const store = await StateStore.open(stateDir);
  await store.write('gc/pending.json', 'gc-pending', {
    schema_version: 1, category: 'outcome', task_id: taskId, record_id: 'a'.repeat(32),
    eligible_at: '2020-01-01T00:00:00.000Z', witness: 'b'.repeat(64),
    files: [{ rel: '../outside.txt', dev: '1', ino: '1', size: 4 }]
  });

  const result = await garbageCollect({ stateDir, apply: true, nowMs: Date.parse('2030-01-01T00:00:00.000Z') });
  assert.equal(result.complete, false);
  assert.ok(result.skipped.some(item => item.reason === 'pending-journal-unsafe'));
  assert.equal(await readFile(outside, 'utf8'), 'keep');
  assert.ok(await store.read('gc/pending.json', 'gc-pending'));
});

test('gc keeps a terminal outcome whose filename does not bind its request ID', async t => {
  const { stateDir, taskId } = await setup(t, 'outcome-binding');
  await finishRegisteredTask({ stateDir, taskId, result: 'abandoned' });
  const store = await StateStore.open(stateDir);
  const wrongName = `${'f'.repeat(32)}.json`;
  await store.write(`tasks/${taskId}/outcomes/${wrongName}`, 'outcome', {
    request_id: 'bound-request', operation: 'edit', args_digest: 'a'.repeat(64), path: 'src/a.ts',
    status: 'completed', before_sha256: 'b'.repeat(64), after_sha256: 'c'.repeat(64),
    result: { path: 'src/a.ts' }, updated_at: '2020-01-01T00:00:00.000Z'
  });

  const result = await garbageCollect({ stateDir, apply: true, nowMs: Date.parse('2030-01-01T00:00:00.000Z'), taskRetentionDays: 1 });
  assert.equal(result.complete, false);
  assert.equal(result.removed.outcomes, 0);
  assert.ok(result.skipped.some(item => item.reason === `outcome-unsafe:${'f'.repeat(32)}`));
  assert.ok(await store.read(`tasks/${taskId}/outcomes/${wrongName}`, 'outcome'));
});

async function fillAuth(stateDir: string, taskId: string, total: number, at: string) {
  const opened = await openWorkspace({ stateDir, repositoryId: 'repo', taskId, mode: 'inspect', requestId: `seed-${at}`, ttlMs: 60_000 });
  await closeWorkspace({ stateDir, workspaceToken: opened.workspace_token, requestId: `seed-close-${at}` });
  const store = await StateStore.open(stateDir);
  const auth = await store.read<any>('control/multirepo-auth.json', 'multirepo-auth');
  const [workspace] = Object.values<any>(auth.workspaces);
  const [, request] = Object.entries<any>(auth.requests)[0];
  const count = () => Object.keys(auth.workspaces).length + Object.keys(auth.requests).length + Object.keys(auth.grants).length;
  for (let i = 0; count() < total; i++) {
    const id = createHash('sha256').update(`fill-${at}-${i}`).digest('hex').slice(0, 32);
    auth.workspaces[id] = { ...workspace, workspace_id: id, expires_at: at };
    if (count() < total) auth.requests[createHash('sha256').update(`fill-req-${at}-${i}`).digest('hex')] = { ...request, workspace_id: id, at };
  }
  await store.write('control/multirepo-auth.json', 'multirepo-auth', auth);
}

test('near-limit collection audits before deleting and deletes nothing when the audit cannot be written', async t => {
  const { MAX_AUTH_RECORDS, authRecordCount } = await import('../src/multirepo-state.js');
  const { symlink } = await import('node:fs/promises');
  const { base, stateDir, taskId } = await setup(t);
  await fillAuth(stateDir, taskId, MAX_AUTH_RECORDS, '2020-01-01T00:00:00.000Z');
  await writeFile(path.join(base, 'elsewhere.jsonl'), '');
  await symlink(path.join(base, 'elsewhere.jsonl'), path.join(stateDir, 'gc-audit.jsonl'));
  await assert.rejects(openWorkspace({ stateDir, repositoryId: 'repo', taskId, mode: 'inspect', requestId: 'blocked', ttlMs: 60_000 }), /automatic collection failed/);
  assert.equal(await authRecordCount(stateDir), MAX_AUTH_RECORDS, 'nothing was deleted without an audit');
});

test('near-limit collection takes no locks and writes nothing when no record is old enough', async t => {
  const { MAX_AUTH_RECORDS } = await import('../src/multirepo-state.js');
  const { collectAuthorizationNearLimit } = await import('../src/gc.js');
  const { stateDir, taskId } = await setup(t);
  await fillAuth(stateDir, taskId, MAX_AUTH_RECORDS - 1, new Date(Date.now() + 3_600_000).toISOString());
  assert.equal(await collectAuthorizationNearLimit(stateDir), null);
  await assert.rejects(stat(path.join(stateDir, 'gc-audit.jsonl')), /ENOENT/);
  // A fresh open needs room for two records; 4095 recent records leave one.
  await assert.rejects(openWorkspace({ stateDir, repositoryId: 'repo', taskId, mode: 'inspect', requestId: 'one-short', ttlMs: 60_000 }), /no record is old enough/);
  // A grant needs one record and still fits.
  await issueWorkspaceGrant({ stateDir, taskId, ttlMs: 1_000 });
});

test('workspace_open collects expired authorization records itself instead of locking out at the cap', async t => {
  const { MAX_AUTH_RECORDS } = await import('../src/multirepo-state.js');
  const { stateDir, taskId } = await setup(t);
  const opened = await openWorkspace({ stateDir, repositoryId: 'repo', taskId, mode: 'inspect', requestId: 'seed', ttlMs: 60_000 });
  await closeWorkspace({ stateDir, workspaceToken: opened.workspace_token, requestId: 'seed-close' });
  const store = await StateStore.open(stateDir);
  const auth = await store.read<any>('control/multirepo-auth.json', 'multirepo-auth');
  const [workspace] = Object.values<any>(auth.workspaces);
  const requests = Object.entries<any>(auth.requests);
  // Fill the store to the cap with old, closed selections and their request records.
  for (let i = 0; Object.keys(auth.workspaces).length + Object.keys(auth.requests).length + Object.keys(auth.grants).length < MAX_AUTH_RECORDS; i++) {
    const id = createHash('sha256').update(`old-${i}`).digest('hex').slice(0, 32);
    auth.workspaces[id] = { ...workspace, workspace_id: id, expires_at: '2020-01-01T00:00:00.000Z' };
    const [key, request] = requests[0];
    auth.requests[createHash("sha256").update(`${key}-old-${i}`).digest("hex")] = { ...request, workspace_id: id, at: "2020-01-01T00:00:00.000Z" };
  }
  await store.write('control/multirepo-auth.json', 'multirepo-auth', auth);
  const again = await openWorkspace({ stateDir, repositoryId: 'repo', taskId, mode: 'inspect', requestId: 'after-cap', ttlMs: 60_000 });
  assert.equal(again.selection.status, 'open');
  const { authRecordCount } = await import('../src/multirepo-state.js');
  assert.ok(await authRecordCount(stateDir) < 100, 'old records were collected');
  const audit = await readFile(path.join(stateDir, 'gc-audit.jsonl'), 'utf8');
  assert.ok(audit.indexOf('"action":"start"') >= 0 && audit.indexOf('"action":"start"') < audit.indexOf('"action":"delete"'), 'the intent is audited before the deletion');
});
