import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { prepareFixture } from '../src/fixture.js';
import { defaultPolicy } from '../src/repo.js';
import { migrateV1 } from '../src/policy.js';
import {
  bindRegisteredTask,
  issueWorkspaceGrant,
  openWorkspace,
  readMultiRepoCatalog,
  registerRepository,
  rebindRegisteredTask,
  resolveRegisteredRepository,
  revokeWorkspace,
  setRegisteredTaskPhase,
  setRepositoryEnabled,
  finishRegisteredTask
} from '../src/multirepo-state.js';
import {
  completeTask,
  rebindTask,
  setTaskPhase,
  taskStatus
} from '../src/task.js';
import {
  chatGptRunStatus,
  markChatGptRunSubmitted,
  markChatGptRunUncertain,
  prepareChatGptRun,
  reserveChatGptRun,
  type ChatGptRunRecord,
  type TrustedChatGptRunReceipt
} from '../src/chatgpt-run.js';
import { recordTrustedBrowserObservation } from '../src/model-policy.js';
import { garbageCollect } from '../src/gc.js';
import { StateStore } from '../src/task-state.js';
import { PROJECT_BASE } from '../src/version.js';

const NOW = new Date('2026-10-14T02:00:00.000Z');
const OBSERVED = new Date('2026-10-14T02:00:03.000Z');
const SUBMITTED = new Date('2026-10-14T02:00:04.000Z');

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  phase: 'coding' | 'review' = 'review'
) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-review-lifecycle-')));
  const root = path.join(base, 'repo');
  const stateDir = path.join(base, 'state');
  const policyPath = path.join(base, 'policy.json');
  await prepareFixture(root);
  await writeFile(policyPath, JSON.stringify(migrateV1(defaultPolicy)));
  await registerRepository({ stateDir, repositoryId: 'repo', root, policyPath });
  await bindRegisteredTask({ stateDir, repositoryId: 'repo', taskId: 'task' });
  if (phase === 'review') await setRegisteredTaskPhase({ stateDir, taskId: 'task', phase: 'review' });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root, stateDir, policyPath };
}

async function legacyRun(
  stateDir: string,
  desired: 'submission-reserved' | 'submitted' | 'uncertain',
  label: string = desired
): Promise<ChatGptRunRecord> {
  const sessionId = `legacy-${label}`;
  const run = await prepareChatGptRun({
    stateDir,
    repositoryId: 'repo',
    taskId: 'task',
    coordinator: 'codex',
    workKind: 'review',
    profile: 'review',
    surface: 'chat',
    sessionId,
    prompt: `Legacy review ${label}.`,
    now: NOW
  });
  const evidence = await recordTrustedBrowserObservation({
    selectionId: run.selection.selection_id,
    surface: 'chat',
    controlLabel: 'Extra High',
    modelLabel: 'Sol',
    selectedAt: '2026-10-14T02:00:01.000Z',
    observedAt: '2026-10-14T02:00:02.000Z',
    sessionId
  }, { stateDir: path.join(stateDir, 'model-policy'), now: OBSERVED });
  let current: ChatGptRunRecord = await reserveChatGptRun({
    stateDir, runId: run.run_id, contract: run.selection, evidence, now: OBSERVED
  });
  if (desired === 'submission-reserved') return current;

  const receipt: TrustedChatGptRunReceipt = {
    repositoryId: current.repository_id,
    taskId: current.task_id,
    promptSha256: current.prompt_sha256,
    baseCommit: current.resolved_base_commit,
    browserEventId: `send-${label}`,
    observedAt: SUBMITTED.toISOString(),
    sessionId
  };
  current = await markChatGptRunSubmitted({
    stateDir, runId: current.run_id, receipt, now: SUBMITTED
  });
  if (desired === 'submitted') return current;
  return markChatGptRunUncertain(
    current.run_id, `UNCERTAIN_${label.toUpperCase()}`, stateDir,
    new Date('2026-10-14T02:00:05.000Z')
  );
}

async function expectProtected(promise: Promise<unknown>) {
  await assert.rejects(promise, /REVIEW_PROTECTED|protected|unresolved.*review|submitted.*run|active reviewer/i);
}

function runCoord(args: string[], stateDir?: string) {
  return spawnSync('npm', ['run', '--silent', 'coord', '--', ...args], {
    cwd: PROJECT_BASE,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...(stateDir ? { REPO_MCP_STATE_DIR: stateDir } : {}) }
  });
}

