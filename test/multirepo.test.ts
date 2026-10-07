import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { prepareFixture } from '../src/fixture.js';
import { RepoWorkspace, defaultPolicy } from '../src/repo.js';
import { DEFAULT_LIMITS } from '../src/limits.js';
import { migrateV1 } from '../src/policy.js';
import { coordinatorBind } from '../src/coordinator.js';
import { RuntimeManager, startMultiRepoServer } from '../src/multirepo-server.js';
import {
  authorizeWorkspace,
  bindRegisteredTask,
  closeWorkspace,
  finishRegisteredTask,
  internalMutationRequestId,
  issueWorkspaceGrant,
  migrateActiveServiceToCatalog,
  openWorkspace,
  readMultiRepoCatalog,
  resolveRegisteredRepository,
  rebindRegisteredTask,
  recoverMultiRepoControlLock,
  recoverWorkspaceAdmissionLock,
  registerRepository,
  revokeWorkspace,
  rollbackActiveServiceCatalogMigration,
  setRegisteredTaskPhase,
  setRepositoryEnabled,
  withWorkspaceAdmission
} from '../src/multirepo-state.js';
import { StateStore, acquireLock } from '../src/task-state.js';
import { taskWriterLockStatus } from '../src/task.js';

type ToolReply = { error: boolean; data: any };

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function fixture(base: string, name: string) {
  const root = path.join(base, name);
  await prepareFixture(root);
  return realpath(root);
}

async function writePolicy(base: string, name: string) {
  const file = path.join(base, name);
  await writeFile(file, JSON.stringify(migrateV1(defaultPolicy)));
  return realpath(file);
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[]).find(item => item.type === 'text')?.text ?? '';
    if (result.isError) return { error: true, data: text };
    return { error: false, data: JSON.parse(text) };
  } catch (error) {
    return { error: true, data: error instanceof Error ? error.message : String(error) };
  }
}

function workspacePayload(selection: Record<string, unknown>) {
  return JSON.stringify({
    workspace_id: selection.workspace_id,
    repository_id: selection.repository_id,
    task_id: selection.task_id,
    mode: selection.mode,
    capabilities: selection.capabilities,
    registration_epoch: selection.registration_epoch,
    binding_epoch: selection.binding_epoch,
    phase_epoch: selection.phase_epoch,
    policy_digest: selection.policy_digest,
    issued_at: selection.issued_at,
    expires_at: selection.expires_at
  });
}

async function expireWorkspaceToken(stateDir: string, originalToken: string) {
  const [, keyId, workspaceId] = originalToken.split('.');
  const store = await StateStore.open(stateDir);
  const key = await store.read<{ key_id: string; secret: string }>('control/workspace-token-key.json', 'workspace-token-key');
  const auth = await store.read<any>('control/multirepo-auth.json', 'multirepo-auth');
  assert.ok(key && auth?.workspaces?.[workspaceId]);
  assert.equal(key.key_id, keyId);
  const selection = { ...auth.workspaces[workspaceId], expires_at: '2000-01-01T00:00:00.000Z' };
  auth.workspaces[workspaceId] = selection;
  await store.write('control/multirepo-auth.json', 'multirepo-auth', auth);
  const mac = createHmac('sha256', Buffer.from(key.secret, 'base64url'))
    .update('workspace').update('\0').update(workspacePayload(selection)).digest('base64url');
  return `ws1.${key.key_id}.${workspaceId}.${mac}`;
}

test('mutation request IDs bind the complete workspace identity', () => {
  const sharedPrefix = '0123456789ab';
  const workspaceA = sharedPrefix + '0'.repeat(20);
  const workspaceB = sharedPrefix + 'f'.repeat(20);
  const requestA = internalMutationRequestId(workspaceA, 'same-visible-request');
  const requestB = internalMutationRequestId(workspaceB, 'same-visible-request');
  assert.notEqual(requestA, requestB, 'workspaces sharing the old 48-bit prefix must remain isolated');
  assert.match(requestA, /^ws-[a-f0-9]{32}-[a-f0-9]{64}$/);
  assert.throws(() => internalMutationRequestId('not-a-workspace-id', 'request'), /invalid workspace id/i);
});