test('currently authorized legacy reserved/submitted/uncertain runs block direct task lifecycle primitives', async t => {
  for (const state of ['submission-reserved', 'submitted', 'uncertain'] as const) {
    for (const operation of ['phase', 'rebind', 'finish'] as const) {
      await t.test(`${state} blocks direct ${operation}`, async st => {
        const { stateDir, root } = await fixture(st, 'review');
        const run = await legacyRun(stateDir, state, `direct-${state}-${operation}`);
        const before = await taskStatus(stateDir, 'task', { readOnly: true });

        if (operation === 'phase') {
          await expectProtected(setTaskPhase(stateDir, 'task', 'coding'));
        } else if (operation === 'rebind') {
          await expectProtected(rebindTask(stateDir, 'task', root));
        } else {
          await expectProtected(completeTask(stateDir, 'task', { result: 'abandoned' }));
        }

        const after = await taskStatus(stateDir, 'task', { readOnly: true });
        assert.deepEqual(after, before, 'blocked lifecycle must not mutate task authority');
        assert.equal((await chatGptRunStatus(run.run_id, stateDir)).state, state);
      });
    }
  }
});

test('registered coordinator lifecycle wrappers delegate to the same legacy-run guard', async t => {
  for (const operation of ['phase', 'rebind', 'finish'] as const) {
    await t.test(operation, async st => {
      const { stateDir } = await fixture(st, 'review');
      const run = await legacyRun(stateDir, 'submission-reserved', `registered-${operation}`);
      const beforeCatalog = await readMultiRepoCatalog(stateDir);

      if (operation === 'phase') {
        await expectProtected(setRegisteredTaskPhase({ stateDir, taskId: 'task', phase: 'coding' }));
      } else if (operation === 'rebind') {
        await expectProtected(rebindRegisteredTask({ stateDir, taskId: 'task' }));
      } else {
        await expectProtected(finishRegisteredTask({ stateDir, taskId: 'task', result: 'abandoned' }));
      }

      assert.deepEqual(await readMultiRepoCatalog(stateDir), beforeCatalog);
      assert.equal((await chatGptRunStatus(run.run_id, stateDir)).state, 'submission-reserved');
    });
  }
});

test('active review workspace blocks normal cooperative phase/rebind/finish', async t => {
  for (const operation of ['phase', 'rebind', 'finish'] as const) {
    await t.test(operation, async st => {
      const { stateDir } = await fixture(st, 'review');
      const opened = await openWorkspace({
        stateDir, repositoryId: 'repo', taskId: 'task', mode: 'review',
        requestId: `active-review-${operation}`, ttlMs: 60_000
      });

      if (operation === 'phase') {
        await expectProtected(setRegisteredTaskPhase({ stateDir, taskId: 'task', phase: 'coding' }));
      } else if (operation === 'rebind') {
        await expectProtected(rebindRegisteredTask({ stateDir, taskId: 'task' }));
      } else {
        await expectProtected(finishRegisteredTask({ stateDir, taskId: 'task', result: 'abandoned' }));
      }

      const authorized = await import('../src/multirepo-state.js').then(module =>
        module.authorizeWorkspace(stateDir, opened.workspace_token, 'read')
      );
      assert.equal(authorized.selection.status, 'open');
    });
  }
});

test('legacy scripts/task phase and rebind cannot bypass the lowest-common guard', async t => {
  for (const operation of ['phase', 'rebind'] as const) {
    await t.test(operation, async st => {
      const { stateDir, root } = await fixture(st, 'review');
      const run = await legacyRun(stateDir, 'submitted', `script-${operation}`);
      const args = operation === 'phase'
        ? ['task', '--', 'phase', '--state-dir', stateDir, '--task', 'task', '--phase', 'coding']
        : ['task', '--', 'rebind', '--state-dir', stateDir, '--task', 'task', '--root', root];
      const result = spawnSync('npm', ['run', '--silent', ...args], {
        cwd: PROJECT_BASE, encoding: 'utf8', timeout: 30_000
      });
      assert.notEqual(result.status, 0, `legacy ${operation} unexpectedly bypassed unresolved run protection`);
      assert.match(result.stderr, /REVIEW_PROTECTED|protected|unresolved|submitted/i);
      assert.equal((await chatGptRunStatus(run.run_id, stateDir)).state, 'submitted');
    });
  }
});

test('security disable cuts current authority immediately while preserving unresolved legacy evidence', async t => {
  const { stateDir } = await fixture(t, 'review');
  const run = await legacyRun(stateDir, 'submitted', 'security-disable');
  const store = await StateStore.open(stateDir);
  const runRel = `chatgpt-runs/${run.run_id}.json`;
  const requestRel = `chatgpt-run-requests/${run.request_key}.json`;
  const beforeRun = await readFile(path.join(stateDir, runRel), 'utf8');
  const beforeRequest = await readFile(path.join(stateDir, requestRel), 'utf8');

  const disabled = await setRepositoryEnabled({ stateDir, repositoryId: 'repo', enabled: false });
  assert.equal(disabled.repository.enabled, false);
  assert.equal(await readFile(path.join(stateDir, runRel), 'utf8'), beforeRun);
  assert.equal(await readFile(path.join(stateDir, requestRel), 'utf8'), beforeRequest);
  assert.equal((await chatGptRunStatus(run.run_id, stateDir)).state, 'submitted');
  assert.ok(await store.read(requestRel, 'chatgpt-run-request-v1'));
});

test('historical revoked epochs remain evidence but do not permanently block newly authorized lifecycle', async t => {
  const { stateDir } = await fixture(t, 'review');
  const run = await legacyRun(stateDir, 'submitted', 'historical-epoch');
  const originalEpoch = run.registration_epoch;

  await setRepositoryEnabled({ stateDir, repositoryId: 'repo', enabled: false });
  await setRepositoryEnabled({ stateDir, repositoryId: 'repo', enabled: true });
  const current = await readMultiRepoCatalog(stateDir);
  assert.ok(current.repositories.repo.registration_epoch > originalEpoch);

  const changed = await setRegisteredTaskPhase({ stateDir, taskId: 'task', phase: 'coding' });
  assert.equal(changed.task.phase, 'coding');
  assert.equal((await chatGptRunStatus(run.run_id, stateDir)).state, 'submitted');
  const store = await StateStore.open(stateDir);
  assert.ok(await store.read(`chatgpt-run-requests/${run.request_key}.json`, 'chatgpt-run-request-v1'));
});

test('explicit workspace revocation is security invalidation and preserves same-task run/request evidence', async t => {
  const { stateDir } = await fixture(t, 'review');
  const run = await legacyRun(stateDir, 'uncertain', 'workspace-revoke');
  const opened = await openWorkspace({
    stateDir, repositoryId: 'repo', taskId: 'task', mode: 'review',
    requestId: 'legacy-revoke-workspace', ttlMs: 60_000
  });
  const store = await StateStore.open(stateDir);
  const beforeRun = await readFile(path.join(stateDir, 'chatgpt-runs', `${run.run_id}.json`), 'utf8');
  const beforeClaim = await readFile(path.join(stateDir, 'chatgpt-run-requests', `${run.request_key}.json`), 'utf8');

  const revoked = await revokeWorkspace({ stateDir, workspaceId: opened.selection.workspace_id });
  assert.equal(revoked.status, 'revoked');
  assert.equal(await readFile(path.join(stateDir, 'chatgpt-runs', `${run.run_id}.json`), 'utf8'), beforeRun);
  assert.equal(await readFile(path.join(stateDir, 'chatgpt-run-requests', `${run.request_key}.json`), 'utf8'), beforeClaim);
  const auth = await store.read<any>('control/multirepo-auth.json', 'multirepo-auth');
  assert.equal(auth.workspaces[opened.selection.workspace_id].status, 'revoked');
});

test('GC/TTL never invents completion or deletes uncertain legacy run/request recovery evidence', async t => {
  const { stateDir } = await fixture(t, 'review');
  const run = await legacyRun(stateDir, 'uncertain', 'gc-uncertain');
  const runFile = path.join(stateDir, 'chatgpt-runs', `${run.run_id}.json`);
  const claimFile = path.join(stateDir, 'chatgpt-run-requests', `${run.request_key}.json`);
  const beforeRun = await readFile(runFile, 'utf8');
  const beforeClaim = await readFile(claimFile, 'utf8');

  await garbageCollect({
    stateDir,
    apply: true,
    authRetentionHours: 1,
    captureRetentionHours: 0,
    taskRetentionDays: 1,
    nowMs: Date.parse('2035-01-01T00:00:00.000Z')
  });

  assert.equal(await readFile(runFile, 'utf8'), beforeRun);
  assert.equal(await readFile(claimFile, 'utf8'), beforeClaim);
  assert.equal((await taskStatus(stateDir, 'task', { readOnly: true })).completion, null);
  assert.equal((await chatGptRunStatus(run.run_id, stateDir)).state, 'uncertain');
});