test('missing catalog with retained authorization fails closed instead of resetting repository epochs', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-missing-catalog-auth-')));
  const stateDir = path.join(base, 'state');
  const root = await fixture(base, 'repo');
  const policyPath = await writePolicy(base, 'policy.json');
  try {
    const registered = await registerRepository({ stateDir, repositoryId: 'repo', root, policyPath });
    assert.equal(registered.repository.registration_epoch, 1);
    await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId: 'task' });
    const opened = await openWorkspace({ stateDir, repositoryId: 'repo', taskId: 'task', mode: 'inspect', requestId: 'old-workspace' });
    const store = await StateStore.open(stateDir);
    await store.remove('control/multirepo-catalog.json');

    await assert.rejects(readMultiRepoCatalog(stateDir), /catalog is missing after durable authorization state was initialized/i);
    await assert.rejects(authorizeWorkspace(stateDir, opened.workspace_token, 'read'), /catalog is missing after durable authorization state was initialized/i);
    await assert.rejects(
      registerRepository({ stateDir, repositoryId: 'repo', root, policyPath }),
      /catalog is missing after durable authorization state was initialized/i
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('missing catalog after authority initialization fails closed even without workspace history', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-missing-catalog-marker-')));
  const stateDir = path.join(base, 'state');
  const root = await fixture(base, 'repo');
  const policyPath = await writePolicy(base, 'policy.json');
  try {
    await registerRepository({ stateDir, repositoryId: 'repo', root, policyPath });
    const store = await StateStore.open(stateDir);
    assert.equal(await store.read('control/multirepo-auth.json', 'multirepo-auth'), undefined);
    assert.ok(await store.read('control/multirepo-initialized.json', 'multirepo-initialized'));
    await store.remove('control/multirepo-catalog.json');
    await assert.rejects(
      readMultiRepoCatalog(stateDir),
      /catalog is missing after durable authorization state was initialized/i
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('repository registration rejects empty display names before catalog publication', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-empty-name-')));
  const stateDir = path.join(base, 'state');
  const root = await fixture(base, 'repo');
  const policyPath = await writePolicy(base, 'policy.json');
  try {
    await assert.rejects(
      registerRepository({ stateDir, repositoryId: 'repo', name: '   ', root, policyPath }),
      /repository name must contain at least one non-whitespace character/i
    );
    assert.deepEqual((await readMultiRepoCatalog(stateDir)).repositories, {});
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('local coordinator resolves the current checkout without exposing roots through MCP', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-resolve-checkout-')));
  const stateDir = path.join(base, 'state');
  const root = await fixture(base, 'repo');
  const other = await fixture(base, 'other');
  const policyPath = await writePolicy(base, 'policy.json');
  try {
    assert.equal((await resolveRegisteredRepository(root, stateDir)).repository, null);
    await registerRepository({ stateDir, repositoryId: 'friendly-name', name: 'Friendly name', root, policyPath });
    await bindRegisteredTask({ stateDir, repositoryId: 'friendly-name', taskId: 'review-task' });
    const resolved = await resolveRegisteredRepository(path.join(root, '.'), stateDir);
    assert.equal(resolved.repository?.repository_id, 'friendly-name');
    assert.equal(resolved.repository?.tasks[0]?.task_id, 'review-task');
    assert.equal((resolved.repository as Record<string, unknown>).root, undefined);
    assert.equal((await resolveRegisteredRepository(other, stateDir)).repository, null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('permanent broker starts with an empty catalog and no ambient repository', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-empty-broker-')));
  const stateDir = path.join(base, 'state');
  const service = await startMultiRepoServer(stateDir, 0);
  const client = new Client({ name: 'empty-broker-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const info = await call(client, 'service_info');
    const repositories = await call(client, 'repository_list');
    assert.equal(info.error, false, String(info.data));
    assert.equal(info.data.registered_repositories, 0);
    assert.equal(info.data.registered_tasks, 0);
    assert.deepEqual(repositories.data.repositories, []);
    const unscoped = await call(client, 'repo_info');
    assert.equal(unscoped.error, true);
    assert.match(String(unscoped.data), /workspace_token|required/i);
  } finally {
    await client.close();
    await service.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('workspace close waits for admitted work before publishing revocation', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-workspace-drain-')));
  const stateDir = path.join(base, 'state');
  const root = await fixture(base, 'repo');
  const policyPath = await writePolicy(base, 'policy.json');
  try {
    await registerRepository({ stateDir, repositoryId: 'repo', root, policyPath });
    await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId: 'task' });
    const opened = await openWorkspace({ stateDir, repositoryId: 'repo', taskId: 'task', mode: 'inspect', requestId: 'open-drain' });

    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const operation = withWorkspaceAdmission(stateDir, opened.workspace_token, 'read', async () => {
      entered();
      await held;
      return 'done';
    });
    await enteredPromise;

    let closeDone = false;
    const closing = closeWorkspace({ stateDir, workspaceToken: opened.workspace_token, requestId: 'close-drain' }).then(result => {
      closeDone = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(closeDone, false, 'close must not acknowledge while admitted work is active');
    release();
    assert.equal(await operation, 'done');
    assert.equal((await closing).status, 'closed');
    await assert.rejects(authorizeWorkspace(stateDir, opened.workspace_token, 'read'), /closed or revoked/i);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('explicit stale-lock recovery never steals live or replacement control/admission locks', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-stale-lock-recovery-')));
  const stateDir = path.join(base, 'state');
  const root = await fixture(base, 'repo');
  const policyPath = await writePolicy(base, 'policy.json');
  const store = await StateStore.open(stateDir);
  const deadPid = 2_147_483_646;
  const at = new Date().toISOString();
  try {
    const liveControl = await acquireLock(store, 'multirepo-control-v1', 'configure multi-repository service');
    await assert.rejects(recoverMultiRepoControlLock({ stateDir }), /live process.*live locks are never recovered/i);
    await liveControl.release();

    const staleControl = {
      pid: deadPid,
      hostname: os.hostname(),
      token: 'stale-control-token',
      purpose: 'configure multi-repository service',
      acquired_at: at
    };
    await store.write('locks/multirepo-control-v1.json', 'lock', staleControl);
    const recoveredControl = await recoverMultiRepoControlLock({ stateDir });
    assert.equal(recoveredControl.recovered, true);
    assert.equal(await store.read('locks/multirepo-control-v1.json', 'lock'), undefined);

    await store.write('locks/multirepo-control-v1.json', 'lock', { ...staleControl, token: 'old-token' });
    const replacement = { ...staleControl, token: 'replacement-token' };
    await assert.rejects(
      recoverMultiRepoControlLock({
        stateDir,
        beforeRecover: () => store.write('locks/multirepo-control-v1.json', 'lock', replacement)
      }),
      /changed before stale recovery|replacement lock/i
    );
    assert.equal((await store.read<any>('locks/multirepo-control-v1.json', 'lock'))?.token, replacement.token);
    await store.remove('locks/multirepo-control-v1.json');

    await registerRepository({ stateDir, repositoryId: 'repo', root, policyPath });
    await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId: 'task' });
    const opened = await openWorkspace({ stateDir, repositoryId: 'repo', taskId: 'task', mode: 'inspect', requestId: 'recovery-workspace' });
    const workspaceId = opened.selection.workspace_id;
    const admission = `workspace-${workspaceId}-admission`;
    const liveAdmission = await acquireLock(store, admission, `workspace ${workspaceId} read`);
    await assert.rejects(
      recoverWorkspaceAdmissionLock({ stateDir, workspaceId }),
      /live process.*live locks are never recovered/i
    );
    await liveAdmission.release();

    await store.write(`locks/${admission}.json`, 'lock', {
      pid: deadPid,
      hostname: os.hostname(),
      token: 'stale-admission-token',
      purpose: `workspace ${workspaceId} read`,
      acquired_at: at
    });
    const recoveredAdmission = await recoverWorkspaceAdmissionLock({ stateDir, workspaceId });
    assert.equal(recoveredAdmission.recovered, true);
    assert.equal(recoveredAdmission.status, 'open');
    assert.equal(await store.read(`locks/${admission}.json`, 'lock'), undefined);

    await revokeWorkspace({ stateDir, workspaceId });
    await store.write(`locks/${admission}.json`, 'lock', {
      pid: deadPid,
      hostname: os.hostname(),
      token: 'impossible-read-after-revoke',
      purpose: `workspace ${workspaceId} read`,
      acquired_at: at
    });
    await assert.rejects(
      recoverWorkspaceAdmissionLock({ stateDir, workspaceId }),
      /unexpected purpose|inspect operator state/i,
      'a stale read lock is inconsistent with a revoked persisted workspace'
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('repository disable drains its task without holding the service-wide control lock', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-repository-drain-')));
  const stateDir = path.join(base, 'state');
  const root = await fixture(base, 'repo');
  const otherRoot = await fixture(base, 'other-repo');
  const policyPath = await writePolicy(base, 'policy.json');
  const otherPolicyPath = await writePolicy(base, 'other-policy.json');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let atRename!: () => void;
  const atRenamePromise = new Promise<void>(resolve => { atRename = resolve; });
  let repo: RepoWorkspace | undefined;
  try {
    const registered = await registerRepository({ stateDir, repositoryId: 'repo', root, policyPath });
    await registerRepository({ stateDir, repositoryId: 'other', root: otherRoot, policyPath: otherPolicyPath });
    await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId: 'task' });
    repo = await RepoWorkspace.create(root, defaultPolicy, {
      task: { stateDir, taskId: 'task', policyDigest: registered.repository.policy_digest },
      pathHook: async stage => {
        if (stage === 'edit:before-rename') {
          atRename();
          await held;
        }
      }
    });
    const source = await repo.read('src/clamp.js');
    const editing = repo.edit('src/clamp.js', 'max - 1', 'max', source.sha256, 'drain-edit');
    await atRenamePromise;

    let disableDone = false;
    const disabling = setRepositoryEnabled({ stateDir, repositoryId: 'repo', enabled: false }).then(result => {
      disableDone = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(disableDone, false, 'disable must not publish while a task mutation holds the gate');

    let unrelatedDone = false;
    const unrelated = setRepositoryEnabled({ stateDir, repositoryId: 'other', enabled: false }).then(result => {
      unrelatedDone = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    const unrelatedFinishedWhileRepoWasDraining = unrelatedDone;

    release();
    await editing;
    const [disabled, otherDisabled] = await Promise.all([disabling, unrelated]);
    assert.equal(unrelatedFinishedWhileRepoWasDraining, true, 'repository A must not hold the service-wide control lock while waiting on its task gate');
    assert.equal(otherDisabled.repository.enabled, false);
    assert.equal(disabled.repository.enabled, false);
    assert.ok(disabled.repository.registration_epoch > registered.repository.registration_epoch);
  } finally {
    release?.();
    await repo?.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('task finish drains admitted mutations before publishing completed catalog authority', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-finish-drain-')));
  const stateDir = path.join(base, 'state');
  const root = await fixture(base, 'repo');
  const policyPath = await writePolicy(base, 'policy.json');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let atRename!: () => void;
  const atRenamePromise = new Promise<void>(resolve => { atRename = resolve; });
  let repo: RepoWorkspace | undefined;
  try {
    const registered = await registerRepository({ stateDir, repositoryId: 'repo', root, policyPath });
    await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId: 'task' });
    repo = await RepoWorkspace.create(root, defaultPolicy, {
      task: { stateDir, taskId: 'task', policyDigest: registered.repository.policy_digest },
      pathHook: async stage => {
        if (stage === 'edit:before-rename') {
          atRename();
          await held;
        }
      }
    });
    const source = await repo.read('src/clamp.js');
    const editing = repo.edit('src/clamp.js', 'max - 1', 'max', source.sha256, 'finish-drain-edit');
    await atRenamePromise;

    const finishing = finishRegisteredTask({ stateDir, taskId: 'task', result: 'abandoned' });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await readMultiRepoCatalog(stateDir)).tasks.task.completed, false, 'finish must not publish completed authority while a mutation owns the task gate');

    release();
    await editing;
    await repo.close();
    repo = undefined;
    const finished = await finishing;
    assert.equal(finished.task.completed, true);
    assert.equal(finished.completion.result, 'abandoned');
  } finally {
    release?.();
    await repo?.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('RepoWorkspace close is single-flight and cannot release a replacement task writer lock', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-close-single-flight-')));
  const stateDir = path.join(base, 'state');
  const root = await fixture(base, 'repo');
  const policyPath = await writePolicy(base, 'policy.json');
  const registered = await registerRepository({ stateDir, repositoryId: 'repo', root, policyPath });
  await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId: 'task' });
  const closeEntered = deferred();
  const closeRelease = deferred();
  let closeCalls = 0;
  let original: RepoWorkspace | undefined;
  let replacement: RepoWorkspace | undefined;
  try {
    original = await RepoWorkspace.create(root, defaultPolicy, {
      task: { stateDir, taskId: 'task', policyDigest: registered.repository.policy_digest },
      closeHook: async () => {
        closeCalls++;
        closeEntered.resolve();
        await closeRelease.promise;
      }
    });
    const firstClose = original.close();
    await closeEntered.promise;
    const secondClose = original.close();
    assert.equal(closeCalls, 1, 'concurrent close calls must share one close operation');
    closeRelease.resolve();
    await Promise.all([firstClose, secondClose]);
    assert.equal(closeCalls, 1);

    replacement = await RepoWorkspace.create(root, defaultPolicy, {
      task: { stateDir, taskId: 'task', policyDigest: registered.repository.policy_digest }
    });
    assert.equal((await taskWriterLockStatus(stateDir, 'task', { readOnly: true })).state, 'live');
    await original.close();
    assert.equal((await taskWriterLockStatus(stateDir, 'task', { readOnly: true })).state, 'live', 'a repeated close on the old runtime must not release the replacement writer lock');
  } finally {
    closeRelease.resolve();
    await original?.close().catch(() => {});
    await replacement?.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
});

test('RuntimeManager serializes first-use leasing, stale reconcile, and replacement close', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-runtime-serialization-')));
  const stateDir = path.join(base, 'state');
  const root = await fixture(base, 'repo');
  const policyPath = await writePolicy(base, 'policy.json');
  await registerRepository({ stateDir, repositoryId: 'repo', root, policyPath });
  await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId: 'task' });

  const firstLeaseEntered = deferred();
  const firstLeaseRelease = deferred();
  let blockFirstLease = true;
  let closeBarrier: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; used: boolean } | undefined;
  const manager = new RuntimeManager(stateDir, {
    reconcileIntervalMs: 0,
    hooks: {
      afterCreateBeforeLease: async taskId => {
        if (taskId !== 'task' || !blockFirstLease) return;
        blockFirstLease = false;
        firstLeaseEntered.resolve();
        await firstLeaseRelease.promise;
      },
      beforeClose: async taskId => {
        if (taskId !== 'task' || !closeBarrier || closeBarrier.used) return;
        closeBarrier.used = true;
        closeBarrier.entered.resolve();
        await closeBarrier.release.promise;
      }
    }
  });
  try {
    const opened = await openWorkspace({ stateDir, repositoryId: 'repo', taskId: 'task', mode: 'inspect', requestId: 'runtime-first-open' });
    const authorized = await authorizeWorkspace(stateDir, opened.workspace_token, 'read');
    let firstCallbackRan = false;
    const firstUse = manager.use(authorized, opened.workspace_token, 'read', async repo => {
      firstCallbackRan = true;
      return repo.read('README.md');
    });
    await firstLeaseEntered.promise;

    await setRepositoryEnabled({ stateDir, repositoryId: 'repo', enabled: false });
    const firstReconcile = manager.reconcileNow();
    firstLeaseRelease.resolve();
    await assert.rejects(firstUse, /no longer active|stale|authorization changed/i);
    await firstReconcile;
    assert.equal(firstCallbackRan, false, 'stale first use must fail before exposing the repository callback');
    assert.equal((await taskWriterLockStatus(stateDir, 'task', { readOnly: true })).state, 'live', 'reconcile queued behind first lease must not close an active leased slot');

    await manager.reconcileNow();
    assert.equal((await taskWriterLockStatus(stateDir, 'task', { readOnly: true })).state, 'absent', 'a later reconcile closes the now-idle stale slot');

    await setRepositoryEnabled({ stateDir, repositoryId: 'repo', enabled: true });
    const enabled = await openWorkspace({ stateDir, repositoryId: 'repo', taskId: 'task', mode: 'inspect', requestId: 'runtime-enabled-open' });
    const enabledAuth = await authorizeWorkspace(stateDir, enabled.workspace_token, 'read');
    await manager.use(enabledAuth, enabled.workspace_token, 'read', repo => repo.read('README.md'));

    await rebindRegisteredTask({ stateDir, taskId: 'task' });
    const rebound = await openWorkspace({ stateDir, repositoryId: 'repo', taskId: 'task', mode: 'inspect', requestId: 'runtime-rebound-open' });
    const reboundAuth = await authorizeWorkspace(stateDir, rebound.workspace_token, 'read');

    closeBarrier = { entered: deferred(), release: deferred(), used: false };
    const staleClosing = manager.reconcileNow();
    await closeBarrier.entered.promise;

    let replacementCallbackRan = false;
    const replacementUse = manager.use(reboundAuth, rebound.workspace_token, 'read', async repo => {
      replacementCallbackRan = true;
      return repo.read('README.md');
    });
    await Promise.resolve();
    assert.equal(replacementCallbackRan, false, 'replacement use must remain serialized behind stale runtime close');

    closeBarrier.release.resolve();
    await staleClosing;
    const replacementRead = await replacementUse;
    assert.match(replacementRead.content, /Disposable MCP trial/i);
    assert.equal(replacementCallbackRan, true);
    assert.equal((await taskWriterLockStatus(stateDir, 'task', { readOnly: true })).state, 'live', 'replacement runtime must retain its own writer lock after stale close finishes');
  } finally {
    firstLeaseRelease.resolve();
    closeBarrier?.release.resolve();
    await manager.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
});

test('broker reauthorizes mutations and checks inside the task gate after control transitions', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-gated-authorization-')));
  const stateDir = path.join(base, 'state');
  const root = await fixture(base, 'repo');
  const policyPath = await writePolicy(base, 'policy.json');
  await registerRepository({ stateDir, repositoryId: 'repo', root, policyPath });
  await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId: 'task' });

  let barrier = { capability: 'write' as 'write' | 'check', reached: deferred(), release: deferred(), used: false };
  const service = await startMultiRepoServer(stateDir, 0, {
    runtimeHooks: {
      beforeOperation: async (_taskId, capability) => {
        if (barrier.used || capability !== barrier.capability) return;
        barrier.used = true;
        barrier.reached.resolve();
        await barrier.release.promise;
      }
    }
  });
  const client = new Client({ name: 'gated-authorization-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const grant = await issueWorkspaceGrant({ stateDir, taskId: 'task' });
    const code = await call(client, 'workspace_open', {
      repository_id: 'repo', task_id: 'task', mode: 'code', request_id: 'open-code-gated', write_grant: grant.write_grant
    });
    assert.equal(code.error, false, String(code.data));
    const token = code.data.workspace_token as string;
    const source = await call(client, 'read', { workspace_token: token, path: 'src/clamp.js' });
    assert.equal(source.error, false, String(source.data));

    const editing = call(client, 'edit', {
      workspace_token: token,
      path: 'src/clamp.js',
      old_text: 'max - 1',
      new_text: 'max',
      expected_sha256: source.data.sha256,
      request_id: 'gated-disable-edit'
    });
    await barrier.reached.promise;
    await setRepositoryEnabled({ stateDir, repositoryId: 'repo', enabled: false });
    barrier.release.resolve();
    const editResult = await editing;
    assert.equal(editResult.error, true, String(editResult.data));
    assert.match(String(editResult.data), /no longer active|stale|authorization changed/i);
    assert.equal(await readFile(path.join(root, 'src/clamp.js'), 'utf8'), source.data.content, 'disable acknowledgement must precede and block the delayed old write');

    await setRepositoryEnabled({ stateDir, repositoryId: 'repo', enabled: true });
    const resumedGrant = await issueWorkspaceGrant({ stateDir, taskId: 'task' });
    const resumed = await call(client, 'workspace_open', {
      repository_id: 'repo', task_id: 'task', mode: 'code', request_id: 'open-code-check-race', write_grant: resumedGrant.write_grant
    });
    assert.equal(resumed.error, false, String(resumed.data));

    barrier = { capability: 'check', reached: deferred(), release: deferred(), used: false };
    const checking = call(client, 'run_tests', { workspace_token: resumed.data.workspace_token, suite: 'test/clamp.test.js' });
    await barrier.reached.promise;
    await setRegisteredTaskPhase({ stateDir, taskId: 'task', phase: 'review' });
    barrier.release.resolve();
    const checkResult = await checking;
    assert.equal(checkResult.error, true, String(checkResult.data));
    assert.match(String(checkResult.data), /stale|authorization changed|phase/i);
  } finally {
    barrier.release.resolve();
    await client.close();
    await service.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('multi-repository broker isolates workspaces, writers, cursors, requests and phase changes', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-multirepo-')));
  const stateDir = path.join(base, 'state');
  const rootA = await fixture(base, 'repo-a');
  const rootB = await fixture(base, 'repo-b');
  const policyA = await writePolicy(base, 'a-policy.json');
  const policyB = await writePolicy(base, 'b-policy.json');
  await writeFile(path.join(rootA, 'README.md'), 'Repository A marker. ' + 'x'.repeat(100_000));
  await writeFile(path.join(rootB, 'README.md'), 'Repository B marker.\n');

  await registerRepository({ stateDir, repositoryId: 'repo-a', name: 'Repository A', root: rootA, policyPath: policyA });
  await registerRepository({ stateDir, repositoryId: 'repo-b', name: 'Repository B', root: rootB, policyPath: policyB });
  await bindRegisteredTask({ stateDir, repositoryId: 'repo-a', taskId: 'task-a' });
  await bindRegisteredTask({ stateDir, repositoryId: 'repo-b', taskId: 'task-b' });

  const service = await startMultiRepoServer(stateDir, 0);
  const client = new Client({ name: 'multirepo-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map(tool => tool.name).sort(),
      ['service_info', 'repository_list', 'workspace_open', 'workspace_close', 'repo_info', 'list_files', 'read', 'search', 'git_diff', 'edit', 'create_file', 'run_tests'].sort()
    );
    for (const name of ['repo_info', 'list_files', 'read', 'search', 'git_diff', 'edit', 'create_file', 'run_tests']) {
      const schema = tools.tools.find(tool => tool.name === name)?.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
      assert.ok(schema?.properties?.workspace_token, `${name} must expose workspace_token`);
      assert.ok(schema.required?.includes('workspace_token'), `${name} must require workspace_token`);
    }
    const diffSchema = tools.tools.find(tool => tool.name === 'git_diff')?.inputSchema as { properties?: Record<string, unknown> };
    assert.ok(diffSchema?.properties?.base_ref, 'git_diff must expose the committed-change base_ref selector');

    const firstService = await call(client, 'service_info');
    assert.equal(firstService.error, false, String(firstService.data));
    const pid = firstService.data.process_pid;
    assert.equal(firstService.data.workspace_contract, 'explicit-token');

    const listed = await call(client, 'repository_list');
    assert.equal(listed.error, false, String(listed.data));
    assert.deepEqual(listed.data.repositories.map((r: any) => r.repository_id).sort(), ['repo-a', 'repo-b']);
    assert.equal(JSON.stringify(listed.data).includes(rootA), false, 'bootstrap discovery must not reveal filesystem roots');

    const inspectA = await call(client, 'workspace_open', { repository_id: 'repo-a', task_id: 'task-a', mode: 'inspect', request_id: 'open-inspect-a' });
    const inspectA2 = await call(client, 'workspace_open', { repository_id: 'repo-a', task_id: 'task-a', mode: 'inspect', request_id: 'open-inspect-a-2' });
    const inspectB = await call(client, 'workspace_open', { repository_id: 'repo-b', task_id: 'task-b', mode: 'inspect', request_id: 'open-inspect-b' });
    assert.equal(inspectA.error, false, String(inspectA.data));
    assert.equal(inspectA2.error, false, String(inspectA2.data));
    assert.equal(inspectB.error, false, String(inspectB.data));
    const inspectAToken = inspectA.data.workspace_token as string;
    const inspectA2Token = inspectA2.data.workspace_token as string;
    const inspectBToken = inspectB.data.workspace_token as string;

    const [readA, readA2, readB] = await Promise.all([
      call(client, 'read', { workspace_token: inspectAToken, path: 'README.md' }),
      call(client, 'read', { workspace_token: inspectA2Token, path: 'README.md' }),
      call(client, 'read', { workspace_token: inspectBToken, path: 'README.md' })
    ]);
    assert.equal(readA.error, false, String(readA.data));
    assert.equal(readA2.error, false, String(readA2.data));
    assert.equal(readB.error, false, String(readB.data));
    assert.doesNotMatch(readA.data.content, /Repository B marker/);
    assert.match(readB.data.content, /Repository B marker/);
    assert.ok(Buffer.byteLength(JSON.stringify(readA.data)) <= DEFAULT_LIMITS.page_bytes, 'workspace scope/cursor wrapping must preserve the original page_bytes ceiling');
    assert.equal(readA.data.scope.repository_id, 'repo-a');
    assert.equal(readB.data.scope.repository_id, 'repo-b');

    const missing = await call(client, 'read', { path: 'README.md' });
    assert.equal(missing.error, true);
    assert.match(String(missing.data), /workspace_token|required/i);
    const forged = inspectAToken.slice(0, -1) + (inspectAToken.endsWith('A') ? 'B' : 'A');
    const forgedRead = await call(client, 'read', { workspace_token: forged, path: 'README.md' });
    assert.equal(forgedRead.error, true);
    assert.match(String(forgedRead.data), /workspace_token|invalid/i);

    const pageA = await call(client, 'read', { workspace_token: inspectAToken, path: 'src/clamp.js', max_lines: 1 });
    assert.equal(pageA.error, false, String(pageA.data));
    assert.ok(pageA.data.next_cursor);
    const crossCursor = await call(client, 'read', { workspace_token: inspectBToken, path: 'src/clamp.js', cursor: pageA.data.next_cursor });
    assert.equal(crossCursor.error, true);
    assert.match(String(crossCursor.data), /different workspace|workspace cursor|invalid/i);

    const grantA = await issueWorkspaceGrant({ stateDir, taskId: 'task-a' });
    const grantB = await issueWorkspaceGrant({ stateDir, taskId: 'task-b' });
    const codeA = await call(client, 'workspace_open', {
      repository_id: 'repo-a', task_id: 'task-a', mode: 'code', request_id: 'open-code-a', write_grant: grantA.write_grant
    });
    const codeB = await call(client, 'workspace_open', {
      repository_id: 'repo-b', task_id: 'task-b', mode: 'code', request_id: 'open-code-b', write_grant: grantB.write_grant
    });
    assert.equal(codeA.error, false, String(codeA.data));
    assert.equal(codeB.error, false, String(codeB.data));

    const secondGrantA = await issueWorkspaceGrant({ stateDir, taskId: 'task-a' });
    const secondWriter = await call(client, 'workspace_open', {
      repository_id: 'repo-a', task_id: 'task-a', mode: 'code', request_id: 'open-code-a-2', write_grant: secondGrantA.write_grant
    });
    assert.equal(secondWriter.error, true);
    assert.match(String(secondWriter.data), /already has an open coding workspace/i);

    const codeAToken = codeA.data.workspace_token as string;
    const codeBToken = codeB.data.workspace_token as string;
    const sourceA = await call(client, 'read', { workspace_token: codeAToken, path: 'src/clamp.js' });
    const sourceB = await call(client, 'read', { workspace_token: codeBToken, path: 'src/clamp.js' });
    assert.equal(sourceA.error, false);
    assert.equal(sourceB.error, false);

    const editArgsA = {
      workspace_token: codeAToken, path: 'src/clamp.js', old_text: 'max - 1', new_text: 'max',
      expected_sha256: sourceA.data.sha256, request_id: 'same-visible-request'
    };
    const editArgsB = {
      workspace_token: codeBToken, path: 'src/clamp.js', old_text: 'max - 1', new_text: 'max',
      expected_sha256: sourceB.data.sha256, request_id: 'same-visible-request'
    };
    const [editA, editB] = await Promise.all([call(client, 'edit', editArgsA), call(client, 'edit', editArgsB)]);
    assert.equal(editA.error, false, String(editA.data));
    assert.equal(editB.error, false, String(editB.data));
    assert.equal(editA.data.scope.repository_id, 'repo-a');
    assert.equal(editB.data.scope.repository_id, 'repo-b');

    const retryA = await call(client, 'edit', editArgsA);
    assert.equal(retryA.error, false, String(retryA.data));
    assert.equal(retryA.data.already_applied, true);
    const reuseA = await call(client, 'edit', { ...editArgsA, new_text: 'max + 1' });
    assert.equal(reuseA.error, true);
    assert.match(String(reuseA.data), /request_id.*different arguments/i);

    await setRegisteredTaskPhase({ stateDir, taskId: 'task-a', phase: 'review' });
    const staleCode = await call(client, 'read', { workspace_token: codeAToken, path: 'README.md' });
    const staleInspect = await call(client, 'read', { workspace_token: inspectAToken, path: 'README.md' });
    assert.equal(staleCode.error, true);
    assert.equal(staleInspect.error, true);
    assert.match(String(staleCode.data), /stale|authorization changed|phase/i);

    const reviewA = await call(client, 'workspace_open', { repository_id: 'repo-a', task_id: 'task-a', mode: 'review', request_id: 'open-review-a' });
    assert.equal(reviewA.error, false, String(reviewA.data));
    const reviewRead = await call(client, 'read', { workspace_token: reviewA.data.workspace_token, path: 'README.md' });
    assert.equal(reviewRead.error, false, String(reviewRead.data));
    const reviewEdit = await call(client, 'edit', {
      workspace_token: reviewA.data.workspace_token, path: 'src/clamp.js', old_text: 'max', new_text: 'max - 1',
      expected_sha256: editA.data.after_sha256, request_id: 'review-write'
    });
    assert.equal(reviewEdit.error, true);
    assert.match(String(reviewEdit.data), /does not grant write|write capability/i);

    await setRegisteredTaskPhase({ stateDir, taskId: 'task-a', phase: 'coding' });
    const oldCodeAfterResume = await call(client, 'read', { workspace_token: codeAToken, path: 'README.md' });
    const oldReviewAfterResume = await call(client, 'read', { workspace_token: reviewA.data.workspace_token, path: 'README.md' });
    assert.equal(oldCodeAfterResume.error, true, 'pre-review coding selection must remain stale after resume');
    assert.equal(oldReviewAfterResume.error, true, 'review selection must become stale after resume');
    const resumedGrant = await issueWorkspaceGrant({ stateDir, taskId: 'task-a' });
    const resumedCode = await call(client, 'workspace_open', {
      repository_id: 'repo-a', task_id: 'task-a', mode: 'code', request_id: 'open-code-a-resumed', write_grant: resumedGrant.write_grant
    });
    assert.equal(resumedCode.error, false, String(resumedCode.data));
    const resumedRead = await call(client, 'read', { workspace_token: resumedCode.data.workspace_token, path: 'README.md' });
    assert.equal(resumedRead.error, false, String(resumedRead.data));

    const stillB = await call(client, 'read', { workspace_token: codeBToken, path: 'README.md' });
    assert.equal(stillB.error, false, String(stillB.data));

    await revokeWorkspace({ stateDir, workspaceId: inspectB.data.selection.workspace_id });
    const revoked = await call(client, 'read', { workspace_token: inspectBToken, path: 'README.md' });
    assert.equal(revoked.error, true);
    assert.match(String(revoked.data), /closed or revoked/i);

    const closing = await call(client, 'workspace_open', { repository_id: 'repo-b', task_id: 'task-b', mode: 'inspect', request_id: 'open-closing-b' });
    assert.equal(closing.error, false, String(closing.data));
    const closed = await call(client, 'workspace_close', { workspace_token: closing.data.workspace_token, request_id: 'open-closing-b' });
    assert.equal(closed.error, false, String(closed.data));
    assert.equal(closed.data.status, 'closed');
    const closedRead = await call(client, 'read', { workspace_token: closing.data.workspace_token, path: 'README.md' });
    assert.equal(closedRead.error, true);
    assert.match(String(closedRead.data), /closed or revoked/i);
    const closeRetry = await call(client, 'workspace_close', { workspace_token: closing.data.workspace_token, request_id: 'open-closing-b' });
    assert.equal(closeRetry.error, false, String(closeRetry.data));
    assert.equal(closeRetry.data.already_applied, true);

    const expiring = await call(client, 'workspace_open', { repository_id: 'repo-b', task_id: 'task-b', mode: 'inspect', request_id: 'open-expiring-b' });
    assert.equal(expiring.error, false, String(expiring.data));
    const expiredToken = await expireWorkspaceToken(stateDir, expiring.data.workspace_token);
    const expired = await call(client, 'read', { workspace_token: expiredToken, path: 'README.md' });
    assert.equal(expired.error, true);
    assert.match(String(expired.data), /expired/i);

    const staleGrant = await issueWorkspaceGrant({ stateDir, taskId: 'task-b' });
    await setRepositoryEnabled({ stateDir, repositoryId: 'repo-b', enabled: false });
    await setRepositoryEnabled({ stateDir, repositoryId: 'repo-b', enabled: true });
    const staleGrantOpen = await call(client, 'workspace_open', {
      repository_id: 'repo-b', task_id: 'task-b', mode: 'code', request_id: 'open-with-stale-grant', write_grant: staleGrant.write_grant
    });
    assert.equal(staleGrantOpen.error, true);
    assert.match(String(staleGrantOpen.data), /write_grant.*current.*authorization|does not match/i);

    const secondService = await call(client, 'service_info');
    assert.equal(secondService.error, false, String(secondService.data));
    assert.equal(secondService.data.process_pid, pid, 'repository/workspace selection must not restart the service process');
  } finally {
    await client.close();
    await service.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('active-service migration is reversible only before multi-repository authority is used', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-migration-v2-')));
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const policyPath = await writePolicy(base, 'policy.json');
  try {
    await coordinatorBind({ stateDir, taskId: 'legacy-task', repo: root, policyPath });
    const migrated = await migrateActiveServiceToCatalog({ stateDir, repositoryId: 'legacy-repo', name: 'Legacy repository' });
    assert.equal(migrated.unchanged, false);
    let catalog = await readMultiRepoCatalog(stateDir);
    assert.equal(catalog.migration?.repository_id, 'legacy-repo');
    assert.ok(catalog.repositories['legacy-repo']);
    assert.ok(catalog.tasks['legacy-task']);

    const rolled = await rollbackActiveServiceCatalogMigration({ stateDir });
    assert.equal(rolled.rolled_back, true);
    catalog = await readMultiRepoCatalog(stateDir);
    assert.deepEqual(catalog.repositories, {});
    assert.deepEqual(catalog.tasks, {});
    const rolledStore = await StateStore.inspect(stateDir);
    assert.ok(rolledStore);
    assert.equal(await rolledStore.read('control/multirepo-initialized.json', 'multirepo-initialized'), undefined, 'pre-use rollback must restore the truly-uninitialized multi-repository marker state');

    await migrateActiveServiceToCatalog({ stateDir, repositoryId: 'legacy-repo' });
    await openWorkspace({ stateDir, repositoryId: 'legacy-repo', taskId: 'legacy-task', mode: 'inspect', requestId: 'migration-used' });
    await assert.rejects(rollbackActiveServiceCatalogMigration({ stateDir }), /refused after any grant, workspace selection or workspace request/i);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('active-service migration rollback rejects a changed legacy generation', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-migration-generation-')));
  const root = await fixture(base, 'repo');
  const stateDir = path.join(base, 'state');
  const policyPath = await writePolicy(base, 'policy.json');
  try {
    const before = await coordinatorBind({ stateDir, taskId: 'legacy-task', repo: root, policyPath, port: 8787 });
    const migrated = await migrateActiveServiceToCatalog({ stateDir, repositoryId: 'legacy-repo' });
    assert.equal(migrated.migration.active_generation, before.active.generation);

    const changed = await coordinatorBind({ stateDir, taskId: 'legacy-task', repo: root, policyPath, port: 8788 });
    assert.ok(changed.active.generation > migrated.migration.active_generation);
    await assert.rejects(
      rollbackActiveServiceCatalogMigration({ stateDir }),
      /legacy active-service state no longer matches the migrated generation\/catalog/i
    );
    assert.ok((await readMultiRepoCatalog(stateDir)).migration, 'failed rollback must leave the migration catalog intact');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('active-service migration refuses to overwrite an existing repository ID', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-migration-collision-')));
  const stateDir = path.join(base, 'state');
  const legacyRoot = await fixture(base, 'legacy-root');
  const existingRoot = await fixture(base, 'existing-root');
  const legacyPolicy = await writePolicy(base, 'legacy-policy.json');
  const existingPolicy = await writePolicy(base, 'existing-policy.json');
  try {
    await coordinatorBind({ stateDir, taskId: 'legacy-task', repo: legacyRoot, policyPath: legacyPolicy });
    const registered = await registerRepository({
      stateDir,
      repositoryId: 'legacy-repo',
      root: existingRoot,
      policyPath: existingPolicy
    });
    await assert.rejects(
      migrateActiveServiceToCatalog({ stateDir, repositoryId: 'legacy-repo' }),
      /repository id legacy-repo is already registered.*will not overwrite/i
    );
    const catalog = await readMultiRepoCatalog(stateDir);
    assert.equal(catalog.repositories['legacy-repo'].root, registered.repository.root);
    assert.equal(catalog.migration, undefined);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('catalog parsing fails closed on corrupt durable state', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-catalog-corrupt-')));
  const stateDir = path.join(base, 'state');
  try {
    const store = await StateStore.open(stateDir);
    await store.write('control/multirepo-catalog.json', 'multirepo-catalog', {
      schema_version: 1,
      revision: 1,
      service: { port: 8787, configured_at: 'not-a-date' },
      repositories: {},
      tasks: {}
    });
    await assert.rejects(readMultiRepoCatalog(stateDir), /corrupt multi-repository service configuration/i);

    const at = new Date().toISOString();
    await store.write('control/multirepo-catalog.json', 'multirepo-catalog', {
      schema_version: 1,
      revision: 2,
      service: { port: 8787, configured_at: at },
      repositories: {},
      tasks: {
        orphan: {
          task_id: 'orphan',
          repository_id: 'missing',
          binding_epoch: 1,
          phase_epoch: 1,
          phase: 'coding',
          allow_detached: false,
          completed: false,
          created_at: at,
          updated_at: at
        }
      }
    });
    await assert.rejects(
      readMultiRepoCatalog(stateDir),
      /unfinished task orphan references missing repository missing/i
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('workspace authorization fails closed on corrupt token-key state', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-token-corrupt-')));
  const stateDir = path.join(base, 'state');
  const root = await fixture(base, 'repo');
  const policyPath = await writePolicy(base, 'policy.json');
  try {
    await registerRepository({ stateDir, repositoryId: 'repo', root, policyPath });
    await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId: 'task' });
    const opened = await openWorkspace({ stateDir, repositoryId: 'repo', taskId: 'task', mode: 'inspect', requestId: 'open-before-key-corrupt' });
    const store = await StateStore.open(stateDir);
    await store.write('control/workspace-token-key.json', 'workspace-token-key', {
      key_id: 'k1', secret: 'not-a-valid-key', created_at: new Date().toISOString()
    });
    await assert.rejects(authorizeWorkspace(stateDir, opened.workspace_token, 'read'), /corrupt workspace token key/i);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('repository registration rejects policy sources inside another served checkout', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-cross-policy-')));
  const stateDir = path.join(base, 'state');
  const rootA = await fixture(base, 'repo-a');
  const rootB = await fixture(base, 'repo-b');
  const policyA = await writePolicy(base, 'a-policy.json');
  const policyInsideA = path.join(rootA, 'operator-policy.json');
  await writeFile(policyInsideA, JSON.stringify(migrateV1(defaultPolicy)));
  try {
    await registerRepository({ stateDir, repositoryId: 'repo-a', root: rootA, policyPath: policyA });
    await assert.rejects(
      registerRepository({ stateDir, repositoryId: 'repo-b', root: rootB, policyPath: policyInsideA }),
      /outside every served repository|inside registered repository/i
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