test('coordinator help advertises the minimal shared-review commands without initializing state', async t => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-review-help-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const stateDir = path.join(base, 'absent-state');
  const result = runCoord(['--help'], stateDir);
  assert.equal(result.status, 0, result.stderr);
  for (const marker of [
    'review prepare-or-join', 'review reconcile', 'review status',
    'review close', 'review recover-participant', '--workspace-request-id'
  ]) {
    assert.ok(result.stdout.includes(marker), `coord help is missing ${marker}`);
  }
  await assert.rejects(lstat(stateDir), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
});

test('coordinator review prepare-or-join accepts a preallocated workspace request id before prompt hashing', async t => {
  const { base, stateDir } = await fixture(t, 'review');
  const prompt = path.join(base, 'shared-review.txt');
  const workspaceRequestId = 'review-open-preallocated-1';
  const finalPrompt = `Review this target. Workspace request: ${workspaceRequestId}\n`;
  await writeFile(prompt, finalPrompt);

  const result = runCoord([
    'review', 'prepare-or-join',
    '--state-dir', stateDir,
    '--repository', 'repo',
    '--coordinator', 'codex',
    '--profile', 'review',
    '--surface', 'chat',
    '--session-id', 'cli-shared-session',
    '--workspace-request-id', workspaceRequestId,
    '--prompt-file', prompt,
    '--base-ref', 'HEAD',
    '--scope-prefix', 'src/'
  ], stateDir);
  assert.equal(result.status, 0, result.stderr);
  const prepared = JSON.parse(result.stdout);
  assert.equal(prepared.participant.workspace_request_id, workspaceRequestId);
  assert.equal(prepared.run.prompt_sha256, (await import('../src/errors.js')).sha256(finalPrompt));
});

test('repository resolve exposes sanitized ownership provenance, ages, counts and conflict hints without secrets', async t => {
  const { stateDir, root } = await fixture(t, 'coding');
  const grant = await issueWorkspaceGrant({ stateDir, taskId: 'task' });
  const coding = await openWorkspace({
    stateDir, repositoryId: 'repo', taskId: 'task', mode: 'code',
    requestId: 'coding-owner-open', writeGrant: grant.write_grant
  });

  const resolved = await resolveRegisteredRepository(root, stateDir);
  assert.ok(resolved.repository);
  const task = resolved.repository!.tasks.find(item => item.task_id === 'task') as any;
  assert.equal(typeof task.updated_at, 'string');
  assert.equal(typeof task.age_seconds, 'number');
  assert.equal(typeof task.coding_owner?.status, 'string');
  assert.equal(typeof task.coding_owner?.provenance, 'string');
  assert.ok(task.coding_owner?.coordinator === null || ['codex', 'claude'].includes(task.coding_owner?.coordinator));
  for (const key of ['active', 'prepared', 'reserved', 'submitted', 'uncertain', 'stale']) {
    assert.equal(typeof task.participant_counts?.[key], 'number');
  }
  assert.ok(Array.isArray(task.conflict_hints));

  const serialized = JSON.stringify(resolved);
  assert.ok(!serialized.includes(coding.workspace_token));
  assert.ok(!serialized.includes(grant.write_grant));
  assert.ok(!serialized.includes('coding-owner-open'));
  assert.ok(!serialized.includes(root), 'resolve summary must not echo unrelated private checkout paths');
});

test('review reconcile CLI rejects arbitrary workspace IDs and does not mutate state', async t => {
  const { stateDir } = await fixture(t, 'review');
  const store = await StateStore.open(stateDir);
  const beforeCatalog = await readFile(path.join(stateDir, 'control/multirepo-catalog.json'), 'utf8');
  const result = runCoord([
    'review', 'reconcile',
    '--state-dir', stateDir,
    '--task', 'task',
    '--participant', 'participant-1',
    '--workspace', 'a'.repeat(32)
  ], stateDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /workspace.*not valid|does not accept.*workspace|arbitrary workspace/i);
  assert.equal(await readFile(path.join(stateDir, 'control/multirepo-catalog.json'), 'utf8'), beforeCatalog);
  assert.equal((await store.list('review-shares')).length, 0);
});
